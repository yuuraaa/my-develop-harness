import { issueState } from "./helpers/issue-state.js";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, jest } from "bun:test";
import { z } from "zod";
import type { ThreadEvent } from "@openai/codex-sdk";
import { runStructured } from "../src/codex.js";
import { codexDiagnosticSchema, diagnosticDetail, type DiagnosticDetail } from "../src/codex-diagnostics.js";
import { RunStore, StorageError, newRunId } from "../src/state.js";
import { setupDevelopment } from "./helpers/development.js";
import type { RunState } from "../src/schemas.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "codex-diagnostics-")); roots.push(root); return root; }
const schema = z.strictObject({ summary: z.string() });
const success: ThreadEvent[] = [
  { type: "item.completed", item: { type: "agent_message", id: "answer", text: '{"summary":"ok"}' } },
  { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } },
];

describe("Codex診断の取得・保存", () => {
  // 実Git・worktree・fsyncを伴う統合確認を含む。
  jest.setTimeout(15_000);
  it.each(["error", "turn.failed", "item.error", "mcp.error"] as const)("%sの具体的なメッセージを保存し、itemエラーだけでは停止しない", async source => {
    const root = await directory(), store = new RunStore(newRunId(), root, ["known-secret"]);
    // 状態Schemaに依存しない保存単体テスト用のrunディレクトリ。
    await mkdir(store.artifactsPath, { recursive: true });
    const message = 'endpoint failed known-secret token="unknown secret value"';
    const event: ThreadEvent = source === "error" ? { type: "error", message }
      : source === "turn.failed" ? { type: "turn.failed", error: { message } }
      : source === "item.error" ? { type: "item.completed", item: { type: "error", id: "warn", message } }
      : { type: "item.completed", item: { type: "mcp_tool_call", id: "mcp", server: "external", tool: "read_data", status: "failed", error: { message }, arguments: { ignored: "do-not-store" } } };
    const observed: DiagnosticDetail[] = [];
    const thread = { id: "thread-diagnostic", runStreamed: async () => ({ events: (async function* () { yield event; yield* success; })() }) };
    const result = runStructured(thread, "", schema, async observation => {
      if (!observation.diagnostic) return;
      observed.push(observation.diagnostic);
      await store.saveCodexDiagnostic({ ...observation.diagnostic, runId: store.runId, phase: "report", attempt: 1,
        retryCount: 0, operation: "codex.report.1", threadId: thread.id, timestamp: new Date().toISOString() });
    });
    if (source === "error" || source === "turn.failed") await expect(result).rejects.toThrow("execution");
    else expect((await result).output).toEqual({ summary: "ok" });
    expect(observed).toHaveLength(1);
    const name = (await readdir(store.artifactsPath))[0]!;
    const content = await readFile(join(store.artifactsPath, name), "utf8");
    expect(content).toContain("endpoint failed"); expect(content).not.toMatch(/known-secret|unknown secret value|do-not-store/);
    expect(codexDiagnosticSchema.parse(JSON.parse(content))).toMatchObject({ source, phase: "report", threadId: thread.id });
    expect((await store.loadEvents())[0]?.data).toMatchObject({ artifact: name, operation: "codex.report.1" });
  });

  it.each([false, true])("ストリーム例外のcode・causeを保持し、開始後=%sの再試行判定を維持する", async started => {
    const cause = Object.assign(new Error("root failure"), { code: "ECONNRESET", ignored: "do-not-store" });
    const failure = Object.assign(new Error("stream failed", { cause }), { code: "EAGAIN", errno: -11, syscall: "spawn", exitCode: 7, signal: "SIGTERM", env: { token: "do-not-store" } });
    const observations: DiagnosticDetail[] = [];
    const thread = { id: started ? "started-thread" : null, runStreamed: async () => ({ events: (async function* (): AsyncGenerator<ThreadEvent> {
      if (started) yield { type: "thread.started", thread_id: "started-thread" };
      throw failure;
    })() }) };
    await expect(runStructured(thread, "", schema, event => { if (event.diagnostic) observations.push(event.diagnostic); }))
      .rejects.toMatchObject({ safeToRetry: !started });
    expect(observations).toEqual([{ source: "exception", omitted: false, details: [
      { name: "Error", message: "stream failed", code: "EAGAIN", errno: -11, syscall: "spawn", exitCode: 7, signal: "SIGTERM" },
      { name: "Error", message: "root failure", code: "ECONNRESET" },
    ] }]);
  });

  it("開始前のspawn例外も元の具体情報を保存し、安全停止の案内を保つ", async () => {
    const f = await setupDevelopment(await directory());
    f.behavior.beforeStream = async () => { throw Object.assign(new Error("spawn external CLI failed"), { code: "ENOENT", syscall: "spawn" }); };
    expect(await f.run()).toBe("stopped");
    const events = (await f.store.loadEvents()).filter(e => e.type === "codex.diagnostic");
    expect(events).toHaveLength(1);
    const data = codexDiagnosticSchema.parse(JSON.parse(await readFile(join(f.store.artifactsPath, String(events[0]!.data.artifact)), "utf8")));
    expect(data).toMatchObject({ phase: "plan", attempt: 1, retryCount: 0, operation: "codex.plan.1", threadId: null,
      details: [{ message: "spawn external CLI failed", code: "ENOENT", syscall: "spawn" }] });
    expect((await f.store.loadGitHubState()).error?.message).toContain("外部CLIを起動できません");
    expect(f.phasesCalled).toEqual(["plan"]);
  });

  it("同じ操作の再試行を別成果物として保持する", async () => {
    const f = await setupDevelopment(await directory()); let attempts = 0;
    f.behavior.beforeStream = async () => { if (++attempts <= 2) throw Object.assign(new Error("temporary unavailable"), { code: "EAGAIN" }); };
    const output = f.behavior.output;
    f.behavior.output = phase => phase === "plan" ? { ...(output(phase) as object), blockers: ["診断確認終了"] } : output(phase);
    expect(await f.run()).toBe("blocked");
    const events = (await f.store.loadEvents()).filter(e => e.type === "codex.diagnostic");
    expect(events.map(e => e.data.retryCount)).toEqual([0, 1]);
    expect(new Set(events.map(e => e.data.artifact)).size).toBe(2);
    expect((await f.store.loadGitHubState()).retryCount).toEqual({ "codex.plan.1": 2 });
    expect(await f.store.stoppedCodexMessage(await f.store.loadGitHubState())).toBeUndefined();
  });

  it("再試行上限で停止した最後の診断だけを表示に使う", async () => {
    const f = await setupDevelopment(await directory()); let attempts = 0;
    f.behavior.beforeStream = async () => { throw Object.assign(new Error(`temporary failure ${++attempts}`), { code: "EAGAIN" }); };
    expect(await f.run()).toBe("stopped");
    expect(attempts).toBe(3);
    expect(await f.store.stoppedCodexMessage(await f.store.loadGitHubState())).toBe("temporary failure 3\ncode: EAGAIN");
  });


  it("診断保存失敗でSDKを再実行せず停止する", async () => {
    const f = await setupDevelopment(await directory());
    f.behavior.beforeStream = async () => { throw Object.assign(new Error("temporary failure"), { code: "EAGAIN" }); };
    const spy = jest.spyOn(f.store, "saveCodexDiagnostic").mockRejectedValue(new StorageError("io"));
    try {
      expect(await f.run()).toBe("stopped");
      expect(f.phasesCalled).toEqual(["plan"]);
      expect((await f.store.loadGitHubState()).error?.message).toBe("実行記録: io");
    } finally { spy.mockRestore(); }
  });

  it("例外のcause・code内の秘密と引用符付き秘密を保存前に除外する", async () => {
    const root = await directory(), store = new RunStore(newRunId(), root, ["cause-secret"]);
    await mkdir(store.artifactsPath, { recursive: true });
    const error = Object.assign(new Error('failed password="space separated secret"'), { code: "cause-secret",
      cause: new Error("Bearer unknown-bearer-secret\n-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----") });
    const name = await store.saveCodexDiagnostic({ ...diagnosticDetail("exception", error), runId: store.runId,
      phase: "report", attempt: 1, retryCount: 0, operation: "codex.report.1", threadId: null, timestamp: new Date().toISOString() });
    const content = await readFile(join(store.artifactsPath, name), "utf8");
    expect(content).not.toMatch(/cause-secret|space separated secret|unknown-bearer-secret|private-key-material/);
    expect(JSON.parse(content).details).toHaveLength(2);
    expect(content).toContain("failed password=");
  });

  it("循環cause・巨大出力を制限し、切断前に秘密鍵と既知値を除外する", async () => {
    const root = await directory(), store = new RunStore(newRunId(), root, ["boundary-secret"]);
    await mkdir(store.artifactsPath, { recursive: true });
    const error = new Error("x".repeat(65530) + "boundary-secret" + "-----BEGIN PRIVATE KEY-----\nprivate material");
    error.cause = error;
    const detail = diagnosticDetail("exception", error);
    expect(detail.omitted).toBe(true); expect(detail.details).toHaveLength(1);
    const name = await store.saveCodexDiagnostic({ ...detail, runId: store.runId, phase: "plan", attempt: 1, retryCount: 0,
      operation: "codex.plan.1", threadId: null, timestamp: new Date().toISOString() });
    const raw = await readFile(join(store.artifactsPath, name), "utf8"), saved = JSON.parse(raw);
    expect(saved.omitted).toBe(true); expect(saved.details[0].message.length).toBeLessThanOrEqual(65536);
    expect(raw).not.toMatch(/boundary|private material/);
    const deep = new Error("end"); let current = deep;
    for (let i = 0; i < 10; i++) { current.cause = new Error("cause"); current = current.cause as Error; }
    expect(diagnosticDetail("exception", deep)).toMatchObject({ omitted: true, details: expect.arrayContaining([{ name: "Error", message: "end" }]) });
    expect(diagnosticDetail("exception", deep).details).toHaveLength(5);
  });
});

describe("停止診断の表示対象と上限", () => {
  async function fixture() {
    const store = new RunStore(newRunId(), await directory(), ["known-secret"]);
    const state: RunState = issueState({ schemaVersion: 2, runId: store.runId, issueId: "132", repositoryId: "owner/repo",
      repositoryPath: "/repo", branchName: "fix/test", worktreePath: store.worktreePath, baseCommit: "a".repeat(40),
      phase: "plan", phaseStatus: "failed", status: "stopped", fixCount: 0, retryCount: { "codex.plan.2": 1 },
      verificationArtifact: null, codexThreadId: null, reviewThreadIds: [], resultCommits: [], reviewedTreeId: null,
      error: { classification: "fatal", message: "Codex SDK: execution", operation: "codex.plan.2" }, updatedAt: new Date().toISOString() });
    await store.createGitHub(state);
    const start = () => store.appendEvent({ timestamp: new Date().toISOString(), type: "operation.started", phase: "plan", data: { operation: "codex.plan.2", retryCount: 1 } });
    const save = (source: DiagnosticDetail["source"], message: string, overrides = {}) => store.saveCodexDiagnostic({
      source, details: [{ message }], omitted: false, runId: store.runId, phase: "plan", attempt: 2, retryCount: 1,
      operation: "codex.plan.2", threadId: null, timestamp: new Date().toISOString(), ...overrides });
    return { store, state, start, save };
  }
  it("別操作・以前の試行・回復済みツール診断を停止原因にしない", async () => {
    const f = await fixture();
    await f.save("exception", "old invocation");
    await f.start();
    await f.save("exception", "old retry", { retryCount: 0 });
    await f.save("error", "old plan", { operation: "codex.plan.1", attempt: 1 });
    await f.save("item.error", "recovered item"); await f.save("mcp.error", "recovered mcp");
    expect(await f.store.stoppedCodexMessage(f.state)).toBeUndefined();
    await f.save("turn.failed", "terminal failure");
    await f.save("mcp.error", "unrelated tool");
    expect(await f.store.stoppedCodexMessage(f.state)).toBe("terminal failure");
  });
  it("成功済み操作の診断を後続の停止に使わない", async () => {
    const f = await fixture(); await f.start(); await f.save("exception", "previous error");
    await f.store.appendEvent({ timestamp: new Date().toISOString(), type: "operation.succeeded", phase: "plan", data: { operation: "codex.plan.2" } });
    expect(await f.store.stoppedCodexMessage(f.state)).toBeUndefined();
  });
  it.each(["plan", "implementation", "fix", "review", "commit", "report"] as const)("%sの停止した操作とフェーズを照合する", async phase => {
    const f = await fixture(), operation = `codex.${phase}.2`;
    const state = { ...f.state, phase, retryCount: {}, error: { classification: "fatal" as const, message: "Codex SDK: execution", operation } };
    await f.store.appendEvent({ timestamp: new Date().toISOString(), type: "operation.started", phase, data: { operation, retryCount: 0 } });
    await f.save("exception", `${phase} failed`, { phase, operation, retryCount: 0 });
    expect(await f.store.stoppedCodexMessage(state)).toBe(`${phase} failed`);
    expect(await f.store.stoppedCodexMessage({ ...state, phase: "verification" })).toBeUndefined();
  });
  it("接続準備例外を表示し、フェーズ開始後に古い接続準備診断を使わない", async () => {
    const f = await fixture();
    const state = { ...f.state, retryCount: {}, error: { classification: "fatal" as const, message: "Codex SDK: configuration", operation: "workflow.develop" } };
    await f.store.appendEvent({ timestamp: new Date().toISOString(), type: "operation.started", phase: "plan", data: { operation: "workflow.develop", retryCount: 0 } });
    await f.save("exception", "configuration failure", { operation: "codex.configure", attempt: 1, retryCount: 0 });
    expect(await f.store.stoppedCodexMessage(state)).toBe("configuration failure");
    await f.start();
    expect(await f.store.stoppedCodexMessage(state)).toBeUndefined();
  });
  it.each(["runId", "attempt", "threadId", "source"])("診断本体の%sがイベントと異なる場合は表示しない", async key => {
    const f = await fixture(); await f.start(); const name = await f.save("exception", "mismatched");
    const path = join(f.store.artifactsPath, name), diagnostic = JSON.parse(await readFile(path, "utf8"));
    diagnostic[key] = { runId: newRunId(), attempt: 1, threadId: "other-thread", source: "item.error" }[key];
    await writeFile(path, JSON.stringify(diagnostic));
    expect(await f.store.stoppedCodexMessage(f.state)).toBeUndefined();
  });
  it("読み取り時にも秘密値を除外し、制御文字を除去して表示全体を上限内にする", async () => {
    const f = await fixture(); await f.start(); const name = await f.save("exception", "placeholder");
    const path = join(f.store.artifactsPath, name), diagnostic = JSON.parse(await readFile(path, "utf8"));
    diagnostic.details = [{ message: 'known-secret token="unknown secret"\n\x1b[2K' + "x".repeat(70000) }, { message: "cause".repeat(20000) }];
    await writeFile(path, JSON.stringify(diagnostic));
    const message = await f.store.stoppedCodexMessage(f.state);
    expect(message).toContain("[REDACTED]"); expect(message).not.toMatch(/known-secret|unknown secret|\x1b/);
    expect(message).toContain("一部省略"); expect(message!.length).toBeLessThan(65700);
  });
});
