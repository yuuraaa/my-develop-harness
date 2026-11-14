import { it, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runIsolatedIssue } from "../src/watch.js";
it("公開watchは外部ghで空候補を取得し、SIGINTで待機を中断して記録を作らず終了する", async () => {
  const root = await mkdtemp(join(tmpdir(), "watch-github-process-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const bin = join(root, "bin"); await mkdir(bin);
    await writeFile(join(bin, "gh"), "#!/bin/sh\nprintf 'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n[]'\n", { mode: 0o700 });
    const config = join(root, "config.json"); await writeFile(config, JSON.stringify({ schemaVersion: 2, github: {}, watch: { repositories: ["a/b"] } }));
    child = spawn(process.execPath, [resolve("src/index.ts"), "--config", config, "watch", "--interval", "60"],
      { env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", HOME: root, PATH: `${bin}:${process.env.PATH}`, HARNESS_GITHUB_READ_TOKEN: "reader", HARNESS_GITHUB_WRITE_TOKEN: "writer" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const done = new Promise<number | null>((resolve, reject) => { child!.once("error", reject); child!.once("close", resolve); });
    const waiting = new Promise<void>(resolve => child!.stdout!.setEncoding("utf8").on("data", text => { stdout += text; if (stdout.includes("次回取得まで")) resolve(); }));
    child.stderr!.setEncoding("utf8").on("data", text => { stderr += text; });
    await Promise.race([waiting, done.then(() => { throw new Error(stderr); }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("watch待機に到達しない")), 4000).unref())]);
    child.kill("SIGINT"); expect(await done).toBe(0); expect(stderr).toBe(""); expect(stdout).toContain("監視終了: 停止要求");
    expect((await readdir(root)).sort()).toEqual(["bin", "config.json"]);
  } finally { if (child?.exitCode === null) child.kill("SIGTERM"); await rm(root, { recursive: true, force: true }); }
});
it("分離したIssue子プロセスの起動失敗をcompleted扱いせず、認証値を表示しない", async () => {
  const root = await mkdtemp(join(tmpdir(), "watch-isolated-"));
  try {
    let output = "";
    const status = await runIsolatedIssue({ issue: "a/b#1", configPath: join(root, "missing.json"), cwd: root, env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", HOME: root, PATH: process.env.PATH }, out: t => { output += t; }, err: t => { output += t; } });
    expect(status).toBe("stopped"); expect(output).toContain("GitHub設定"); expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
