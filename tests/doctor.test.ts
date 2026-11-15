import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { diagnose, formatDoctor, type DoctorOptions } from "../src/doctor.js";
import { inspectIssue, apiCommitFiles } from "../src/github-diagnostics.js";
import { parseGitHubConfig } from "../src/github-config.js";
import { GitHubClient, GitHubError } from "../src/github.js";
import type { IssueApi } from "../src/github-issue.js";
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
const sha = "a".repeat(40);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "github-doctor-")); roots.push(root);
  const config = parseGitHubConfig({ schemaVersion: 2, github: {}, repository: { cloneRoot: root, searchRoots: [root] }, watch: { repositories: ["a/b"] } }, join(root, "config.json"));
  const issue = { id: 1, number: 1, html_url: "https://github.com/a/b/issues/1", title: "仕様", body: "要件", state: "open", state_reason: null,
    labels: ["harness:enabled", "harness:ready"], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", parent_issue_url: null };
  const routes = new Map<string, unknown>([["/user", { login: "writer" }], ["/repos/a/b", { id: 10, full_name: "a/b", default_branch: "main" }],
    ["/repos/a/b/issues/1", issue], ["/repos/a/b/issues/1/parent", new GitHubError("request", null, 404, "no_parent_issue")],
    ["/repos/a/b/issues/1/comments?per_page=100", []], ["/repos/a/b/issues/1/sub_issues?per_page=100", []], ["/repos/a/b/issues/1/dependencies/blocked_by?per_page=100", []],
    ["/repos/a/b/commits/main", { sha }], ["/repos/a/b/git/trees/" + sha + "?recursive=1", { truncated: false, tree: [{ path: "AGENTS.md", mode: "100644", type: "blob", sha: "b".repeat(40) }] }],
    [`/repos/a/b/git/blobs/${"b".repeat(40)}`, { encoding: "base64", content: Buffer.from("規約").toString("base64"), size: Buffer.byteLength("規約") }]]);
  const calls: string[] = [];
  const api: IssueApi = { get: async <T>(path: string): Promise<T> => { calls.push(path); if (!routes.has(path)) throw new Error(path); const value = routes.get(path); if (value instanceof Error) throw value; return structuredClone(value) as T; },
    getPages: async <T>(path: string) => api.get<T[]>(path) };
  await writeFile(join(root, "config.json"), JSON.stringify(config));
  const options: DoctorOptions = { root, cwd: root, configPath: join(root, "config.json"), env: { HOME: root, HARNESS_GITHUB_READ_TOKEN: "reader-private", HARNESS_GITHUB_WRITE_TOKEN: "writer-private" },
    api, command: async () => ({ code: 0, stdout: "version", timedOut: false, failed: false }) };
  return { root, config, issue, routes, calls, api, options };
}
describe("GitHub起動前診断", () => {
  it.each(["No parent issue found", "Not Found"])("親URL省略時の実HTTP形式の404（%s）を区別して診断する", async message => {
    const f = await fixture();
    const { parent_issue_url: _, ...withoutParentUrl } = f.issue;
    f.routes.set("/repos/a/b/issues/1", withoutParentUrl);
    const api = await GitHubClient.create(f.config, { env: f.options.env, run: async (_program, args) => {
      const endpoint = args.at(-1)!;
      if (endpoint.endsWith("/parent")) return { code: 1, stdout: "HTTP/2 404 Not Found\r\nContent-Type: application/json\r\n\r\n" + JSON.stringify({ message }), stderr: "" };
      return { code: 0, stdout: "HTTP/2 200 OK\r\nContent-Type: application/json\r\n\r\n" + JSON.stringify(await f.api.get(endpoint)), stderr: "" };
    } });
    const report = await diagnose({ ...f.options, api, issue: "a/b#1",
      inspect: input => inspectIssue({ ...input, git: async () => { throw new Error("not git"); } }) });
    expect(report.items.find(i => i.id === "issue.context")?.status).toBe(message === "No parent issue found" ? "正常" : "異常");
    if (message === "No parent issue found") expect(report.items.find(i => i.id === "issue.eligibility")?.status).toBe("正常");
    else expect(report.exitCode).toBe(1);
    expect(await readdir(f.root)).toEqual(["config.json"]);
  });
  it("clone不在でも開始SHAの資料と依存を診断し、保存先・clone・worktreeを作らない", async () => {
    const f = await fixture(), before = await readdir(f.root);
    const result = await inspectIssue({ api: f.api, config: f.config, root: f.root, issue: "a/b#1", git: async () => { throw new Error("not git"); } });
    expect(result.eligibility.status).toBe("ready"); expect(result.startCommit).toBe(sha);
    expect(result.selection?.destination).toBe(join(f.root, "harness-clone/a/b"));
    expect(await readdir(f.root)).toEqual(before);
  });
  it("ready以外・親は更新やGit準備前に除外する", async () => {
    const f = await fixture(); f.routes.set("/repos/a/b/issues/1", { ...f.issue, labels: ["harness:enabled", "harness:ready", "harness:blocked"] });
    const result = await inspectIssue({ api: f.api, config: f.config, root: f.root, issue: "a/b#1", git: async () => { throw new Error("must not run"); } });
    expect(result.eligibility.status).toBe("waiting"); expect(result.selection).toBeNull();
  });
  it("必要資料欠落・truncated tree・非UTF8は成功にしない", async () => {
    for (const mode of ["missing", "truncated", "utf8"]) {
      const f = await fixture();
      if (mode === "missing") f.config.repositories["a/b"] = { pushRemote: "origin", requiredSources: [{ kind: "file", path: "missing.md" }] };
      if (mode === "truncated") f.routes.set(`/repos/a/b/git/trees/${sha}?recursive=1`, { truncated: true, tree: [] });
      if (mode === "utf8") f.routes.set(`/repos/a/b/git/blobs/${"b".repeat(40)}`, { encoding: "base64", content: "/w==", size: 1 });
      await expect(inspectIssue({ api: f.api, config: f.config, root: f.root, issue: "a/b#1", git: async () => { throw new Error(); } })).rejects.toThrow();
      expect(await readdir(f.root)).toEqual(["config.json"]);
    }
  });
  it("1MiB超でも文脈上限内の通常資料はBlob APIから読み取り可能", async () => {
    const f = await fixture(), body = "x".repeat(2 * 1024 * 1024);
    f.routes.set(`/repos/a/b/git/blobs/${"b".repeat(40)}`, { encoding: "base64", content: Buffer.from(body).toString("base64"), size: body.length });
    const result = await inspectIssue({ api: f.api, config: f.config, root: f.root, issue: "a/b#1", git: async () => { throw new Error(); } });
    expect(result.eligibility.status).toBe("ready"); expect(f.calls.some(path => path.includes("/contents/"))).toBe(false);
    expect(await readdir(f.root)).toEqual(["config.json"]);
  });
  it("API blobの不正base64とサイズ不一致を拒否する", async () => {
    const f = await fixture();
    for (const content of ["??", "YQ=="]) {
      f.routes.set(`/repos/a/b/git/blobs/${"b".repeat(40)}`, { encoding: "base64", content, size: 2 });
      await expect(apiCommitFiles(f.api, "a/b").read(sha, "AGENTS.md")).rejects.toThrow();
    }
  });
  it("明示認証・gh存在・必要資料・repo予定先を診断し、記録は作らない", async () => {
    const f = await fixture();
    const report = await diagnose({ ...f.options, issue: "a/b#1", inspect: input => inspectIssue({ ...input, git: async () => { throw new Error(); } }) });
    expect(report.items.find(i => i.id === "gh.version")?.status).toBe("正常");
    expect(report.items.find(i => i.id === "issue.eligibility")?.status).toBe("正常");
    expect(report.items.find(i => i.id === "issue.repository")?.reason).toContain("push remote: origin");
    expect(await readdir(f.root)).toEqual(["config.json"]);
    expect(formatDoctor(report, true)).not.toContain("writer-private");
  });
  it("gh不在・認証不足・不正設定を異常として表示する", async () => {
    const f = await fixture();
    const report = await diagnose({ ...f.options, env: { HOME: f.root }, command: async () => ({ code: null, stdout: "", failed: true, timedOut: false }) });
    expect(report.exitCode).toBe(1); expect(report.items.find(i => i.id === "github.tokens")?.status).toBe("異常");
    expect(report.items.find(i => i.id === "gh.version")?.status).toBe("異常");
    await writeFile(f.options.configPath, '{"github":{"unexpected":true}}');
    expect((await diagnose(f.options)).items.find(i => i.id === "config")?.remedy).toContain("github-config.example.json");
  });
  it.each(["included", "not_included", "missing", "permission", "rate_limit", "transport", "malformed"])("依存のAPI包含%sを手動runと同じ待機/停止へ分類", async mode => {
    const f = await fixture(), head = "c".repeat(40), base = "d".repeat(40);
    const dependency = { ...f.issue, id: 2, number: 2, html_url: "https://github.com/a/b/issues/2", state: "closed", state_reason: "completed" };
    f.routes.set("/repos/a/b/issues/1/dependencies/blocked_by?per_page=100", [dependency]);
    f.routes.set("/repos/a/b/issues/2", dependency);
    f.routes.set("/repos/a/b/issues/2/dependencies/blocked_by?per_page=100", []);
    const marker = `<!-- harness-result:v2\n${JSON.stringify({ schemaVersion: 2, repository: "a/b", issueNumber: 2,
      source: "harness", runId: "00000000-0000-4000-8000-000000000003", branch: "feature/work", baseCommit: base, headCommit: head,
      requiredCommits: [head], noCommitRequired: false, reason: null, publication: "confirmed" })}\n-->`;
    f.routes.set("/repos/a/b/issues/2/comments?per_page=100", [{ id: 10, body: marker, user: { id: 1, login: "writer", type: "User" },
      created_at: f.issue.created_at, updated_at: f.issue.updated_at, html_url: "https://github.com/a/b/issues/2#issuecomment-10" }]);
    f.routes.set("/repos/a/b/collaborators/writer/permission", { permission: "write", user: { id: 1, login: "writer" } });
    const response = mode === "missing" ? new GitHubError("request", null, 404)
      : ["permission", "rate_limit", "transport"].includes(mode) ? new GitHubError(mode as "permission" | "rate_limit" | "transport")
      : mode === "malformed" ? { status: "unexpected" } : { status: mode === "included" ? "ahead" : "diverged" };
    for (const [commit, target] of [[head, sha], [base, head], [head, head]]) f.routes.set(`/repos/a/b/compare/${commit}...${target}`, response);
    const inspection = inspectIssue({ api: f.api, config: f.config, root: f.root, issue: "a/b#1", git: async () => { throw new Error(); } });
    if (["included", "not_included", "missing"].includes(mode)) {
      const result = await inspection;
      expect(result.eligibility.status).toBe(mode === "included" ? "ready" : "waiting");
      if (mode === "missing") expect(result.eligibility.reasons.join(" ")).toContain("包含が未確認");
    } else await expect(inspection).rejects.toThrow();
    expect(await readdir(f.root)).toEqual(["config.json"]);
  });
  it("待機理由は警告で表示しラベル・コメントを更新しない", async () => {
    const f = await fixture();
    const report = await diagnose({ ...f.options, issue: "a/b#1", inspect: async () => ({ eligibility: { status: "waiting", reasons: ["依存成果が未確認"], dependencies: [] }, selection: null, startCommit: null, worktreePath: null, previousRunId: null, warnings: [] }) });
    expect(report.items.find(i => i.id === "issue.eligibility")).toMatchObject({ status: "警告", reason: "依存成果が未確認" });
    expect(f.calls.every(path => path === "/user" || path === "/repos/a/b")).toBe(true);
  });
});
