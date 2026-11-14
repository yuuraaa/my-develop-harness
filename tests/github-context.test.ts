import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseGitHubConfig } from "../src/github-config.js";
import { GitHubClient, GitHubError } from "../src/github.js";
import { IssueContextError, normalizeIssueReference, fullSha, githubId, type IssueApi } from "../src/github-issue.js";
import { fetchIssueContext, evaluateIssueEligibility, localCommitFiles, saveIssueContext } from "../src/github-context.js";

const sha = "a".repeat(40), base = "b".repeat(40), blob = "c".repeat(40);
const config = (overrides = {}) => parseGitHubConfig({ schemaVersion: 2, github: {}, ...overrides }, "/tmp/config.json");
const issue = (n: number, overrides = {}) => ({ id: n, number: n, html_url: `https://github.com/a/b/issues/${n}`,
  title: `Issue ${n}`, body: `body ${n}`, state: "open", state_reason: null, labels: ["harness:enabled", { name: "harness:ready" }],
  created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", parent_issue_url: null, ...overrides });
const comment = (id: number, body: string, overrides = {}) => ({ id, body, user: { id: 1, login: "writer", type: "User" },
  created_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-02T00:00:00Z", html_url: `https://github.com/a/b/issues/2#issuecomment-${id}`, ...overrides });
const marker = (overrides = {}) => `<!-- harness-result:v2\n${JSON.stringify({ schemaVersion: 2, repository: "a/b", issueNumber: 2,
  source: "harness", runId: "026948cc-1d02-4c62-b616-d96977d8af23", branch: "feature/work", baseCommit: base, headCommit: sha,
  requiredCommits: [sha], noCommitRequired: false, reason: null, publication: "confirmed", ...overrides })}\n-->`;
const noCommit = () => marker({ source: "human", runId: null, branch: null, baseCommit: null, headCommit: null,
  requiredCommits: [], noCommitRequired: true, reason: "既存成果で充足" });
const files = { async list() { return [{ path: "AGENTS.md", mode: "100644" }]; }, async read() { return "root rules"; } };
const start = { startCommit: sha, commitFiles: files };
function fixture() {
  const routes = new Map<string, unknown>();
  const calls: string[] = [];
  routes.set("/repos/a/b", { id: 10, full_name: "A/B" });
  routes.set("/repos/a/b/collaborators/writer/permission", { permission: "write", user: { id: 1, login: "writer" } });
  for (const n of [1, 2, 3]) {
    const path = `/repos/a/b/issues/${n}`;
    routes.set(path, issue(n)); routes.set(`${path}/parent`, new GitHubError("request", null, 404));
    for (const suffix of ["comments", "sub_issues", "dependencies/blocked_by"]) routes.set(`${path}/${suffix}?per_page=100`, []);
  }
  const api = {
    async get<T = unknown>(path: string): Promise<T> {
      calls.push(path);
      if (!routes.has(path)) throw new Error(`unexpected fixture path: ${path}`);
      const value = routes.get(path); if (value instanceof Error) throw value;
      return structuredClone(value) as T;
    },
    async getPages<T = unknown>(path: string) { return this.get<T[]>(path); },
  } satisfies IssueApi;
  const dependency = (comments = [comment(1, marker())]) => {
    routes.set("/repos/a/b/issues/1/dependencies/blocked_by?per_page=100", [issue(2)]);
    routes.set("/repos/a/b/issues/2", issue(2, { state: "closed", state_reason: "completed" }));
    routes.set("/repos/a/b/issues/2/comments?per_page=100", comments);
  };
  return { api, calls, routes, dependency };
}

describe("Issue識別子と文脈取得", () => {
  it("2表記を一意化し、PR・旧指定・URL付加情報を拒否", () => {
    expect(normalizeIssueReference("https://github.com/A/B/issues/12/")).toEqual(normalizeIssueReference("a/b#12"));
    for (const v of ["12", "12", "a/b#01", "a/b#0", "a/b#9007199254740992", "https://github.com/a/b/pull/12",
      "https://github.com/a/b/issues/12?x=1", "https://github.com/a/b/issues/12#x", "https://u@github.com/a/b/issues/12",
      "https://github.com/a/../b/issues/12", "https://github.com:443/a/b/issues/12", "https://evil.test/a/b/issues/12", " a/b#1", "a/b#1\n", "https://github.com/a/b/issues/1\n"])
      expect(() => normalizeIssueReference(v)).toThrow(IssueContextError);
    expect(fullSha.safeParse(sha + "\n").success).toBe(false);
    expect(githubId.safeParse("123\n").success).toBe(false);
  });
  it("最上位祖先・全コメント・直接子・直接依存・出典を保存し通常リンクを辿らない", async () => {
    const f = fixture();
    f.routes.set("/repos/a/b/issues/1", issue(1, { body: "https://example.com/ignore", parent_issue_url: "https://api.github.com/repos/a/b/issues/3" }));
    f.routes.set("/repos/a/b/issues/1/parent", issue(3));
    f.routes.set("/repos/a/b/issues/3/comments?per_page=100", [comment(31, "ancestor comment")]);
    f.routes.set("/repos/a/b/issues/1/comments?per_page=100", [comment(10, "target comment")]);
    f.routes.set("/repos/a/b/issues/1/sub_issues?per_page=100", [issue(2, { state: "closed", state_reason: "completed" })]);
    const context = await fetchIssueContext(f.api, config(), "a/b#1", start);
    expect(context.managementIssue.id).toBe("3"); expect(context.ancestors[0]!.comments).toHaveLength(1);
    expect(context.children[0]!.state_reason).toBe("completed"); expect(context.files[0]!.commit).toBe(sha);
    expect(context.files[0]!.appliesTo).toBe("**");
    expect(f.calls.every(p => p.startsWith("/repos/"))).toBe(true);
    expect((await evaluateIssueEligibility(f.api, config(), context)).reasons).toContain("子Issueを持つ親は実行対象外");
    const directory = await mkdtemp(join(tmpdir(), "issue-context-"));
    await saveIssueContext(directory, context, await evaluateIssueEligibility(f.api, config(), context));
    expect(JSON.parse(await readFile(join(directory, "issue-context.json"), "utf8")).ancestors[0].comments[0].body).toBe("ancestor comment");
    expect(JSON.parse(await readFile(join(directory, "dependency-evidence.json"), "utf8")).status).toBe("waiting");
    await expect(saveIssueContext(directory, context, { status: "ready", reasons: [], dependencies: [] })).rejects.toMatchObject({ kind: "storage" });
  });
  it("別repo祖先も読み、同repoの最上位祖先を管理単位にする", async () => {
    const f = fixture(), foreign = issue(9, { html_url: "https://github.com/c/d/issues/9" });
    f.routes.set("/repos/c/d", { id: 20, full_name: "c/d" });
    f.routes.set("/repos/a/b/issues/1", issue(1, { parent_issue_url: "https://api.github.com/repos/c/d/issues/9" }));
    f.routes.set("/repos/a/b/issues/1/parent", foreign);
    f.routes.set("/repos/c/d/issues/9", foreign); f.routes.set("/repos/c/d/issues/9/comments?per_page=100", []);
    f.routes.set("/repos/c/d/issues/9/parent", new GitHubError("request", null, 404));
    const c = await fetchIssueContext(f.api, config(), "a/b#1", start);
    expect(c.ancestors[0]!.issue.repository).toBe("c/d"); expect(c.managementIssue.id).toBe("1");
  });
  it("PR・改名・不正応答・権限不足・曖昧404は停止", async () => {
    for (const overrides of [{ pull_request: {} }, { parent_issue_url: undefined }, { parent_issue_url: "https://api.github.com/repos/c/d/issues/9" }, { id: 9007199254740992 }]) {
      const f = fixture(); f.routes.set("/repos/a/b/issues/1", issue(1, overrides));
      await expect(fetchIssueContext(f.api, config(), "a/b#1", start)).rejects.toThrow();
    }
    const f = fixture(); f.routes.set("/repos/a/b", { id: 10, full_name: "a/renamed" });
    await expect(fetchIssueContext(f.api, config(), "a/b#1", start)).rejects.toMatchObject({ kind: "response" });
    f.routes.set("/repos/a/b", new GitHubError("permission"));
    await expect(fetchIssueContext(f.api, config(), "a/b#1", start)).rejects.toMatchObject({ kind: "permission" });
  });
  it("親循環・推移的依存循環を検出し、diamond依存は許容する", async () => {
    const f = fixture();
    f.routes.set("/repos/a/b/issues/1", issue(1, { parent_issue_url: "https://api.github.com/repos/a/b/issues/1" }));
    f.routes.set("/repos/a/b/issues/1/parent", issue(1));
    await expect(fetchIssueContext(f.api, config(), "a/b#1", start)).rejects.toMatchObject({ kind: "cycle" });
    const d = fixture(); d.dependency();
    d.routes.set("/repos/a/b/issues/2/dependencies/blocked_by?per_page=100", [issue(3)]);
    d.routes.set("/repos/a/b/issues/3/dependencies/blocked_by?per_page=100", [issue(1)]);
    await expect(fetchIssueContext(d.api, config(), "a/b#1", start)).rejects.toMatchObject({ kind: "cycle" });
    expect(d.calls).not.toContain("/repos/a/b/issues/3/comments?per_page=100");
    d.routes.set("/repos/a/b/issues/1/dependencies/blocked_by?per_page=100", [issue(2), issue(3)]);
    d.routes.set("/repos/a/b/issues/3/dependencies/blocked_by?per_page=100", []);
    expect((await fetchIssueContext(d.api, config(), "a/b#1", start)).dependencyGraph).toHaveLength(3);
  });
  it("本文・コメント・file・過去入力のUTF-8実バイトと重複除外、超過時の詳細", async () => {
    const f = fixture(); f.routes.set("/repos/a/b/issues/1", issue(1, { body: "あ", title: "メタデータは加算しない" }));
    const c = config({ github: { maxContextBytes: 9 }, repositories: { "a/b": { requiredSources: [{ kind: "githubIssue", repository: "a/b", number: 1 }] } } });
    const options = { startCommit: sha, commitFiles: { async list() { return []; }, async read() { return ""; } }, previousInputs: [{ source: "old-run", body: "いろ" }] };
    expect((await fetchIssueContext(f.api, c, "a/b#1", options)).totalBytes).toBe(9);
    await expect(fetchIssueContext(f.api, config({ github: { maxContextBytes: 8 } }), "a/b#1", options)).rejects.toMatchObject({ kind: "limit", details: { totalBytes: 9, maxBytes: 8 } });
    expect(config().github.maxContextBytes).toBe(10 * 1024 * 1024);
  });
  it("子本文は保存せず、同じ出典の異なる過去入力を拒否する", async () => {
    const f = fixture(); f.routes.set("/repos/a/b/issues/1", issue(1, { body: "x" }));
    f.routes.set("/repos/a/b/issues/1/sub_issues?per_page=100", [issue(2, { body: "x".repeat(10000) })]);
    const c = await fetchIssueContext(f.api, config({ github: { maxContextBytes: 10 } }), "a/b#1");
    expect(c.totalBytes).toBe(1); expect(c.children[0]).not.toHaveProperty("body");
    await expect(fetchIssueContext(f.api, config(), "a/b#1", { previousInputs: [{ source: "run:1", body: "first" }, { source: "run:1", body: "different" }] })).rejects.toMatchObject({ kind: "response" });
  });
  it("文脈保存で既知秘密を除外し、保存不能はwaitingではなく停止", async () => {
    const f = fixture(); f.routes.set("/repos/a/b/issues/1", issue(1, { body: "private-fixture-value" }));
    const c = await fetchIssueContext(f.api, config(), "a/b#1", start);
    const eligibility = await evaluateIssueEligibility(f.api, config(), c);
    const dir = await mkdtemp(join(tmpdir(), "issue-save-"));
    await saveIssueContext(join(dir, "artifacts"), c, eligibility, ["private-fixture-value"]);
    const saved = await readFile(join(dir, "artifacts", "issue-context.json"), "utf8");
    expect(saved).not.toContain("private-fixture-value"); expect(JSON.parse(saved).target.issue.body).toBe("[REDACTED]");
    await writeFile(join(dir, "file"), "not a directory");
    await expect(saveIssueContext(join(dir, "file"), c, eligibility)).rejects.toMatchObject({ kind: "storage" });
  });
  it("全ページの対象/祖先コメント・子・依存を接続層から取得し途中失敗で停止", async () => {
    const f = fixture(); let fail = false;
    const api = await GitHubClient.create(config(), { env: { HARNESS_GITHUB_WRITE_TOKEN: "write-fixture", HARNESS_GITHUB_READ_TOKEN: "read-fixture" },
      sleep: async () => {}, run: async (_program, args) => {
        const endpoint = args.at(-1)!;
        if (endpoint.includes("&page=2")) return { code: fail ? 1 : 0, stdout: `HTTP/2 ${fail ? "403 Forbidden" : "200 OK"}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify([comment(2, "second")])}`, stderr: "" };
        if (endpoint.includes("comments?per_page=100")) return { code: 0, stdout: `HTTP/2 200 OK\r\nLink: <https://api.github.com${endpoint}&page=2>; rel="next"\r\n\r\n${JSON.stringify([comment(1, "first")])}`, stderr: "" };
        try { return { code: 0, stdout: `HTTP/2 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(await f.api.get(endpoint))}`, stderr: "" }; }
        catch { return { code: 1, stdout: "HTTP/2 404 Missing\r\nContent-Type: application/json\r\n\r\n{}", stderr: "" }; }
      } });
    expect((await fetchIssueContext(api, config(), "a/b#1", start)).target.comments).toHaveLength(2);
    fail = true;
    await expect(fetchIssueContext(api, config(), "a/b#1", start)).rejects.toMatchObject({ kind: "permission" });
  });
});

describe("共通着手判定・成果証拠", () => {
  it("担当者を条件にせずopen＋enabled＋単一readyを必要とする", async () => {
    for (const [overrides, expected] of [
      [{ assignees: [{ login: "someone-else" }] }, "ready"], [{ state: "closed" }, "waiting"],
      [{ labels: ["harness:ready"] }, "waiting"], [{ labels: ["harness:enabled"] }, "waiting"],
      [{ labels: ["harness:enabled", "harness:ready", "harness:running"] }, "waiting"],
      [{ labels: ["HARNESS:ENABLED", "HARNESS:READY", "other"] }, "ready"],
    ] as const) {
      const f = fixture(); f.routes.set("/repos/a/b/issues/1", issue(1, overrides));
      const c = await fetchIssueContext(f.api, config(), "a/b#1", start);
      expect((await evaluateIssueEligibility(f.api, config(), c)).status).toBe(expected);
    }
    const f = fixture(); expect((await evaluateIssueEligibility(f.api, config(), await fetchIssueContext(f.api, config(), "a/b#1"))).status).toBe("waiting");
  });
  it("完了closeと証拠、すべての包含を必要とする", async () => {
    const f = fixture(); f.dependency();
    const c = await fetchIssueContext(f.api, config(), "a/b#1", start);
    expect((await evaluateIssueEligibility(f.api, config(), c, { harnessLogin: "writer" })).status).toBe("waiting");
    const seen: string[] = [];
    const ready = await evaluateIssueEligibility(f.api, config(), c, { harnessLogin: "writer", checkInclusion: async (commit, target) => { seen.push(`${commit}:${target}`); return { status: "included" }; } });
    expect(ready.status).toBe("ready"); expect(seen).toContain(`${base}:${sha}`);
    const evidence = ready.dependencies[0]!.evidence;
    expect(evidence?.status === "confirmed" && evidence.bodySha256).toHaveLength(64);
    for (const status of ["not_included", "unconfirmed"] as const)
      expect((await evaluateIssueEligibility(f.api, config(), c, { harnessLogin: "writer", checkInclusion: async () => ({ status }) })).status).toBe("waiting");
    for (const reason of [null, "not_planned", "duplicate", "unknown"]) {
      c.dependencies[0]!.issue.state_reason = reason;
      expect((await evaluateIssueEligibility(f.api, config(), c, { harnessLogin: "writer", checkInclusion: async () => ({ status: "included" }) })).status).toBe("waiting");
    }
  });
  it("人間の成果コミット不要は包含のみ省略し、write以外やharness偽装は許可しない", async () => {
    const f = fixture(); f.dependency([comment(1, noCommit())]);
    const c = await fetchIssueContext(f.api, config(), "a/b#1", start);
    expect((await evaluateIssueEligibility(f.api, config(), c)).status).toBe("ready");
    f.routes.set("/repos/a/b/collaborators/writer/permission", { permission: "read", user: { id: 1, login: "writer" } });
    expect((await evaluateIssueEligibility(f.api, config(), c)).status).toBe("waiting");
    c.dependencies[0]!.comments = [comment(1, marker())] as never;
    f.routes.set("/repos/a/b/collaborators/writer/permission", { permission: "admin", user: { id: 1, login: "writer" } });
    expect((await evaluateIssueEligibility(f.api, config(), c, { harnessLogin: "different-bot", checkInclusion: async () => ({ status: "included" }) })).status).toBe("waiting");
  });
  it("最新の信頼できる候補を作成時刻→IDで選び、最新不正から古い証拠へ戻らない", async () => {
    const f = fixture();
    const invalid = [marker({ publication: "unknown" }), marker({ issueNumber: 3 }), marker({ schemaVersion: 2 }),
      noCommit() + noCommit(), "<!-- harness-result:v2 {broken -->", marker({ noCommitRequired: true }),
      marker({ requiredCommits: [] }), marker({ source: "human", runId: null, requiredCommits: ["ab"] })];
    for (const body of invalid) {
      f.dependency([comment(1, noCommit(), { updated_at: "2026-11-03T00:00:00Z" }), comment(2, body)]);
      const c = await fetchIssueContext(f.api, config(), "a/b#1", start);
      expect((await evaluateIssueEligibility(f.api, config(), c, { harnessLogin: "writer" })).status).toBe("waiting");
    }
    f.dependency([comment(100, "<!-- harness-result:v2 broken -->", { created_at: "2026-11-01T00:00:00Z" }), comment(2, noCommit())]);
    expect((await evaluateIssueEligibility(f.api, config(), await fetchIssueContext(f.api, config(), "a/b#1", start))).status).toBe("ready");
  });
  it("信頼できない投稿者は除外し、権限照会失敗は古い証拠へ戻らず待機", async () => {
    const f = fixture(); f.dependency([comment(1, noCommit()), comment(2, noCommit(), { user: { id: 9, login: "reader", type: "User" } })]);
    f.routes.set("/repos/a/b/collaborators/reader/permission", { permission: "read", user: { id: 9, login: "reader" } });
    const c = await fetchIssueContext(f.api, config(), "a/b#1", start);
    expect((await evaluateIssueEligibility(f.api, config(), c)).status).toBe("ready");
    f.routes.set("/repos/a/b/collaborators/reader/permission", new GitHubError("permission"));
    expect((await evaluateIssueEligibility(f.api, config(), c)).status).toBe("waiting");
    f.routes.set("/repos/a/b/collaborators/reader/permission", new GitHubError("rate_limit", "2026-11-09T00:00:00Z"));
    await expect(evaluateIssueEligibility(f.api, config(), c)).rejects.toMatchObject({ kind: "rate_limit" });
  });
  it("過去Botのhuman偽装を拒否し、現在のharness Botの同書式報告だけを採用", async () => {
    const f = fixture();
    f.routes.set("/repos/a/b/collaborators/old-bot%5Bbot%5D/permission", { permission: "write", user: { id: 9, login: "old-bot[bot]" } });
    const botUser = { id: 9, login: "old-bot[bot]", type: "Bot" };
    f.dependency([comment(1, noCommit(), { user: botUser })]);
    const c = await fetchIssueContext(f.api, config(), "a/b#1", start);
    expect((await evaluateIssueEligibility(f.api, config(), c, { harnessLogin: "current-bot[bot]" })).status).toBe("waiting");
    c.dependencies[0]!.comments[0]!.body = marker();
    expect((await evaluateIssueEligibility(f.api, config(), c, { harnessLogin: "current-bot[bot]", checkInclusion: async () => ({ status: "included" }) })).status).toBe("waiting");
    expect((await evaluateIssueEligibility(f.api, config(), c, { harnessLogin: "old-bot[bot]", checkInclusion: async () => ({ status: "included" }) })).status).toBe("ready");
  });
});

describe("開始コミットと必須資料", () => {
  it("実Gitの開始SHAだけを読み、ネスト指示の適用先・required fileを記録", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-git-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
    await writeFile(join(dir, "AGENTS.md"), "committed rule"); await writeFile(join(dir, "spec.md"), "spec");
    git("add", "."); git("commit", "-qm", "fixture"); const commit = git("rev-parse", "HEAD");
    await writeFile(join(dir, "AGENTS.md"), "uncommitted rule");
    const f = fixture(), c = config({ repositories: { "a/b": { requiredSources: [{ kind: "file", path: "spec.md" }] } } });
    const context = await fetchIssueContext(f.api, c, "a/b#1", { startCommit: commit, commitFiles: localCommitFiles(dir) });
    expect(context.files.map(f => f.body)).toEqual(["committed rule", "spec"]);
    expect(context.files.every(f => f.commit === commit)).toBe(true);
    expect(git("status", "--porcelain")).toContain("AGENTS.md");
  });
  it("実Gitの5MiB資料を上限内で取得し、非UTF-8 blobは置換せず停止", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-git-large-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
    await writeFile(join(dir, "large.md"), "x".repeat(5 * 1024 * 1024));
    await writeFile(join(dir, "invalid.md"), Buffer.from([0xff]));
    await writeFile(join(dir, "bom.md"), Buffer.from([0xef, 0xbb, 0xbf, 0x78]));
    git("add", "."); git("commit", "-qm", "fixture"); const commit = git("rev-parse", "HEAD");
    const f = fixture(), c = config({ repositories: { "a/b": { requiredSources: [{ kind: "file", path: "large.md" }] } } });
    const reader = localCommitFiles(dir);
    const context = await fetchIssueContext(f.api, c, "a/b#1", { startCommit: commit, commitFiles: reader });
    expect(context.files[0]!.body.length).toBe(5 * 1024 * 1024);
    expect(context.totalBytes).toBe(5 * 1024 * 1024 + 6);
    await expect(reader.read(commit, "invalid.md")).rejects.toMatchObject({ kind: "source" });
    expect(await reader.read(commit, "bom.md")).toBe("\uFEFFx");
    const bomConfig = config({ repositories: { "a/b": { requiredSources: [{ kind: "file", path: "bom.md" }] } } });
    expect((await fetchIssueContext(f.api, bomConfig, "a/b#1", { startCommit: commit, commitFiles: reader })).totalBytes).toBe(10);
  });
  it("ネスト指示は浅い順、同階層のoverride優先と適用スコープを保存", async () => {
    const f = fixture();
    const c = await fetchIssueContext(f.api, config(), "a/b#1", { startCommit: sha, commitFiles: {
      async list() { return ["src/AGENTS.md", "AGENTS.override.md", "AGENTS.md"].map(path => ({ path, mode: "100644" })); },
      async read(_commit, path) { return path; },
    } });
    expect(c.files.map(f => f.path)).toEqual(["AGENTS.md", "AGENTS.override.md", "src/AGENTS.md"]);
    expect(c.files[0]!.supersededBy).toBe("AGENTS.override.md"); expect(c.files[0]!.appliesTo).toBeNull();
    expect(c.files[1]!.appliesTo).toBe("**"); expect(c.files[2]!.appliesTo).toBe("src/**");
  });
  it("シンボリックリンク・必須資料欠落は停止", async () => {
    const f = fixture();
    for (const entries of [[{ path: "AGENTS.md", mode: "120000" }], []]) {
      const c = config({ repositories: { "a/b": { requiredSources: [{ kind: "file", path: "AGENTS.md" }] } } });
      await expect(fetchIssueContext(f.api, c, "a/b#1", { startCommit: sha, commitFiles: { ...files, async list() { return entries; } } })).rejects.toMatchObject({ kind: "source" });
    }
  });
  it("githubFileのrefをSHA固定し通常blobのみ取得、上限・truncated・symlinkを拒否", async () => {
    const f = fixture(), c = config({ repositories: { "a/b": { requiredSources: [{ kind: "githubFile", repository: "a/b", ref: "main", path: "spec.md" }] } } });
    f.routes.set("/repos/a/b/commits/main", { sha, commit: { tree: { sha: base } } });
    const tree = { truncated: false, tree: [{ path: "spec.md", type: "blob", mode: "100644", sha: blob }] };
    f.routes.set(`/repos/a/b/git/trees/${base}?recursive=1`, tree);
    f.routes.set(`/repos/a/b/git/blobs/${blob}`, { encoding: "base64", content: Buffer.from("仕様").toString("base64"), size: 6 });
    const context = await fetchIssueContext(f.api, c, "a/b#1", start);
    expect(context.files.at(-1)!.body).toBe("仕様"); expect(context.files.at(-1)!.commit).toBe(sha);
    f.routes.set(`/repos/a/b/git/blobs/${blob}`, { encoding: "base64", content: Buffer.from([0xef, 0xbb, 0xbf, 0x78]).toString("base64"), size: 4 });
    const bom = await fetchIssueContext(f.api, c, "a/b#1", start);
    expect(bom.files.at(-1)!.body).toBe("\uFEFFx"); expect(bom.totalBytes).toBe(6 + 10 + 4);
    for (const invalid of [{ ...tree, truncated: true }, { ...tree, tree: [{ ...tree.tree[0], mode: "120000" }] }]) {
      f.routes.set(`/repos/a/b/git/trees/${base}?recursive=1`, invalid);
      await expect(fetchIssueContext(f.api, c, "a/b#1", start)).rejects.toThrow();
    }
  });
});
