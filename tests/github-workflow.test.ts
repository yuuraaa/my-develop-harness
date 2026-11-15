import { afterEach, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadEvent, TurnOptions } from "@openai/codex-sdk";
import { captureWorktreeTree, runGit } from "../src/git.js";
import { parseGitHubConfig } from "../src/github-config.js";
import { GitHubError } from "../src/github.js";
import { RunStore, newRunId } from "../src/state.js";
import { runIssueWorkflow } from "../src/github-workflow.js";
import { transitionIssueLabels, type IssueWriteApi } from "../src/github-labels.js";
import type { RepositoryTransport } from "../src/github-repository.js";
import type { PhaseConnection } from "../src/codex.js";
import { GitHubControl, GitHubWorkflowStopped } from "../src/github-control.js";
import { executeCli } from "../src/cli.js";
import { outputSchemaViolations } from "./helpers/output-schema.js";
import { BranchStore } from "../src/github-workspace-store.js";
import { submissionSchema } from "../src/github-submission.js";
import { evaluateDependency } from "../src/github-evidence.js";
import { IssueReader } from "../src/github-issue.js";
import { gitInclusion } from "../src/github-workspace.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const usage = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 };
const issue = (n = 1, overrides = {}) => ({ id: n, number: n, html_url: `https://github.com/a/b/issues/${n}`,
  title: "ログインの入力検証", body: "入力検証を実装し、check.cjsが成功すること。", state: "open", state_reason: null,
  labels: ["harness:enabled", "harness:ready", "unrelated"], created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", parent_issue_url: null, ...overrides });
const config = () => parseGitHubConfig({ schemaVersion: 2, github: { writeTokenEnv: "WRITE", readTokenEnv: "READ" } }, "/tmp/config.json");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "issue-run-")); roots.push(root);
  const repo = join(root, "repo"), bare = join(root, "remote.git"), harness = join(root, "harness");
  await mkdir(repo); await runGit(repo, ["init", "-b", "main"]);
  await runGit(repo, ["config", "user.name", "test"]); await runGit(repo, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(repo, "AGENTS.md"), "コンテナ内でcheck.cjsを実行する。\n");
  await writeFile(join(repo, "check.cjs"), "if (require('fs').readFileSync('result.txt','utf8') !== 'ok') process.exit(7);\n");
  await writeFile(join(repo, "result.txt"), "base");
  await runGit(repo, ["add", "."]); await runGit(repo, ["commit", "-m", "base"]);
  const base = (await runGit(repo, ["rev-parse", "HEAD"])).trim();
  await runGit(root, ["clone", "--bare", repo, bare]); await runGit(repo, ["remote", "add", "origin", "https://github.com/a/b.git"]);
  const calls: string[] = [], prompts: string[] = [], phases: string[] = [], routes = new Map<string, unknown>();
  let labels = [...issue().labels], comments: unknown[] = [], worktree = "", threadCount = 0, planCount = 0;
  routes.set("/user", { login: "writer" }); routes.set("/repos/a/b", { id: 10, full_name: "a/b" });
  routes.set("/repos/a/b/issues/1", issue()); routes.set("/repos/a/b/issues/1/parent", new GitHubError("request", null, 404, "no_parent_issue"));
  const behavior = {
    candidates: ["fix/login-validation"], implementation: true, failValidation: false,
    output: (_phase: string): unknown => null,
    during: async (_phase: string) => {},
    update: async (_method: string, _endpoint: string): Promise<void> => {},
    unknown: false,
    beforeTransport: async (_op: string) => {},
    afterTransport: async (_op: string) => {},
    afterUpdate: async (_method: string, _endpoint: string) => {},
  };
  const api: IssueWriteApi = {
    async get<T>(endpoint: string): Promise<T> {
      calls.push(`GET ${endpoint}`);
      if (endpoint.endsWith("/labels")) return labels.map(name => ({ name })) as T;
      if (routes.has(endpoint)) { const value = routes.get(endpoint); if (value instanceof Error) throw value; return structuredClone(value) as T; }
      if (endpoint.includes("comments")) return comments as T;
      if (endpoint.includes("sub_issues") || endpoint.includes("blocked_by")) return [] as T;
      throw new Error(`fixture: ${endpoint}`);
    },
    getPages<T>(endpoint: string) { return this.get<T[]>(endpoint); },
    async update<T>(method: string, endpoint: string, payload: unknown, reconcile?: () => Promise<{ confirmed: true; value: T } | { confirmed: false }>): Promise<T | undefined> {
      calls.push(`${method} ${endpoint}`); await behavior.update(method, endpoint);
      if (method === "POST" && endpoint.endsWith("/labels")) labels = [...new Set([...labels, ...(payload as { labels: string[] }).labels])];
      if (method === "DELETE") labels = labels.filter(n => n !== decodeURIComponent(endpoint.split("/").at(-1)!));
      let result: unknown = labels.map(name => ({ name }));
      if (method === "POST" && endpoint.endsWith("/comments")) { const id = comments.length + 1;
        result = { id, html_url: `https://github.com/a/b/issues/${endpoint.split("/")[5]}#issuecomment-${id}`, user: { id: 1, login: "writer", type: "User" },
          created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", ...(payload as object) }; comments.push(result); }
      await behavior.afterUpdate(method, endpoint);
      if (behavior.unknown) { const observed = await reconcile?.(); if (observed?.confirmed) return observed.value; throw new GitHubError("unknown"); }
      return result as T;
    },
  };
  const transport: RepositoryTransport = async (cwd, op, refs, dest) => {
    calls.push(op); await behavior.beforeTransport(op);
    const result = await runGit(cwd, op === "ls-remote" ? ["ls-remote", "--symref", bare, ...refs] : op === "fetch" ? ["fetch", bare, ...refs] : op === "push" ? ["push", bare, ...refs] : ["clone", bare, dest!]);
    await behavior.afterTransport(op); return result;
  };
  const thread = (id: string | null, next: string) => {
    const t = { id, async runStreamed(prompt: string, options?: TurnOptions) {
      const phase = prompt.split("フェーズ")[0]!; phases.push(phase); prompts.push(prompt);
      expect(outputSchemaViolations(options?.outputSchema)).toEqual([]);
      return { events: (async function* (): AsyncGenerator<ThreadEvent> {
        t.id = next; yield { type: "thread.started", thread_id: next };
        let output = behavior.output(phase);
        await behavior.during(phase);
        if (phase === "plan") output ??= { branchName: behavior.candidates[Math.min(planCount++, behavior.candidates.length - 1)],
          plan: { summary: "Issue本文の要件", steps: ["入力検証"], validationPlan: [{ id: "test", kind: "test", command: `${process.execPath} check.cjs`,
            workingDirectory: ".", executionMethod: "開発コンテナ内で対象worktreeのcheck.cjsを実行", evidence: "AGENTS.md", required: true }], undetectedValidation: [], blockers: [] } };
        if (phase === "implementation" || phase === "fix") {
          if (behavior.implementation) await writeFile(join(worktree, "result.txt"), phase === "implementation" && behavior.failValidation ? "bad" : "ok");
          output ??= { summary: "入力検証", validation: [], validationPlanUpdates: [], remainingIssues: [], blockers: [] };
        }
        if (phase === "review") output ??= { summary: "レビュー", findings: behavior.failValidation && phases.filter(p => p === "review").length === 1
          ? [{ severity: "major", description: "入力検証がcheck.cjsの終了7となる", validationCommandIds: ["test"], location: "result.txt" }] : [], unverifiedItems: [], blockers: [] };
        if (phase === "report") output ??= { summary: "入力検証を追加", changes: ["入力検証"],
          acceptanceCriteria: [{ criterion: "check.cjsが成功すること", result: "確認済み", evidence: "正式検証test成功・最終Review" }] };
        if (phase === "commit") {
          const paths = (await runGit(worktree, ["diff", "--name-only", "--no-renames", "-z", "HEAD", await captureWorktreeTree(worktree)])).split("\0").filter(Boolean);
          output ??= { summary: "入力検証", commits: paths.length ? [{ message: "🐛 入力検証", paths }] : [], blockers: [] };
        }
        yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: JSON.stringify(output) } };
        yield { type: "turn.completed", usage };
      })() };
    } }; return t;
  };
  const connection = async (path: string): Promise<PhaseConnection> => {
    worktree = path;
    return { start: () => thread(null, `thread-${++threadCount}`), resume: id => thread(id, id) };
  };
  const store = () => new RunStore(newRunId(), harness);
  const run = (s = store(), reference = "a/b#1") => runIssueWorkflow({ store: s, config: config(), env: { WRITE: "private-write", READ: "private-read" },
    issue: reference, repositoryPath: repo, git: runGit, api, transport, connection });
  return { root, repo, bare, harness, base, calls, prompts, phases, routes, behavior, api, store, run, connection, transport,
    labels: () => labels, resetComments: () => { comments = []; }, setLabels: (v: string[]) => { labels = v; routes.set("/repos/a/b/issues/1", issue(1, { labels })); }, worktree: () => worktree };
}

it("親の内容で命名した子の成果報告を依存証拠に使い、後続子が同じ成果ブランチを継承する", async () => {
  const f = await fixture(), first = f.store();
  const parent = issue(9, { title: "ログイン全体の入力検証", body: "兄弟Issueで入力検証を完成する" });
  f.routes.set("/repos/a/b/issues/9", parent);
  f.routes.set("/repos/a/b/issues/9/parent", new GitHubError("request", null, 404, "no_parent_issue"));
  f.routes.set("/repos/a/b/issues/9/sub_issues?per_page=100", [issue(1), issue(2)]);
  const parentUrl = "https://api.github.com/repos/a/b/issues/9";
  f.routes.set("/repos/a/b/issues/1", issue(1, { parent_issue_url: parentUrl }));
  f.routes.set("/repos/a/b/issues/1/parent", parent);
  expect(await f.run(first)).toBe("completed");
  const old = await first.loadGitHubState(), saved = await readFile(join(first.runPath, "state.json"), "utf8");
  const report = await f.api.get<unknown[]>("/repos/a/b/issues/1/comments");
  expect(report).toHaveLength(1);
  f.routes.set("/repos/a/b/issues/1/comments?per_page=100", report);
  f.setLabels(["harness:enabled", "harness:ready", "unrelated"]);
  f.routes.set("/repos/a/b/issues/1", issue(1, { state: "closed", state_reason: "completed", parent_issue_url: parentUrl }));
  f.routes.set("/repos/a/b/issues/2", issue(2, { parent_issue_url: parentUrl }));
  f.routes.set("/repos/a/b/issues/2/parent", parent);
  f.routes.set("/repos/a/b/issues/2/dependencies/blocked_by?per_page=100", [issue(1)]);
  f.routes.set("/repos/a/b/collaborators/writer/permission", { permission: "write", user: { id: 1, login: "writer" } });
  // 最初の成果を元cloneへ手動で取り込む必要はない。後続子は公開済み共有成果を開始点にする。
  f.resetComments(); f.behavior.implementation = false; f.behavior.candidates = ["fix/rename-must-not-win"];
  f.routes.set("/repos/a/b/issues/1/comments", report);
  const next = f.store(), result = await f.run(next, "a/b#2");
  const state = await next.loadGitHubState(); expect(state.error).toBeNull(); expect(result).toBe("completed");
  expect(state.managementIssue.issueId).toBe("9"); expect(state.branchName).toBe(old.branchName);
  expect(state.baseCommit).toBe(old.resultCommits.at(-1)!); expect(state.worktreePath).not.toBe(old.worktreePath);
  expect(state.previousRunId).toBeNull(); expect(state.reviewThreadIds[0]).not.toBe(old.reviewThreadIds[0]);
  expect(f.prompts[0]).toContain(parent.body);
  expect(await readFile(join(first.runPath, "state.json"), "utf8")).toBe(saved);
  expect(f.calls.filter(c => c === "POST /repos/a/b/issues/2/comments")).toHaveLength(1);
  expect(f.calls.some(c => /(?:pulls|\/merge|PATCH .*\/issues\/\d+$)/.test(c))).toBe(false);
  // 後続子は変更不要なので、公開済みHEADへの重複pushを行わない。
  expect(f.calls.filter(c => c === "push")).toHaveLength(1);
});

it("使用する対応記録の破損では外部更新・Planを始めず、公開成果と過去runを保全する", async () => {
  const f = await fixture(), first = f.store(); expect(await f.run(first)).toBe("completed");
  const old = await first.loadGitHubState(), saved = await readFile(join(first.runPath, "state.json"), "utf8");
  const remote = await runGit(f.repo, ["ls-remote", f.bare, `refs/heads/${old.branchName}`]);
  await writeFile(old.branchRecordPath!, "{broken"); f.setLabels(["harness:enabled", "harness:ready"]);
  const callStart = f.calls.length, phaseStart = f.phases.length, next = f.store();
  expect(await f.run(next)).toBe("stopped");
  expect(f.phases.slice(phaseStart)).toEqual([]);
  expect(f.calls.slice(callStart).some(c => /^(POST|DELETE|push)/.test(c))).toBe(false);
  expect(await runGit(f.repo, ["ls-remote", f.bare, `refs/heads/${old.branchName}`])).toBe(remote);
  expect(await readFile(join(first.runPath, "state.json"), "utf8")).toBe(saved);
  expect(await readFile(old.branchRecordPath!, "utf8")).toBe("{broken");
});

it("Issue→Plan→対応保存→running確認→正式検証→独立Review→commit→push→報告→reviewで正常終了", async () => {
  const f = await fixture(), store = f.store();
  f.behavior.during = async phase => {
    if (phase === "plan") expect(f.calls.some(c => c.startsWith("POST"))).toBe(false);
    if (phase === "implementation") {
      expect(f.labels()).toEqual(["harness:enabled", "unrelated", "harness:running"]);
      const state = await store.loadGitHubState(); expect(state.startTransition).toBe("succeeded"); expect(state.branchName).toBe("fix/login-validation");
      expect((await new BranchStore(f.harness).read(state.managementIssue))?.creationStatus).toBe("created");
    }
  };
  expect(await f.run(store)).toBe("completed");
  const state = await store.loadGitHubState();
  expect(state.schemaVersion).toBe(2); expect(state.phase).toBe("review_state"); expect(state.error).toBeNull();
  expect(state.resultCommits).toHaveLength(1); expect(state.stopReflection.status).toBe("not_started");
  expect(f.phases).toEqual(["plan", "implementation", "review", "commit", "report"]);
  expect(f.labels()).toEqual(["harness:enabled", "unrelated", "harness:review"]);
  expect(f.calls.indexOf("push")).toBeLessThan(f.calls.indexOf("POST /repos/a/b/issues/1/comments"));
  expect((await store.loadArtifact("verification", 1)).commands[0]?.status).toBe("passed");
  expect(state.reviewThreadIds[0]).not.toBe(state.codexThreadId);
  expect(await runGit(state.worktreePath!, ["status", "--porcelain"])).toBe("");
  expect(await readdir(f.harness)).not.toContain("locks");
});

it.each([
  { labels: ["harness:ready"] }, { labels: ["harness:enabled", "harness:ready", "harness:running"] }, { state: "closed" },
])("着手条件不成立ではPlanもGit準備も外部更新も行わない: %j", async overrides => {
  const f = await fixture(), store = f.store(); f.routes.set("/repos/a/b/issues/1", issue(1, overrides));
  expect(await f.run(store)).toBe("stopped"); expect(f.phases).toEqual([]);
  expect(f.calls.some(c => /^(POST|DELETE|fetch|ls-remote)/.test(c))).toBe(false);
  expect((await store.loadGitHubState()).worktreePath).toBeNull();
});

it("取得失敗と資料上限ではIssueを変更せず、判明した取得場所と理由を保存", async () => {
  const f = await fixture(), store = f.store(); f.routes.set("/repos/a/b/issues/1", new GitHubError("permission"));
  expect(await f.run(store)).toBe("stopped"); expect(f.phases).toEqual([]);
  expect(JSON.parse(await readFile(join(store.artifactsPath, "prepare-failure.json"), "utf8")).error).toContain("permission");
  expect(f.calls.some(c => /^(POST|DELETE)/.test(c))).toBe(false);
  const g = await fixture(), s = g.store(), cfg = config(); cfg.github.maxContextBytes = 1;
  expect(await runIssueWorkflow({ store: s, config: cfg, env: { WRITE: "private-write", READ: "private-read" }, issue: "a/b#1", api: g.api })).toBe("stopped");
  expect(JSON.parse(await readFile(join(s.artifactsPath, "prepare-failure.json"), "utf8")).error).toContain("limit");
});

it("着手前Planのblockersではreadyを保持し、着手後はblockedと理由・選択肢・推奨を記録", async () => {
  for (const phase of ["plan", "implementation"]) {
    const f = await fixture(), s = f.store();
    f.behavior.output = p => p === phase ? phase === "plan" ? { branchName: null,
      plan: { summary: "判断待ち", steps: [], validationPlan: [], undetectedValidation: [], blockers: ["入力仕様の選択が必要 private-write"] } }
      : { summary: "判断待ち", validation: [], validationPlanUpdates: [], remainingIssues: [], blockers: ["入力仕様の選択が必要 private-write"] } : null;
    expect(await f.run(s)).toBe("blocked");
    if (phase === "plan") { expect(f.labels()).toContain("harness:ready"); expect(f.calls.some(c => c.startsWith("POST"))).toBe(false); }
    else {
      expect(f.labels()).toContain("harness:blocked"); const intent = await readFile(join(s.artifactsPath, "blocked-comment-intent.json"), "utf8");
      expect(intent).toContain("選択肢"); expect(intent).toContain("推奨"); expect(intent).not.toContain("private-write");
    }
  }
});

it("途中の本文・enabled変更を追跡せず、着手時文脈で検証失敗→Review→Fixする", async () => {
  const f = await fixture(), s = f.store(); f.behavior.failValidation = true;
  f.behavior.during = async phase => {
    if (phase === "implementation") { f.setLabels(["harness:running", "unrelated"]); f.routes.set("/repos/a/b/issues/1", issue(1, { body: "変更後" })); }
  };
  expect(await f.run(s)).toBe("completed");
  expect(f.phases).toEqual(["plan", "implementation", "review", "fix", "review", "commit", "report"]);
  const state = await s.loadGitHubState(); expect(state.fixCount).toBe(1);
  expect((await s.loadArtifact("verification", 1)).commands[0]?.status).toBe("failed");
  expect((await s.loadArtifact("verification", 2)).commands[0]?.status).toBe("passed");
  expect(f.prompts.at(-1)).not.toContain("変更後"); expect(f.labels()).not.toContain("harness:enabled");
});

it("命名不正を再Planし、同じ応答の計画とセッションを採用", async () => {
  const f = await fixture(), s = f.store(); f.behavior.candidates = ["issue-1", "fix/login-validation"];
  expect(await f.run(s)).toBe("completed"); const state = await s.loadGitHubState();
  expect(f.phases.filter(p => p === "plan")).toHaveLength(2);
  expect(state.codexThreadId).toBe((await s.loadArtifact("plan-session", 2)).threadId);
  expect(f.prompts[1]).toContain("英語ケバブ"); expect(state.resultCommits).toHaveLength(1);
});

it("同Issueの未push・dirtyを保持して新run/new Planを行い、累積diffと旧検証を新Reviewへ渡す", async () => {
  const f = await fixture(), first = f.store();
  f.behavior.beforeTransport = async op => { if (op === "push") throw new GitHubError("permission"); };
  expect(await f.run(first)).toBe("stopped");
  f.behavior.beforeTransport = async () => {};
  const old = await first.loadGitHubState(), saved = await readFile(join(first.runPath, "state.json"), "utf8");
  await writeFile(join(old.worktreePath!, "extra.txt"), "前回後の未追跡変更");
  f.setLabels(["harness:enabled", "harness:ready", "unrelated"]); const second = f.store();
  expect(await f.run(second)).toBe("completed"); const next = await second.loadGitHubState();
  expect(next.previousRunId).toBe(first.runId); expect(next.worktreePath).toBe(old.worktreePath); expect(next.baseCommit).toBe(f.base);
  expect(next.error).toBeNull(); expect(next.codexThreadId).not.toBe(old.codexThreadId); expect(next.resultCommits).toHaveLength(2);
  expect((await second.loadReviewInput(1)).diff).toContain("extra.txt");
  expect((await second.loadReviewInput(1)).diff).toContain("+ok");
  expect(f.prompts.findLast(p => p.startsWith("plan"))).toContain("verification-1.json");
  expect(await readFile(join(first.runPath, "state.json"), "utf8")).toBe(saved);
});

it("変更不要の再実行も空commitを作らず、新しい正式検証・Reviewを実施", async () => {
  const f = await fixture(), first = f.store(); await f.run(first); const old = await first.loadGitHubState();
  f.setLabels(["harness:enabled", "harness:ready"]); f.behavior.implementation = false;
  const second = f.store(); expect(await f.run(second)).toBe("completed"); const next = await second.loadGitHubState();
  expect(next.error).toBeNull(); expect(next.resultCommits).toEqual(old.resultCommits); expect(next.reviewThreadIds[0]).not.toBe(old.reviewThreadIds[0]);
  expect(next.status).toBe("completed");
});

it("既存成果のnet-zeroパスを含む再実行でも、今回レビューした削除をコミットできる", async () => {
  const f = await fixture(), first = f.store(); await f.run(first); const previous = await first.loadGitHubState();
  await writeFile(join(f.worktree(), "previous.txt"), "過去成果"); await runGit(f.worktree(), ["add", "."]);
  await runGit(f.worktree(), ["commit", "-m", "previous"]);
  f.setLabels(["harness:enabled", "harness:ready"]);
  f.behavior.during = async phase => { if (phase === "implementation") await unlink(join(f.worktree(), "previous.txt")); };
  const next = f.store(); expect(await f.run(next)).toBe("completed"); const state = await next.loadGitHubState();
  expect(state.error).toBeNull(); expect(state.resultCommits).toHaveLength(previous.resultCommits.length + 2);
  expect((await next.loadReviewInput(1)).diff).not.toContain("previous.txt");
});

it("commit工程で未レビューのファイルを追加・削除して最終treeを戻しても拒否する", async () => {
  const f = await fixture(), s = f.store();
  f.behavior.during = async phase => {
    if (phase !== "commit") return;
    await runGit(f.worktree(), ["add", "."]); await runGit(f.worktree(), ["commit", "-m", "reviewed"]);
    await writeFile(join(f.worktree(), "unreviewed.txt"), "未レビュー"); await runGit(f.worktree(), ["add", "."]);
    await runGit(f.worktree(), ["commit", "-m", "unreviewed"]); await unlink(join(f.worktree(), "unreviewed.txt"));
    await runGit(f.worktree(), ["add", "-A"]); await runGit(f.worktree(), ["commit", "-m", "remove unreviewed"]);
  };
  expect(await f.run(s)).toBe("stopped"); const state = await s.loadGitHubState();
  expect(state.resultCommits).toEqual([]); expect(state.error?.message).toContain("レビュー前のcommitまたは履歴・ブランチ変更を検出");
  expect((await runGit(f.worktree(), ["rev-parse", "HEAD^{tree}"])).trim()).toBe(state.reviewedTreeId!);
});

it("ラベル更新応答不明を照合し、残操作だけ実行して無関係なラベルを保持", async () => {
  const f = await fixture(), s = f.store(); f.behavior.unknown = true;
  expect(await f.run(s)).toBe("completed"); expect((await s.loadGitHubState()).resultCommits).toHaveLength(1);
  expect(f.calls.filter(c => c === "POST /repos/a/b/issues/1/labels")).toHaveLength(2);
  expect(f.labels()).toContain("unrelated");
});

it("着手ラベル更新の途中失敗は開発せず停止し、中間ラベルと成果物を保全", async () => {
  const f = await fixture(), s = f.store();
  f.behavior.update = async method => { if (method === "DELETE") throw new GitHubError("permission"); };
  expect(await f.run(s)).toBe("stopped"); expect(f.phases).toEqual(["plan"]);
  expect(f.labels()).toContain("harness:ready"); expect(f.labels()).toContain("harness:running");
  expect((await s.loadGitHubState()).startTransition).toBe("failed");
});

it("停止反映失敗でも先にローカル停止し途中変更を保持", async () => {
  const f = await fixture(), s = f.store();
  f.behavior.during = async phase => {
    if (phase !== "implementation") return;
    await writeFile(join(f.worktree(), "partial.txt"), "保持");
    f.behavior.update = async () => { expect((await s.loadGitHubState()).status).toBe("stopped"); throw new GitHubError("permission"); };
    throw new WorkflowTestError();
  };
  expect(await f.run(s)).toBe("stopped"); const state = await s.loadGitHubState();
  expect(state.stopReflection.status).toBe("failed"); expect(await readFile(join(f.worktree(), "partial.txt"), "utf8")).toBe("保持");
});
it("レート制限中は停止反映や理由投稿も行わず、再アクセス時刻を保持", async () => {
  const f = await fixture(), first = f.store(); await f.run(first);
  const s = f.store(), state = { ...await first.loadGitHubState(), runId: s.runId, status: "running" as const };
  await s.createGitHub(state); f.setLabels(["harness:enabled", "harness:running"]);
  const count = f.calls.length, control = new GitHubControl(s, state, f.api, config(), []);
  await expect(control.stop(new GitHubError("rate_limit", "2099-01-01T00:00:00.000Z"), "test")).rejects.toBeInstanceOf(GitHubWorkflowStopped);
  expect(f.calls).toHaveLength(count);
  const stopped = await s.loadGitHubState(); expect(stopped.status).toBe("stopped");
  expect(stopped.stopReflection.status).toBe("failed"); expect(stopped.error?.message).toContain("2099-01-01");
});
class WorkflowTestError extends Error {}

it("保存失敗でも開発を停止し、ローカル停止の未保存を戻り値で成功にしない", async () => {
  const f = await fixture(), s = f.store();
  f.behavior.during = async phase => {
    if (phase === "implementation") {
      await writeFile(join(f.worktree(), "partial.txt"), "保持");
      s.saveGitHubState = async () => { throw new Error("disk full"); };
    }
  };
  expect(await f.run(s)).toBe("stopped"); expect(f.phases).toEqual(["plan", "implementation"]);
  expect(await readFile(join(f.worktree(), "partial.txt"), "utf8")).toBe("保持");
});

it("ラベル遷移の矛盾を拒否し、既知の二状態から残操作を再送せず完了", async () => {
  const f = await fixture(), s = f.store(); await s.initializeGitHub();
  f.setLabels(["harness:enabled", "harness:ready", "harness:running", "unrelated"]);
  await transitionIssueLabels(f.api, s, { repository: "a/b", number: 1, url: "https://github.com/a/b/issues/1" }, config().github.labels, "ready", "running", "test");
  expect(f.calls.filter(c => c.startsWith("POST"))).toHaveLength(0); expect(f.labels()).toContain("unrelated");
  f.setLabels(["harness:blocked"]);
  await expect(transitionIssueLabels(f.api, s, { repository: "a/b", number: 1, url: "https://github.com/a/b/issues/1" }, config().github.labels, "ready", "running", "other")).rejects.toThrow("unknown");
});

it.each([false, true])("ラベル全ページの状態集合を確認する（次ページの矛盾: %s）", async conflict => {
  const f = await fixture(), s = f.store(); await s.initializeGitHub();
  const unrelated = Array.from({ length: 35 }, (_, i) => `label-${i}`);
  f.setLabels(conflict ? ["harness:ready", "harness:enabled", ...unrelated, "harness:blocked"]
    : [...unrelated, "harness:ready", "harness:enabled"]);
  const paged: IssueWriteApi = { ...f.api,
    get: async <T>(endpoint: string): Promise<T> => (await f.api.get<unknown[]>(endpoint)).slice(0, 30) as T,
    getPages: endpoint => f.api.getPages(endpoint),
  };
  const run = () => transitionIssueLabels(paged, s, { repository: "a/b", number: 1, url: "https://github.com/a/b/issues/1" }, config().github.labels, "ready", "running", "pages");
  if (conflict) {
    await expect(run()).rejects.toThrow("unknown"); expect(f.calls.some(c => c.startsWith("POST"))).toBe(false);
  } else {
    await run(); expect(f.labels()).toContain("harness:running"); expect(f.labels()).not.toContain("harness:ready");
    expect(unrelated.every(l => f.labels().includes(l))).toBe(true);
  }
});

it("手動CLIはURL/短縮表記・設定2を使い、未定義オプション・不正識別子を拒否する", async () => {
  const f = await fixture(); await mkdir(f.harness); await writeFile(join(f.harness, "config.json"), JSON.stringify(config()));
  await mkdir(join(f.harness, "locks")); await writeFile(join(f.harness, "locks", "stale.lock"), "broken");
  let output = "", runs = 0;
  const opts = { root: f.harness, cwd: f.root, env: { WRITE: "private-write", READ: "private-read" }, stdout: (v: string) => { output += v; }, stderr: (v: string) => { output += v; },
    issueRun: async (o: Parameters<typeof runIssueWorkflow>[0]): Promise<"stopped"> => { runs++; expect(o.config.schemaVersion).toBe(2); return "stopped"; } };
  for (const ref of ["a/b#1", "https://github.com/a/b/issues/1"]) expect(await executeCli(["run", ref, "--no-progress"], opts)).toBe(1);
  expect(runs).toBe(2);
  expect(await executeCli(["run", "a/b#1", "--branch", "fix/custom"], opts)).toBe(2); expect(output).toContain("引数または設定エラー");
  expect(await executeCli(["run", "1"], opts)).toBe(2); expect(output).toContain("Issue URLまたはowner/repo#番号"); expect(runs).toBe(2);
});

it.each(["parent", "dependency", "source"])("%sの事前条件不備ではIssue状態とworktreeを変更しない", async mode => {
  const f = await fixture(), s = f.store(), cfg = config();
  if (mode === "parent") f.routes.set("/repos/a/b/issues/1/sub_issues?per_page=100", [issue(2, { state: "closed", state_reason: "completed" })]);
  if (mode === "dependency") {
    f.routes.set("/repos/a/b/issues/1/dependencies/blocked_by?per_page=100", [issue(2)]);
    f.routes.set("/repos/a/b/issues/2", issue(2));
  }
  if (mode === "source") cfg.repositories["a/b"] = { pushRemote: "origin", requiredSources: [{ kind: "file", path: "missing.md" }] };
  expect(await runIssueWorkflow({ store: s, config: cfg, env: { WRITE: "private-write", READ: "private-read" }, issue: "a/b#1",
    repositoryPath: f.repo, git: runGit, api: f.api, transport: f.transport, connection: f.connection })).toBe("stopped");
  expect(f.phases).toEqual([]); expect(f.calls.some(c => /^(POST|DELETE)/.test(c))).toBe(false);
  expect((await s.loadGitHubState()).worktreePath).toBeNull();
});

it("初回baseと再実行HEADを区別しても、Implementation中の先行commitは拒否", async () => {
  const f = await fixture(), s = f.store();
  f.behavior.during = async phase => {
    if (phase === "implementation") {
      await writeFile(join(f.worktree(), "early.txt"), "早期コミット");
      await runGit(f.worktree(), ["add", "."]); await runGit(f.worktree(), ["commit", "-m", "early"]);
    }
  };
  expect(await f.run(s)).toBe("stopped"); expect(f.phases).toEqual(["plan", "implementation"]);
  expect((await s.loadGitHubState()).error?.message).toContain("レビュー前のcommit");
  expect(await readFile(join(f.worktree(), "early.txt"), "utf8")).toBe("早期コミット");
});

it("Review/Fix上限でもblocked処理に接続し、4回目以降のReviewやcommitは実行しない", async () => {
  const f = await fixture(), s = f.store();
  f.behavior.output = phase => phase === "review" ? { summary: "確認不足", findings: [], unverifiedItems: ["完了条件の根拠が不足"], blockers: [] } : null;
  expect(await f.run(s)).toBe("blocked");
  const state = await s.loadGitHubState(); expect(state.fixCount).toBe(3); expect(state.reviewThreadIds).toHaveLength(4);
  expect(f.phases.filter(p => p === "fix")).toHaveLength(3); expect(f.phases).not.toContain("commit"); expect(f.labels()).toContain("harness:blocked");
});

it.each(["unknown", "storage"])("公開CLIでも%sを成功にせず、停止理由・反映/記録失敗と場所を表示する", async mode => {
  const f = await fixture(); await mkdir(f.harness); await writeFile(join(f.harness, "config.json"), JSON.stringify(config()));
  let active: RunStore, output = "";
  f.behavior.during = async phase => {
    if (phase !== "implementation") return;
    await writeFile(join(f.worktree(), "partial.txt"), "保持");
    if (mode === "unknown") { f.behavior.update = async () => { throw new GitHubError("unknown"); }; throw new WorkflowTestError(); }
    active.saveGitHubState = async () => { throw new Error("disk full"); };
  };
  expect(await executeCli(["run", "a/b#1", "--repo", f.repo, "--no-progress"], {
    root: f.harness, env: { WRITE: "private-write", READ: "private-read" }, stdout: v => { output += v; }, stderr: v => { output += v; },
    issueRun: o => { active = o.store; return runIssueWorkflow({ ...o, api: f.api, git: runGit, transport: f.transport, connection: f.connection }); },
  })).toBe(1);
  expect(f.phases, JSON.stringify({ calls: f.calls, state: await active!.loadGitHubState() })).toContain("implementation");
  expect(output).toContain("停止状態: stopped"); expect(output).toContain("記録:");
  expect(output).toContain(mode === "unknown" ? "GitHub停止反映: unknown" : "記録保存に失敗");
  expect(await readFile(join(f.worktree(), "partial.txt"), "utf8")).toBe("保持");
  expect(output).not.toMatch(/private-write|private-read/);
});

async function submission(store: RunStore) {
  return submissionSchema.parse(JSON.parse(await readFile(join(store.artifactsPath, "submission.json"), "utf8")));
}

it("三段階の期待値・観測値と固定差分リンク、通常成果コメントの依存証拠が整合する", async () => {
  const f = await fixture(), s = f.store(); expect(await f.run(s)).toBe("completed");
  const state = await s.loadGitHubState(), result = await submission(s), head = state.resultCommits.at(-1)!;
  expect([result.push.status, result.comment.status, result.reviewState.status]).toEqual(["succeeded", "succeeded", "succeeded"]);
  expect(result.push.expected.startCommit).toBeNull(); expect(result.push.observed?.afterCommit).toBe(head);
  expect(result.comment.observed?.commentId).toBe("1"); expect(result.reviewState.observed?.states).toEqual(["review"]);
  const body = await readFile(join(s.artifactsPath, "report.md"), "utf8");
  for (const text of ["変更要約", "完了条件", "正式検証", "独立レビュー", "未検証", s.runId, state.branchName!, head,
    `https://github.com/a/b/compare/${f.base}...${head}`, "harness-result:v2"]) expect(body).toContain(text);
  f.routes.set("/repos/a/b/issues/1", issue(1, { state: "closed", state_reason: "completed" }));
  f.routes.set("/repos/a/b/collaborators/writer/permission", { permission: "write", user: { id: 1, login: "writer" } });
  const document = await new IssueReader(f.api).document({ repository: "a/b", number: 1, url: "https://github.com/a/b/issues/1" });
  const decision = await evaluateDependency(f.api, document, "writer", head, gitInclusion(f.repo, runGit));
  expect(decision.status).toBe("satisfied");
  const record = await new BranchStore(f.harness).read(state.managementIssue);
  expect(record?.localTip).toBe(head); expect(record?.remoteTip).toBe(head);
  expect(f.calls.filter(c => c === "POST /repos/a/b/issues/1/comments")).toHaveLength(1);
});

it("成果マーカー自体を説明する通常の報告でも、機械可読マーカーは一件だけ生成する", async () => {
  const f = await fixture(), s = f.store();
  f.behavior.output = phase => phase === "report" ? { summary: "`<!-- harness-result:v2` を実装",
    changes: ["<!-- harness-result:v2 を追加"], acceptanceCriteria: [{ criterion: "<!-- harness-result:v2の整合", result: "確認済み", evidence: "<!-- harness-result:v2の依存判定テスト" }] } : null;
  expect(await f.run(s)).toBe("completed");
  const body = await readFile(join(s.artifactsPath, "report.md"), "utf8");
  expect(body.match(/<!-- harness-result:/g)).toHaveLength(1);
  expect(body).toContain("&lt;!-- harness-result:v2");
  f.routes.set("/repos/a/b/issues/1", issue(1, { state: "closed", state_reason: "completed" }));
  f.routes.set("/repos/a/b/collaborators/writer/permission", { permission: "write", user: { id: 1, login: "writer" } });
  const document = await new IssueReader(f.api).document({ repository: "a/b", number: 1, url: "https://github.com/a/b/issues/1" });
  expect((await evaluateDependency(f.api, document, "writer", (await s.loadGitHubState()).resultCommits.at(-1)!, gitInclusion(f.repo, runGit))).status).toBe("satisfied");
});

it("push済みで変更不要の再実行は新runで検証し、pushを再送せず新しい成果コメントを一件追加", async () => {
  const f = await fixture(), first = f.store(); expect(await f.run(first)).toBe("completed");
  const head = (await first.loadGitHubState()).resultCommits.at(-1)!;
  f.setLabels(["harness:enabled", "harness:ready", "unrelated"]); f.behavior.implementation = false;
  const second = f.store(); expect(await f.run(second)).toBe("completed");
  const result = await submission(second);
  expect(result.push.expected.startCommit).toBe(head); expect(result.push.attempts).toBe(0);
  expect(result.push.observed?.alreadyPublished).toBe(true);
  expect(result.comment.observed?.commentId).toBe("2");
  expect(f.calls.filter(c => c === "push")).toHaveLength(1);
  expect(f.phases.filter(p => p === "review")).toHaveLength(2);
});

it("初回からコード変更不要でも既存HEADを成果として公開し、空commitや成果不要の偽装を行わない", async () => {
  const f = await fixture(), s = f.store();
  await writeFile(join(f.repo, "result.txt"), "ok"); await runGit(f.repo, ["add", "."]); await runGit(f.repo, ["commit", "-m", "already implemented"]);
  await runGit(f.repo, ["push", f.bare, "main"]); f.behavior.implementation = false;
  expect(await f.run(s)).toBe("completed");
  const state = await s.loadGitHubState(); expect(state.resultCommits).toEqual([state.baseCommit!]);
  const report = JSON.parse(await readFile(join(s.artifactsPath, "report.json"), "utf8"));
  expect(report.result.noCommitRequired).toBe(false); expect(report.result.headCommit).toBe(state.baseCommit);
});

it("reviewラベル追加後の応答不明と照合レート制限はunknownを記録し、追加アクセスしない", async () => {
  const f = await fixture(), s = f.store(), original = f.api.getPages.bind(f.api); let submitted = false;
  f.behavior.unknown = true;
  f.behavior.afterUpdate = async (_method, endpoint) => { if (endpoint.endsWith("/labels") && f.phases.includes("report")) submitted = true; };
  f.api.getPages = async <T>(endpoint: string): Promise<T[]> => {
    if (submitted && endpoint.endsWith("/labels")) throw new GitHubError("rate_limit", "2099-01-01T00:00:00.000Z");
    return original<T>(endpoint);
  };
  expect(await f.run(s)).toBe("stopped"); const result = await submission(s);
  expect(result.reviewState.status).toBe("unknown"); expect(result.reviewState.retryAfter).toBe("2099-01-01T00:00:00.000Z");
  expect(f.labels()).toContain("harness:review"); expect(f.labels()).toContain("harness:running");
  expect((await s.loadGitHubState()).stopReflection.status).toBe("failed");
});

it.each(["remote", "destination", "local-ref"])("提出直前の%s変更ではpush・報告を行わず成果を保持", async mode => {
  const f = await fixture(), s = f.store();
  f.behavior.during = async phase => {
    if (phase !== "report") return;
    if (mode === "remote") await runGit(f.repo, ["push", f.bare, `${f.base}:refs/heads/fix/login-validation`]);
    if (mode === "destination") await runGit(f.repo, ["remote", "set-url", "--push", "origin", "https://github.com/other/repo.git"]);
    if (mode === "local-ref") await runGit(f.repo, ["update-ref", "refs/heads/fix/login-validation", (await runGit(f.worktree(), ["rev-parse", "HEAD"])).trim()]);
  };
  expect(await f.run(s)).toBe("stopped"); const state = await s.loadGitHubState(), result = await submission(s);
  expect(state.resultCommits).toHaveLength(1); expect(result.push.status).toBe("failed");
  expect(result.comment.status).toBe("not_started"); expect(f.calls).not.toContain("push");
  expect(await runGit(f.worktree(), ["status", "--porcelain"])).toBe("");
});

it.each(["applied", "absent", "other", "unreadable"])("push応答不明をremote SHAで照合する: %s", async mode => {
  const f = await fixture(), s = f.store(); let attempted = false;
  f.behavior.beforeTransport = async op => {
    if (op === "ls-remote" && attempted && mode === "unreadable") throw new GitHubError("transport");
    if (op !== "push") return;
    attempted = true;
    if (mode === "absent" || mode === "other") {
      if (mode === "other") await runGit(f.repo, ["push", f.bare, `${f.base}:refs/heads/fix/login-validation`]);
      throw new GitHubError("unknown");
    }
  };
  f.behavior.afterTransport = async op => { if (op === "push") throw new GitHubError("unknown"); };
  expect(await f.run(s)).toBe(mode === "applied" ? "completed" : "stopped");
  const result = await submission(s);
  expect(f.calls.filter(c => c === "push")).toHaveLength(1);
  expect(result.push.status).toBe(mode === "applied" ? "succeeded" : mode === "absent" ? "failed" : "unknown");
  expect(result.comment.status).toBe(mode === "applied" ? "succeeded" : "not_started");
});

it("通常FF pushが競合で拒否されたら、他者コミットもローカル成果も保持して停止", async () => {
  const f = await fixture(), s = f.store();
  f.behavior.beforeTransport = async op => {
    if (op !== "push") return;
    await writeFile(join(f.repo, "other.txt"), "他者変更"); await runGit(f.repo, ["add", "."]);
    await runGit(f.repo, ["commit", "-m", "other"]); await runGit(f.repo, ["push", f.bare, "HEAD:refs/heads/fix/login-validation"]);
  };
  expect(await f.run(s)).toBe("stopped");
  expect((await submission(s)).push.status).toBe("unknown");
  expect((await submission(s)).comment.status).toBe("not_started");
  expect((await runGit(f.bare, ["rev-parse", "refs/heads/fix/login-validation"])).trim()).not.toBe((await s.loadGitHubState()).resultCommits.at(-1)!);
  expect(f.calls.filter(c => c === "push")).toHaveLength(1);
});

it.each(["matched", "missing", "different", "multiple", "unreadable"])("コメント応答不明では全件照合し再投稿しない: %s", async mode => {
  const f = await fixture(), s = f.store(), original = f.api.getPages.bind(f.api); let posted = false;
  f.behavior.unknown = true;
  f.behavior.afterUpdate = async (_method, endpoint) => { if (endpoint.endsWith("/comments")) posted = true; };
  f.api.getPages = async <T>(endpoint: string): Promise<T[]> => {
    const values = await original<T>(endpoint);
    if (!endpoint.endsWith("/comments") || !posted) return values;
    if (mode === "missing") return [];
    if (mode === "unreadable") throw new GitHubError("transport");
    if (mode === "multiple") return [...values, ...values];
    if (mode === "different") return values.map(v => ({ ...v as object, body: `異なる本文 ${s.runId}` }) as T);
    return values;
  };
  expect(await f.run(s)).toBe(mode === "matched" ? "completed" : "stopped");
  const result = await submission(s);
  expect(result.push.status).toBe("succeeded"); expect(result.comment.status).toBe(mode === "matched" ? "succeeded" : "unknown");
  expect(result.reviewState.status).toBe(mode === "matched" ? "succeeded" : "not_started");
  expect(f.calls.filter(c => c === "POST /repos/a/b/issues/1/comments")).toHaveLength(1);
});

it.each(["comment", "reviewState"])("%sのレート制限は再アクセス時刻と部分成功を保存し停止反映も控える", async mode => {
  const f = await fixture(), s = f.store();
  f.behavior.update = async (_method, endpoint) => {
    if (mode === "comment" ? endpoint.endsWith("/comments") : endpoint.endsWith("/labels") && f.phases.includes("report"))
      throw new GitHubError("rate_limit", "2099-01-01T00:00:00.000Z");
  };
  expect(await f.run(s)).toBe("stopped"); const result = await submission(s);
  expect(result.push.status).toBe("succeeded"); expect(result[mode].retryAfter).toBe("2099-01-01T00:00:00.000Z");
  expect(result.comment.status).toBe(mode === "comment" ? "failed" : "succeeded");
  expect(f.labels()).toContain("harness:running");
});

it.each(["push", "comment", "reviewState"])("%s反映後の記録失敗は次へ進まずunknownを保存し、公開成果を取り消さない", async mode => {
  const f = await fixture(), s = f.store(), save = s.saveSubmission.bind(s); let failed = false;
  s.saveSubmission = async value => {
    if (!failed && (value as Record<string, { status: string }>)[mode]?.status === "succeeded") { failed = true; throw new Error("disk full"); }
    return save(value);
  };
  expect(await f.run(s)).toBe("stopped"); const result = await submission(s);
  expect(failed).toBe(true); expect(result[mode as keyof typeof result].status).toBe("unknown");
  expect((await runGit(f.bare, ["rev-parse", "refs/heads/fix/login-validation"])).trim()).toBe((await s.loadGitHubState()).resultCommits.at(-1)!);
  if (mode === "push") expect(result.comment.status).toBe("not_started");
  if (mode === "comment") expect(result.reviewState.status).toBe("not_started");
});

it.each(["human", "no-commit"])("人間向け報告の全文例を既存の取得・依存判定へ渡せる: %s", async kind => {
  const f = await fixture(), s = f.store(); expect(await f.run(s)).toBe("completed");
  const state = await s.loadGitHubState(), head = state.resultCommits.at(-1)!;
  const template = await readFile(new URL(`../examples/github-result-${kind}.md`, import.meta.url), "utf8");
  const body = template.replaceAll("example/product", "a/b").replace('"issueNumber": 123', '"issueNumber": 1')
    .replaceAll("a".repeat(40), f.base).replaceAll("b".repeat(40), head);
  await f.api.update("POST", "/repos/a/b/issues/1/comments", { body });
  f.routes.set("/repos/a/b/issues/1", issue(1, { state: "closed", state_reason: "completed" }));
  f.routes.set("/repos/a/b/collaborators/writer/permission", { permission: "write", user: { id: 1, login: "writer" } });
  const document = await new IssueReader(f.api).document({ repository: "a/b", number: 1, url: "https://github.com/a/b/issues/1" });
  let checked = 0;
  const check = async (sha: string, start: string) => { checked++; return gitInclusion(f.repo, runGit)(sha, start); };
  expect((await evaluateDependency(f.api, document, "different-harness", head, check)).status).toBe("satisfied");
  expect(checked).toBe(kind === "human" ? 3 : 0);
  document.issue.state = "open"; expect((await evaluateDependency(f.api, document, "different-harness", head, check)).status).toBe("waiting");
});

it("公開CLIは提出の部分成功と証拠の保存先を表示し、終了コード1で停止する", async () => {
  const f = await fixture(); await mkdir(f.harness); await writeFile(join(f.harness, "config.json"), JSON.stringify(config()));
  let output = "";
  f.behavior.update = async (_method, endpoint) => { if (endpoint.endsWith("/comments")) throw new GitHubError("permission"); };
  const code = await executeCli(["run", "a/b#1", "--repo", f.repo, "--no-progress"], {
    root: f.harness, env: { WRITE: "private-write", READ: "private-read" }, stdout: v => { output += v; }, stderr: v => { output += v; },
    issueRun: o => runIssueWorkflow({ ...o, api: f.api, git: runGit, transport: f.transport, connection: f.connection }),
  });
  expect(code).toBe(1); expect(output).toContain("push=succeeded, comment=failed, review=not_started");
  expect(output).toContain("submission.json"); expect(output).not.toMatch(/private-write|private-read/);
});
