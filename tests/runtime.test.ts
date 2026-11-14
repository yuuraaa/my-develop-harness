import { issueState } from "./helpers/issue-state.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, jest } from "bun:test";
import { newRunId, RunStore } from "../src/state.js";
import type { RunState } from "../src/schemas.js";
import { command } from "./helpers/acceptance.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
beforeAll(async () => {
  const build = await command("bun", ["run", "build"], process.cwd());
  expect(build.code, build.stderr).toBe(0);
}, 60_000);

describe("実行ランタイムとビルド済みCLI", () => {
  jest.setTimeout(15_000);
  it("BunテストとCLI子プロセスがBunで動き、help・引数エラー・保存済みstatusを確認する", async () => {
    const runtime = process.versions["bun"] ? "bun" : "node";
    expect(runtime).toBe("bun");
    console.info(JSON.stringify({ runtime, version: process.versions["bun"] ?? process.versions.node, execPath: process.execPath }));
    const home = await mkdtemp(join(tmpdir(), "harness-runtime-")); roots.push(home);
    const store = new RunStore(newRunId(), join(home, ".harness"));
    const state: RunState = issueState({
      schemaVersion: 2, runId: store.runId, issueId: "81", repositoryId: "owner/repo", repositoryPath: "/repo",
      branchName: "chore/runtime", worktreePath: store.worktreePath, baseCommit: "a".repeat(40), phase: "plan",
      status: "stopped", phaseStatus: "failed", fixCount: 0, retryCount: {}, verificationArtifact: null,
      codexThreadId: null, reviewThreadIds: [], resultCommits: [], reviewedTreeId: null,
      error: { classification: "fatal", message: "ランタイム検証用の記録", operation: "runtime" }, updatedAt: new Date().toISOString(),
    });
    await store.createGitHub(state);
    const saved = await readFile(join(store.runPath, "state.json"));
    const probe = join(home, "runtime.cjs");
    await writeFile(probe, `const runtime = process.versions.bun ? 'bun' : 'node';
if (runtime !== ${JSON.stringify(runtime)}) throw new Error('CLI runtime mismatch');
console.error('CLI_RUNTIME=' + runtime);
`);
    const cli = (...args: string[]) => command(process.execPath,
      ["--require", probe, resolve("dist/index.js"), ...args], process.cwd(), { PATH: process.env.PATH, HOME: home });
    const help = await cli("--help");
    expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain("Usage:");
    expect(help.stderr.trim()).toBe(`CLI_RUNTIME=${runtime}`);
    const invalid = await cli("--unknown");
    expect(invalid.code).toBe(2); expect(invalid.stderr).toContain(`CLI_RUNTIME=${runtime}`);
    const status = await cli("status", store.runId);
    expect(status.code, status.stderr).toBe(0); expect(status.stderr.trim()).toBe(`CLI_RUNTIME=${runtime}`);
    expect(status.stdout).toContain("状態: stopped"); expect(status.stdout).toContain("ランタイム検証用の記録");
    expect(await readFile(join(store.runPath, "state.json"))).toEqual(saved);
  });
});
