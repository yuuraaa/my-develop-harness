import { issueState } from "./helpers/issue-state.js";
import { afterEach, expect, it, jest } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectHistory, formatHistory } from "../src/history.js";
import { executeCli } from "../src/cli.js";
import { GitHubClient } from "../src/github.js";
import type { RunState } from "../src/schemas.js";
import { command } from "./helpers/acceptance.js";
import { fileURLToPath } from "node:url";

const roots: string[] = [];
afterEach(async () => { jest.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function root() { const r = await mkdtemp(join(tmpdir(), "history-")); roots.push(r); return r; }
function state(n: number, overrides: Record<string, unknown> = {}): RunState {
  return issueState({ schemaVersion: 2, runId: id(n), issueId: "93", repositoryId: "owner/repo", repositoryPath: "/repo", branchName: "feature/test", worktreePath: "/absent", baseCommit: "a".repeat(40), phase: "review", status: "stopped", phaseStatus: "failed", fixCount: 0, retryCount: {}, verificationArtifact: null, codexThreadId: null, reviewThreadIds: [], resultCommits: [], reviewedTreeId: null, error: null, updatedAt: new Date(Date.UTC(2026, 9, n)).toISOString(), ...overrides });
}
async function save(r: string, s: RunState) {
  const p = join(r, "runs", s.runId); await mkdir(p, { recursive: true });
  await writeFile(join(p, "state.json"), JSON.stringify(s));
}
async function cli(r: string, args: string[]) {
  let stdout = "", stderr = "";
  const code = await executeCli(args, { root: r, env: {}, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}
it("設定・認証・MCP・成果物なしで5列を表示し、statusへ渡せて記録を変更しない", async () => {
  const r = await root(); const s = state(1); await save(r, s);
  const connect = jest.spyOn(GitHubClient, "create");
  const path = join(r, "runs", s.runId, "state.json"); const before = await readFile(path);
  const result = await cli(r, ["--config", "/missing/config.json", "history"]);
  expect(result.code).toBe(0); expect(result.stderr).toBe("");
  expect(result.stdout).toContain([s.runId, "GitHub", s.issue.url, s.status, s.phase, s.updatedAt].join("\t"));
  expect(result.stdout).toContain("harness status <run-id>");
  expect((await cli(r, ["status", s.runId])).stdout).toContain(`run ID: ${s.runId}`);
  expect(await readFile(path)).toEqual(before); expect(await readdir(r)).toEqual(["runs"]);
  expect(await readdir(join(r, "runs", s.runId))).toEqual(["state.json"]);
  expect(connect).not.toHaveBeenCalled();
});
it("新しい順・既定20件・limit・allと絞り込み後の制限", async () => {
  const r = await root();
  for (let n = 1; n <= 25; n++) await save(r, state(n, { issueId: n % 2 ? "93" : "94", status: n % 3 ? "stopped" : "completed" }));
  const entries = await collectHistory(r);
  const rows = (s: string) => s.split("\n").filter(line => /^00000000/.test(line));
  expect(rows(formatHistory(entries))).toHaveLength(20);
  expect(rows(formatHistory(entries, { all: true }))).toHaveLength(25);
  expect(rows(formatHistory(entries, { limit: 2 })).map(line => line.split("\t")[0])).toEqual([id(25), id(24)]);
  expect(rows(formatHistory(entries, { issue: "https://github.com/owner/repo/issues/94", limit: 1 }))[0]).toContain(id(24));
  expect(rows(formatHistory(entries, { status: "completed", limit: 1 }))[0]).toContain(id(24));
  expect(rows(formatHistory(entries, { issue: "https://github.com/owner/repo/issues/93", status: "completed", limit: 2 })).map(line => line.split("\t")[0])).toEqual([id(21), id(15)]);
  expect(formatHistory(entries, { issue: "https://github.com/owner/repo/issues/999" })).toContain("該当する実行履歴はありません");
});
it("同日時はrun IDで安定整列し、全保存状態と最後のフェーズを保持する", () => {
  const states = ["running", "completed", "stopped", "blocked"] as const;
  const entries = states.map((status, i) => ({ runId: id(i + 1), state: state(i + 1, { status, phase: "implementation", updatedAt: state(1).updatedAt }) })).reverse();
  const text = formatHistory(entries);
  for (const [i, status] of states.entries()) expect(text).toContain(`${id(i + 1)}\tGitHub\thttps://github.com/owner/repo/issues/93\t${status}\timplementation`);
  expect(text.indexOf(id(1))).toBeLessThan(text.indexOf(id(2)));
});
it("空履歴は正常終了し保存先を作成しない", async () => {
  const r = await root(); const missing = join(r, "absent");
  expect(await cli(missing, ["history"])).toMatchObject({ code: 0, stderr: "" });
  expect((await cli(missing, ["history"])).stdout).toContain("該当する実行履歴はありません");
  expect(await readdir(r)).toEqual([]);
});
it("欠落・壊れたJSON・スキーマ不正・run ID不一致でも正常記録を残す", async () => {
  const r = await root(); await save(r, state(1));
  for (let n = 2; n <= 5; n++) await mkdir(join(r, "runs", id(n)));
  await writeFile(join(r, "runs", id(3), "state.json"), "{");
  await writeFile(join(r, "runs", id(4), "state.json"), "{}");
  await writeFile(join(r, "runs", id(5), "state.json"), JSON.stringify(state(1)));
  const result = await cli(r, ["history", "--issue", "owner/repo#93", "--limit", "1"]);
  expect(result.code).toBe(0); expect(result.stdout).toContain(`${id(1)}\tGitHub\thttps://github.com/owner/repo/issues/93`);
  for (let n = 2; n <= 5; n++) expect(result.stdout).toContain(`${id(n)}\t読取不能`);
});
it("個別のEACCESを隔離し、生のエラーメッセージを出さない", async () => {
  const r = await root(); await save(r, state(1)); await save(r, state(2));
  const original = fs.readFile;
  jest.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).includes(id(2))) throw Object.assign(new Error("private-secret"), { code: "EACCES" });
    return original(...args);
  }) as typeof fs.readFile);
  const result = await cli(r, ["history"]);
  expect(result.code).toBe(0); expect(result.stdout).toContain(`${id(2)}\t読取不能`);
  expect(result.stdout).toContain(`${id(1)}\tGitHub\thttps://github.com/owner/repo/issues/93`); expect(result.stdout).not.toContain("private-secret");
});
it("runsがディレクトリでなければ一覧取得失敗を非ゼロで示す", async () => {
  const r = await root(); await writeFile(join(r, "runs"), "bad");
  expect((await cli(r, ["history"])).code).toBe(1);
});
it.each([["--limit", "0"], ["--limit", "-1"], ["--limit", "1.5"], ["--limit", "1e2"], ["--limit", "9007199254740992"], ["--all", "--limit", "2"], ["--issue", "93"], ["--status", "done"], ["extra"], ["--unknown"]].map(args => ({ args })))("不正引数は2: $args", async ({ args }) => {
  const r = await root(); expect((await cli(r, ["history", ...args])).code).toBe(2); expect(await readdir(r)).toEqual([]);
});
it("helpは状態の意味と一覧・詳細の導線を説明する", async () => {
  const r = await root(); const help = await cli(r, ["history", "--help"]);
  expect(help.code).toBe(0);
  for (const text of ["--issue", "--status", "--limit", "--all", "既定20件", "Issueのcloseとは異なります", "稼働を保証しません", "harness status <run-id>"]) expect(help.stdout).toContain(text);
  expect((await cli(r, ["--help"])).stdout).toContain("harness history");
});
it.each(["../src/index.ts", "../dist/index.js"])("%sを別cwd・設定・認証なしで起動し履歴からstatusを確認する", async entry => {
  const home = await root(); const r = join(home, ".harness"); await save(r, state(1));
  const cwd = await root(); const path = join(r, "runs", id(1), "state.json"); const before = await readFile(path);
  const env = { HOME: home, PATH: process.env.PATH, LANG: "C.UTF-8" };
  const executable = fileURLToPath(new URL(entry, import.meta.url));
  const history = await command(process.execPath, [executable, "history"], cwd, env);
  expect(history.code).toBe(0); expect(history.stderr).toBe(""); expect(history.stdout).toContain(`${id(1)}\tGitHub\thttps://github.com/owner/repo/issues/93`);
  const status = await command(process.execPath, [executable, "status", id(1)], cwd, env);
  expect(status.code).toBe(0); expect(status.stdout).toContain(`run ID: ${id(1)}`);
  expect(await readFile(path)).toEqual(before); expect(await readdir(r)).toEqual(["runs"]);
});

it("Issueで絞り込み、共有worktreeの実パスと再利用元・提出部分成功を閲覧できる", async () => {
  const r = await root(), old = state(1, { status: "stopped" }); await save(r, old);
  const identity = { host: "github.com", repositoryId: "10", repository: "a/b", issueId: "20", number: 3 };
  const modern = { ...state(2), schemaVersion: 2, backend: "github", issue: { ...identity, url: "https://github.com/a/b/issues/3" }, managementIssue: identity,
    repositoryPath: "/repo", worktreePath: "/saved/moved-worktree", branchName: "feature/work", workBranchName: "harness/work", branchRecordPath: "/records/branches/10/20.json",
    previousRunId: id(3), worktreeOriginRunId: id(3), restartHead: "a".repeat(40), remoteStartCommit: null,
    startTransition: "succeeded", stopReflection: { status: "unknown", message: "ラベル反映未確認" }, submissionArtifact: "submission.json", phase: "comment" };
  const run = join(r, "runs", modern.runId), artifacts = join(run, "artifacts"); await mkdir(artifacts, { recursive: true });
  await writeFile(join(run, "state.json"), JSON.stringify(modern)); await writeFile(join(run, "events.jsonl"), "");
  await writeFile(join(artifacts, "submission.json"), JSON.stringify({ push: { status: "succeeded" }, comment: { status: "unknown" }, reviewState: { status: "not_started" } }));
  const before = await readFile(join(run, "state.json"));
  const result = await cli(r, ["history", "--issue", "a/b#3"]);
  expect(result.code).toBe(0); expect(result.stdout).toContain("GitHub"); expect(result.stdout).toContain(modern.issue.url); expect(result.stdout).not.toContain(old.runId);
  const status = await cli(r, ["status", modern.runId]); expect(status.stdout).toContain("/saved/moved-worktree"); expect(status.stdout).toContain(`再利用元: ${id(3)}`);
  const show = await cli(r, ["show", modern.runId, "--phase", "comment", "--no-pager"]);
  expect(show.stdout).toContain('"status": "unknown"'); expect(show.stdout).toContain("GitHub"); expect(show.stdout).toContain("/saved/moved-worktree");
  expect(await readFile(join(run, "state.json"))).toEqual(before);
});
