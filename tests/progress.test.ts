import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, jest } from "bun:test";
import { RunProgress } from "../src/progress.js";
import { RunStore, newRunId, redact } from "../src/state.js";
import type { RunEvent } from "../src/schemas.js";

const roots: string[] = [];
afterEach(async () => { jest.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(options: { enabled?: boolean; isTTY?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "progress-")); roots.push(root);
  const store = new RunStore(newRunId(), root, ["private-value"]);
  // 保存通知自体を通すため、記録ディレクトリだけ用意する。
  await mkdir(store.runPath, { recursive: true });
  let output = "", time = 0;
  jest.useFakeTimers();
  const progress = new RunProgress(store, "86", text => { output += redact(text, ["private-value"]); }, { ...options, now: () => time });
  const event = (type: string, data: RunEvent["data"] = {}, phase: RunEvent["phase"] = "implementation") =>
    store.appendEvent({ timestamp: new Date().toISOString(), type, phase, data });
  return { store, progress, event, output: () => output, advance: (ms: number) => { time += ms; jest.advanceTimersByTime(ms); } };
}

it("定期経過表示とCodexコマンド通知を省き、非TTYでは開始・完了を改行で追記する", async () => {
  const f = await setup();
  try {
    await f.event("phase.running");
    f.advance(30_000);
    const before = f.output();
    await f.event("codex.unresponsive_warning");
    f.advance(30_000);
    await f.event("codex.event", { type: "item.started", itemType: "command_execution" });
    f.advance(30_000);
    await f.event("codex.event", { type: "item.completed", itemType: "command_execution" });
    expect(f.output()).toBe(before);
    await f.event("phase.succeeded");
    expect(f.output()).toMatch(/実装 +：処理中\.\.\.\n/);
    expect(f.output()).toMatch(/実装 +：完了（1分30秒）\n/);
    expect(f.output()).not.toMatch(/[\r\x1b]/);
    f.progress.finish("completed");
    const final = f.output(); f.advance(120_000);
    await f.event("phase.running");
    expect(f.output()).toBe(final);
    expect(jest.getTimerCount()).toBe(0);
  } finally { f.progress.close(); }
});

it("検証コマンドごとのイベントで工程の時計をリセットしない", async () => {
  const f = await setup();
  try {
    await f.event("phase.running", { attempt: 1 }, "verification");
    f.advance(20_000);
    const command = { attempt: 1, commandIndex: 0, commandTotal: 2, commandId: "check", commandKind: "typecheck" };
    await f.event("phase.running", { ...command, commandStatus: "started" }, "verification");
    f.advance(20_000);
    await f.event("phase.running", { ...command, commandStatus: "failed" }, "verification");
    await f.event("phase.running", { ...command, commandIndex: 1, commandStatus: "skipped" }, "verification");
    await f.event("phase.succeeded", { attempt: 1 }, "verification");
    expect(f.output()).toMatch(/検証 +：完了（40秒）/);
    expect(f.output().match(/検証 +：処理中/g)).toHaveLength(1);
    expect(f.output()).toContain("検証 1/2：型チェック (check)：失敗");
    expect(f.output()).toContain("検証 2/2：型チェック (check)：未実施");
  } finally { f.progress.close(); }
});

it.each(["stopped", "blocked"] as const)("%sの停止イベントで定期表示を直ちに止め、理由と記録場所を表示する", async status => {
  const f = await setup();
  await f.event("phase.running");
  await f.event("workflow.stopped", { status, message: "private-value" });
  const before = f.output(); f.advance(60_000);
  expect(f.output()).toBe(before); expect(jest.getTimerCount()).toBe(0);
  f.progress.finish(status, "権限不足 private-value");
  expect(f.output()).toContain(`停止状態: ${status}／理由: 権限不足 [REDACTED]`);
  expect(f.output()).toContain(`記録: ${f.store.runPath}`);
  expect(f.output()).not.toContain("review提出完了");
});

it("保存と同じマスキングを適用し、生のコマンド・出力・説明を表示せず、通知失敗でも記録を壊さない", async () => {
  const f = await setup();
  try {
    const observed: RunEvent[] = [];
    const off = f.store.observeEvents(event => { observed.push(event); event.type = "変更"; throw new Error(); });
    await f.event("phase.running");
    await f.event("codex.event", { type: "item.completed", itemType: "file_change", command: "private-value", stdout: "生出力", text: "説明全文" });
    await f.event("phase.running", { commandIndex: 0, commandTotal: 1, commandId: "private-value", commandKind: "test", commandStatus: "started" }, "verification");
    expect(f.output()).toContain("ファイル変更を観測");
    expect(f.output()).toContain("テスト ([REDACTED])：開始");
    for (const hidden of ["private-value", "生出力", "説明全文"]) expect(f.output()).not.toContain(hidden);
    expect((await f.store.loadEvents()).map(e => e.type)).toEqual(["phase.running", "codex.event", "phase.running"]);
    expect(observed[1]!.data.command).toBe("[REDACTED]");
    off();
    await writeFile(join(f.store.runPath, "events.jsonl"), "{");
    const before = f.output();
    await expect(f.event("phase.running", {}, "review")).rejects.toThrow();
    expect(f.output()).toBe(before); // 未保存のイベントを進捗として表示しない。
  } finally { f.progress.close(); }
});

it("出力先が例外を投げてもイベントを保存でき、終了時にタイマーを解放する", async () => {
  const f = await setup(); f.progress.close();
  const progress = new RunProgress(f.store, "86", () => { throw new Error("表示失敗"); });
  await f.event("phase.running");
  expect(await f.store.loadEvents()).toHaveLength(1);
  progress.finish("stopped");
  expect(jest.getTimerCount()).toBe(0);
});

// 内部生成の消去命令を解釈し、端末に最後に残る各行を検査する。
function screen(output: string) {
  const lines = [""];
  for (const part of output.split(/(\r\x1b\[2K|\n)/)) {
    if (part === "\r\x1b[2K") lines[lines.length - 1] = "";
    else if (part === "\n") lines.push("");
    else lines[lines.length - 1] += part;
  }
  return lines.join("\n");
}

it.each(["passed", "fix"])("TTYでレビューを同じ行の完了・判定に更新する: %s", async decision => {
  const f = await setup({ isTTY: true });
  await f.event("phase.running", { attempt: 2 }, "review");
  expect(f.output()).not.toEndWith("\n");
  await f.event("operation.retry", { operation: "codex.review", retryCount: 1 }, "review");
  await f.event("codex.event", { attempt: 2, type: "item.started", itemType: "mcp_tool_call" }, "review");
  await f.event("phase.succeeded", { attempt: 2 }, "review");
  await f.event("review.assessed", { attempt: 2, decision }, "review");
  f.progress.finish("completed");
  const visible = screen(f.output());
  expect(f.output()).toContain("\r\x1b[2K");
  expect(visible).toContain("再試行：codex.review 1/2");
  expect(visible).toContain("資料参照中");
  expect(visible).toMatch(new RegExp(`レビュー 2回目 +：完了（${decision === "passed" ? "合格" : "要修正"}、0秒）`));
  expect(visible).not.toContain("処理中");
  expect(visible).toEndWith(`記録: ${f.store.runPath}\n`);
});

it.each(["event", "finish", "close"])("TTYの途中停止を完了扱いせず行を確定する: %s", async method => {
  const f = await setup({ isTTY: true });
  await f.event("phase.running", {}, "plan");
  if (method === "event") await f.event("workflow.stopped");
  if (method === "close") f.progress.close();
  else f.progress.finish("stopped", "権限不足");
  const visible = screen(f.output());
  expect(visible).not.toContain("処理中");
  expect(visible).not.toContain("完了");
  expect(visible).toMatch(/計画作成 +：(停止|中断)\n/);
  expect(f.output()).toEndWith("\n");
});

it("日本語・ASCII混在の工程ラベルの状態欄を表示幅で揃える", async () => {
  const f = await setup();
  for (const phase of ["prepare", "start", "plan", "implementation", "verification", "review", "fix", "commit", "report"] as const) {
    await f.event("phase.running", { attempt: 1 }, phase);
  }
  f.progress.close();
  const columns = f.output().split("\n").filter(line => line.includes("：処理中")).map(line => {
    const label = line.split("：")[0]!;
    // テスト側はUTF-8 byte長から既知の日本語3byte/2桁の差を引いて数える。
    const japanese = (label.match(/[\u3000-\u9fff]/g) ?? []).length;
    return Buffer.byteLength(label) - japanese;
  });
  expect(columns).toHaveLength(9);
  expect(new Set(columns).size).toBe(1);
});

it("TTYの正式な検証通知を確定し、外部制御文字を除去して完了行へ更新する", async () => {
  const f = await setup({ isTTY: true });
  await f.event("phase.running", {}, "verification");
  for (const commandStatus of ["started", "passed", "failed", "skipped"]) {
    await f.event("phase.running", { commandIndex: 0, commandTotal: 1, commandId: "private-value\r\n\x1b[2J", commandKind: "test", commandStatus }, "verification");
  }
  await f.event("phase.succeeded", {}, "verification");
  f.progress.finish("completed");
  const visible = screen(f.output());
  for (const status of ["開始", "成功", "失敗", "未実施"]) expect(visible).toContain(`：${status}`);
  expect(visible).not.toContain("処理中");
  expect(visible).not.toContain("private-value");
  expect(visible).not.toMatch(/[\r\x1b]/);
  expect(visible).toMatch(/検証 +：完了（0秒）/);
});

it("進捗無効でもイベントを保存し、最終結果・理由・記録先を残す", async () => {
  const f = await setup({ enabled: false, isTTY: true });
  await f.event("phase.running");
  await f.event("codex.unresponsive_warning");
  expect(f.output()).toBe("");
  expect(await f.store.loadEvents()).toHaveLength(2);
  f.progress.finish("blocked", "private-value\n\x1b[2K権限不足");
  expect(f.output()).toContain("停止状態: blocked／理由: [REDACTED]");
  expect(f.output()).toContain(`記録: ${f.store.runPath}`);
  expect(f.output()).not.toMatch(/[\r\x1b]/);
});
