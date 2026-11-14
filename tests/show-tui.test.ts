import { loadGitHubConfig } from "../src/github-config.js";
import { afterEach, describe, expect, it, jest } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { createShowFixture, showRunId } from "./helpers/show-fixture.js";
import { loadShowModel } from "../src/show-model.js";
import { initialShowState, moveShow, renderShow, showAction, wrapShowText, displayWidth, runShowTui } from "../src/show-tui.js";
import { loadShowSettings, resolveShowSettings, showSettingsSchema } from "../src/show-settings.js";
import { executeCli } from "../src/cli.js";
import { GitHubClient } from "../src/github.js";

const roots: string[] = [];
afterEach(async () => { jest.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const home = await mkdtemp(join(tmpdir(), "show-tui-")); roots.push(home); return createShowFixture(home); }
const plain = (s: string) => s.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, "");

describe("工程一覧と全文詳細", () => {
  it("工程処理成功と失敗検証・レビュー判定を分け、全文と未知項目・ログを保持する", async () => {
    const f = await fixture(), model = await loadShowModel(f.root, showRunId);
    expect(model.phases.map(p => p.name)).toEqual(["prepare:1", "start:1", "plan:1", "implementation:1", "verification:1", "review:1", "fix:1", "verification:2", "review:2", "commit:1", "report:1"]);
    expect(model.phases[4]).toMatchObject({ result: "succeeded", duration: "1.0秒", assessment: "成功5/失敗3/未実施0" });
    expect(model.phases[5]?.assessment).toBe("fix / 指摘2 major 2");
    expect(model.phases[8]?.assessment).toBe("passed / 指摘0 major 0");
    expect(model.phases[3]?.detail).toContain(f.summary);
    expect(model.phases[3]?.detail).toContain("未知項目末尾");
    expect(model.phases[5]?.detail).toContain("エージェント出力 · 指摘 2/2 · major");
    expect(model.phases[4]?.detail).toContain("保存ログ全文\nログ末尾");
    expect(model.phases[4]?.detail).toContain("保存上限");
    expect(model.phases[4]?.detail).toContain("マスキングは復元できません");
    expect(model.phases[2]?.assessment).toContain("採用");
    expect(model.phases[10]?.detail).toContain("報告全文末尾");
  });
  it("通常表示の40工程・24000文字・3指摘制限をTUIへ適用しない", async () => {
    const f = await fixture();
    await f.save("review-1.json", { findings: Array.from({ length: 8 }, (_, i) => ({ severity: "major", description: `${i}:` + "本文".repeat(15000) + "最後まで" })) });
    for (let i = 3; i < 65; i++) await f.save(`review-${i}.json`, { summary: `追加工程${i}` });
    const m = await loadShowModel(f.root, showRunId);
    expect(m.phases.length).toBe(73);
    expect(m.phases.find(p => p.name === "review:64")?.detail).toContain("追加工程64");
    expect(m.phases[5]?.detail).toContain("指摘 8/8");
    expect(m.phases[5]?.detail).toContain("7:" + "本文".repeat(15000) + "最後まで");
    const state = initialShowState(); moveShow(state, "up", m.phases.length);
    const screen = plain(renderShow(m, state, 100, 24));
    // イベントなし成果物の順序はreaddir由来。回数順を新たに仮定しない。
    expect(state.selected).toBe(m.phases.length - 1);
    expect(screen).toContain(`▶ ${m.phases.at(-1)!.name}`);
    expect(state.listOffset).toBeGreaterThan(0);
  });
  it("先頭の上移動と末尾の下移動で循環し、詳細移動は選択を変えない", async () => {
    const f = await fixture(), m = await loadShowModel(f.root, showRunId), state = initialShowState();
    expect(state).toMatchObject({ selected: 0, focus: "list" });
    moveShow(state, "up", m.phases.length);
    expect(state.selected).toBe(10); expect(plain(renderShow(m, state, 100, 24))).toContain("▶ report:1");
    state.offset = 5;
    moveShow(state, "down", 11);
    expect(state).toMatchObject({ selected: 0, offset: 0 });
    const first = plain(renderShow(m, state, 100, 24));
    expect(first).toContain("▶ prepare:1"); expect(first).toContain("prepare:1 詳細");
    expect(state.listOffset).toBe(0);
    state.selected = 3; moveShow(state, "toggle", 11); moveShow(state, "down", 11);
    expect(state).toMatchObject({ selected: 3, focus: "detail", offset: 1 });
    const screen = plain(renderShow(m, state, 100, 24));
    expect(screen).toContain("一覧"); expect(screen).toContain("行2-");
    moveShow(state, "toggle", 11); expect(state.focus).toBe("list");
    expect(moveShow(state, "quit", 11)).toBe(true);
    moveShow(state, "toggle", 11); expect(moveShow(state, "quit", 11)).toBe(true);
    state.offset = 999999; renderShow(m, state, 100, 24); expect(state.offset).toBeLessThan(999999);
    expect(plain(renderShow(m, state, 10, 5))).toContain("端末");
  });
  it("端末サイズ変更後も選択行・本文・表示位置を画面内に維持する", async () => {
    const f = await fixture(), m = await loadShowModel(f.root, showRunId), state = initialShowState();
    moveShow(state, "up", m.phases.length);
    for (const [columns, rows] of [[40, 16], [100, 40], [60, 20]]) {
      const screen = plain(renderShow(m, state, columns!, rows!));
      expect(screen).toContain("▶ report:1");
      expect(screen.split("\r\n").length).toBeLessThanOrEqual(rows!);
      expect(screen.split("\r\n").every(row => displayWidth(row) <= columns! - 1)).toBe(true);
    }
    state.selected = 3; state.focus = "detail"; state.offset = 40;
    for (const columns of [100, 40, 80]) {
      const screen = plain(renderShow(m, state, columns, 24));
      expect(screen).toContain("行41-"); expect(screen).toContain("一覧");
      expect(screen.split("\r\n").every(row => displayWidth(row) <= columns - 1)).toBe(true);
    }
  });
  it("日本語・結合文字・絵文字を表示セル幅で折り返し、リサイズ後も本文へ到達する", () => {
    const value = "日本語e\u0301👩‍💻".repeat(30);
    const lines = wrapShowText(value, 9);
    expect(lines.join("")).toBe(value);
    expect(lines.every(line => displayWidth(line) <= 9)).toBe(true);
    expect(wrapShowText("a\nb\t終", 20)).toEqual(["a", "b    終"]);
  });
  it("色のANSIは枠線のみに適用し、選択行の文字・背景を変えない", async () => {
    const f = await fixture(), m = await loadShowModel(f.root, showRunId);
    const screen = renderShow(m, initialShowState(), 100, 30, { colors: { border: "#123456", activeBorder: "#abcdef" } });
    expect(screen).toContain("\x1b[38;2;18;52;86m"); expect(screen).toContain("\x1b[38;2;171;205;239m");
    const painted = [...screen.matchAll(/\x1b\[38;2;[\d;]+m(.*?)\x1b\[39m/g)];
    expect(painted.length).toBeGreaterThan(0);
    expect(painted.every(match => /^[┌┐└┘─│]+$/.test(match[1]!))).toBe(true);
    expect(screen).not.toMatch(/\x1b\[(?:48|4[0-7]|3[0-7]|1|7)[;m]/);
    expect(plain(screen)).toContain("▶ prepare:1");
  });
  it("部分記録・欠落・部分検証・不正statusを成功0件へ補完せず、秘密と端末制御文字を除外する", async () => {
    const f = await fixture();
    await rm(join(f.artifacts, "verification-1.json"));
    await f.save("verification-1.command-0.json", { status: "unknown", stdout: { text: "secret-value\x1b[31m" } });
    await f.save("implementation-1.json", { summary: "secret-value\x1b[2J" });
    await writeFile(join(f.artifacts, "review-1.json"), "broken");
    const m = await loadShowModel(f.root, showRunId, ["secret-value"]);
    expect(m.phases[4]?.assessment).toContain("部分記録");
    expect(m.phases[4]?.detail).toContain("総件数不明");
    expect(m.phases[3]?.detail).not.toContain("secret-value");
    expect(m.phases[3]?.detail).not.toContain("\x1b");
    expect(m.phases[5]?.assessment).toContain("指摘件数不明");
    expect(m.phases[5]?.detail).toContain("JSON破損");
    await rm(join(f.artifacts, "implementation-1.json"));
    await symlink(join(f.home, "outside"), join(f.artifacts, "implementation-1.json"));
    await writeFile(join(f.home, "outside"), '{"summary":"must-not-read"}');
    expect((await loadShowModel(f.root, showRunId)).phases[3]?.detail).not.toContain("must-not-read");
  });
});

describe("show設定とCLI分岐", () => {
  it("部分指定は既定キーを置換し、衝突・不正色・未知設定を拒否する", () => {
    const settings = showSettingsSchema.parse({ keys: { up: "k", down: "j" } });
    expect(resolveShowSettings({ keys: { up: undefined }, colors: { border: undefined } })).toEqual(resolveShowSettings());
    expect(showSettingsSchema.safeParse({ keys: { up: undefined, quit: "up" } }).success).toBe(false);
    expect(resolveShowSettings(settings).keys).toEqual({ up: "k", down: "j", toggle: "tab", quit: "q" });
    expect(showAction(settings, "k", { name: "k" })).toBe("up");
    expect(showAction(settings, "j", { name: "j" })).toBe("down");
    expect(showAction(settings, "\x1b[A", { name: "up" })).toBeUndefined();
    expect(showAction(settings, "\x1b[B", { name: "down" })).toBeUndefined();
    expect(showAction(settings, "\t", { name: "tab" })).toBe("toggle");
    expect(showAction(settings, "q", { name: "q" })).toBe("quit");
    expect(showAction({ keys: { toggle: "t", quit: "x" } }, "\t", { name: "tab" })).toBeUndefined();
    expect(showAction({ keys: { toggle: "t", quit: "x" } }, "q", { name: "q" })).toBeUndefined();
    expect(showAction({ keys: { toggle: "t", quit: "x" } }, "t", { name: "t" })).toBe("toggle");
    expect(showAction({ keys: { toggle: "t", quit: "x" } }, "x", { name: "x" })).toBe("quit");
    expect(showAction({}, "\x1b[5~", { name: "pageup" })).toBeUndefined();
    expect(showAction({}, "\x1b[6~", { name: "pagedown" })).toBeUndefined();
    for (const value of [{ keys: { up: "q" } }, { keys: { up: "pageup" } }, { keys: { up: "\x1b" } }, { colors: { border: "red" } }, { colors: { text: "#ffffff" } }]) expect(showSettingsSchema.safeParse(value).success).toBe(false);
  });
  it("設定欠落は既定、show単独設定は接続設定不要、通常設定でもshowを認識する", async () => {
    const f = await fixture(), path = join(f.root, "config.json");
    expect(await loadShowSettings(path)).toEqual({});
    await writeFile(path, JSON.stringify({ show: { keys: { up: "k" } } }));
    expect(await loadShowSettings(path)).toEqual({ keys: { up: "k" } });
    await writeFile(path, JSON.stringify({ schemaVersion: 2, github: {}, show: { colors: { border: "#abcdef" } } }));
    expect((await loadGitHubConfig(path)).show?.colors?.border).toBe("#abcdef");
    await writeFile(path, "broken"); await expect(loadShowSettings(path)).rejects.toThrow("show設定");
  });
  it("TTY通常表示のみTUIを起動し、保存記録・ロック・MCPを変更しない", async () => {
    const f = await fixture(), out = jest.fn(), err = jest.fn(), tui = jest.fn(async () => {});
    const connect = jest.spyOn(GitHubClient, "create");
    const before = await readFile(join(f.run, "state.json"), "utf8"), names = await readdir(f.root);
    const options = { root: f.root, env: {}, stdout: out, stderr: err, stdinIsTTY: true, stdoutIsTTY: true, showTui: tui };
    expect(await executeCli(["show", showRunId], options)).toBe(0);
    expect(tui).toHaveBeenCalledTimes(1); expect(out).not.toHaveBeenCalled();
    for (const extra of [["--no-pager"], ["--phase", "plan", "--no-pager"]]) expect(await executeCli(["show", showRunId, ...extra], options)).toBe(0);
    for (const [stdinIsTTY, stdoutIsTTY] of [[false, true], [true, false], [false, false]]) expect(await executeCli(["show", showRunId], { ...options, stdinIsTTY: stdinIsTTY!, stdoutIsTTY: stdoutIsTTY! })).toBe(0);
    expect(tui).toHaveBeenCalledTimes(1); expect(connect).not.toHaveBeenCalled(); expect(err).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual(names); expect(await readFile(join(f.run, "state.json"), "utf8")).toBe(before);
    expect(await executeCli(["show", showRunId, "--log", "bad"], options)).toBe(2);
  });
  it("raw mode・カーソル・画面・イベントリスナーを正常終了と出力例外で復元する", async () => {
    const f = await fixture(), model = await loadShowModel(f.root, showRunId);
    for (const fail of [false, true]) {
      const input = new PassThrough(), output = new PassThrough(); let raw = false, content = "";
      const terminal = Object.assign(input, { isRaw: false, setRawMode: (value: boolean) => { raw = value; return input; } });
      Object.assign(output, { columns: 100, rows: 30 });
      output.on("data", chunk => { content += chunk.toString(); });
      if (fail) { const write = output.write.bind(output); output.write = ((chunk: string) => { if (chunk.startsWith("\x1b[H")) throw new Error("draw failed"); return write(chunk); }) as typeof output.write; }
      const signals = process.listenerCount("SIGINT");
      const done = runShowTui(model, {}, terminal as unknown as ReadStream, output as unknown as WriteStream);
      if (fail) await expect(done).rejects.toThrow("draw failed");
      else { input.emit("keypress", "q", { name: "q" }); await done; }
      expect(raw).toBe(false); expect(input.isPaused()).toBe(true); expect(content).toContain("\x1b[?25h\x1b[?1049l");
      expect(input.listenerCount("keypress")).toBe(0); expect(output.listenerCount("resize")).toBe(0);
      expect(process.listenerCount("SIGINT")).toBe(signals);
      input.destroy(); output.destroy();
    }
  });
});
