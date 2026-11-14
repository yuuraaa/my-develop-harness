import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShowFixture, showRunId } from "./show-fixture.js";

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const plain = (s: string) => s.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, "");
async function snapshot(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(child)); else result[child] = (await readFile(child)).toString("base64");
  }
  return result;
}
/** 公開CLIを制御端末で動かす。実AI/MCP・認証・共有記録を使わない。 */
export async function verifyTerminalShow(executable: string, entry: string[], custom: boolean, quitInDetail: boolean) {
  const home = await mkdtemp(join(tmpdir(), "harness-show-terminal-"));
  const f = await createShowFixture(home);
  if (custom) await writeFile(join(f.root, "config.json"), JSON.stringify({ show: { keys: { up: "k", down: "j", toggle: "t", quit: "x" }, colors: { border: "#123456", activeBorder: "#abcdef" } } }));
  const before = await snapshot(home);
  const line = "stty rows 30 cols 100 || exit; " + [executable, ...entry, "show", showRunId].map(quote).join(" ")
    + "; task_show_code=$?; stty -a || exit; exit \"$task_show_code\"";
  const child = spawn("script", ["-q", "-e", "-c", line, "/dev/null"], {
    cwd: process.cwd(), env: { HOME: home, PATH: process.env.PATH, LANG: "C.UTF-8", TERM: "xterm-256color", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", error: Error | undefined, ended = false;
  child.stdout.setEncoding("utf8").on("data", s => { output += s; });
  child.stderr.setEncoding("utf8").on("data", s => { output += s; });
  child.on("error", e => { error = e; });
  const closed = new Promise<number | null>(resolve => child.on("close", code => { ended = true; resolve(code); }));
  const frame = () => plain(output.slice(output.lastIndexOf("\x1b[H")));
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 8000;
    while (!check()) {
      if (error) throw error;
      if (ended) throw new Error("show closed early: " + output.slice(-5000));
      if (Date.now() > deadline) throw new Error("show terminal timeout: " + output.slice(-5000));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const send = async (keys: string) => {
    const size = output.length;
    child.stdin.write(keys);
    await until(() => output.length > size && output.endsWith("\x1b[J"));
  };
  try {
    await until(() => frame().includes("▶ prepare:1"));
    assert.match(frame(), /GitHub.*issues.*133/); assert.match(frame(), /保存状態: completed/);
    assert.match(frame(), /一覧 1\/11/); assert.match(frame(), /prepare:1 詳細/);
    assert.doesNotMatch(frame(), /工程の流れ/);
    const up = custom ? "k" : "\x1b[A", down = custom ? "j" : "\x1b[B", toggle = custom ? "t" : "\t", quit = custom ? "x" : "q";
    if (custom) {
      await send("\x1b[A\x1b[B\tq"); assert.match(frame(), /▶ prepare:1/);
      assert.ok(!ended, "置換された終了キーqは無効");
    }
    await send(up); await until(() => frame().includes("▶ report:1"));
    assert.match(frame(), /一覧 11\/11/);
    await send(down); assert.match(frame(), /▶ prepare:1/);
    assert.match(frame(), /一覧 1\/11/); assert.match(frame(), /prepare:1 詳細/);
    await send(down.repeat(3)); await until(() => frame().includes("▶ implementation:1"));
    await send(toggle); await until(() => /implementation:1 詳細 · 操作中/.test(frame()));
    await send("\x1b[5~\x1b[6~"); assert.match(frame(), /行1-/);
    await send(down); await until(() => /行2-/.test(frame()));
    assert.match(frame(), /▶ implementation:1/); assert.match(frame(), /一覧/);
    // 保存本文の末尾を実際に画面へ出すまで下へ進む。
    for (let i = 0; i < 400 && !frame().includes("全文末尾マーカー"); i++) await send(down);
    assert.match(frame(), /全文末尾マーカー/);
    await send(toggle); await until(() => /一覧 .*操作中/.test(frame()));
    if (quitInDetail) { await send(toggle); await until(() => /implementation:1 詳細 · 操作中/.test(frame())); }
    child.stdin.write(quit);
    const code = await Promise.race([closed, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("show quit timeout")), 8000);
      closed.then(() => clearTimeout(timer));
    })]);
    assert.equal(code, 0, output.slice(-5000));
    assert.ok(output.includes("\x1b[?25h\x1b[?1049l"), "カーソルと画面を復元");
    const terminal = output.slice(output.lastIndexOf("\x1b[?1049l"));
    assert.match(terminal, /\bicanon\b/); assert.doesNotMatch(terminal, /-icanon/);
    assert.match(terminal, /(?:^|\s)echo(?:\s|;)/); assert.doesNotMatch(terminal, /(?:^|\s)-echo(?:\s|;)/);
    assert.deepEqual(await snapshot(home), before, "記録・設定・ロック等を書き換えない");
  } finally {
    if (!ended) child.kill("SIGTERM");
    await closed;
    await rm(home, { recursive: true, force: true });
  }
}
