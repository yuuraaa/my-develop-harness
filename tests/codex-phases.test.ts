import { TestPhases as CodexPhases } from "./helpers/phases.js";
import { testStateSchema as stateSchema } from "./helpers/issue-state.js";
import { WorkflowControl } from "./helpers/control.js";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import { mock, afterEach, describe, expect, it, jest } from "bun:test";
import { type PhaseConnection } from "../src/codex.js";
import { verifyImplementation } from "../src/verification.js";
import { runGit } from "../src/git.js";
import { RunStore, StorageError, newRunId, diffId } from "../src/state.js";
import { WorkflowError, WorkflowStopped } from "../src/workflow.js";
import { type IssueInput, type Verification } from "../src/schemas.js";

const dirs: string[] = [];
afterEach(async () => { jest.restoreAllMocks(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const command = { id: "test", kind: "test" as const, command: "docker compose exec -T dev npm test", workingDirectory: ".", executionMethod: "worktreeを/workspaceへmount", evidence: "package.json scripts.test", required: true };
const plan = { summary: "計画", steps: ["実装"], validationPlan: [command], undetectedValidation: ["lintなし"], blockers: [] as string[] };
const implementation = { summary: "変更", validation: [{ command: "npm test", status: "failed" as const, details: "参考結果" }], validationPlanUpdates: [{ operation: "update" as const, definition: { ...command, command: "docker compose exec -T dev npm test -- --run" }, reason: "オプション変更" }], remainingIssues: ["テスト失敗"], blockers: [] as string[] };
const review = { summary: "レビュー", findings: [{ severity: "major" as const, description: "修正必須", validationCommandIds: [], location: "src/a.ts" }], unverifiedItems: [], blockers: [] as string[] };
const issue = { id: "64", title: "検証用Issue", body: "要件と完了条件" };
const context: IssueInput = { issue: { ...issue, description: "要件", acceptanceCriteria: "完了条件" }, repositoryInstructions: ["AGENTS.md: 既存指示"] };
const usage = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 };
type Script = (id: string) => AsyncGenerator<ThreadEvent>;
function answer(output: unknown, action?: () => Promise<void>): Script {
  return async function* (id) {
    yield { type: "thread.started", thread_id: id };
    yield { type: "turn.started" };
    await action?.();
    yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: typeof output === "string" ? output : JSON.stringify(output && typeof output === "object" && "steps" in output ? { plan: output, branchName: null } : output) } };
    yield { type: "turn.completed", usage };
  };
}
async function setup(warningAfterMs = 60_000) {
  const dir = await mkdtemp(join(tmpdir(), "harness-phases-")); dirs.push(dir);
  const store = new RunStore(newRunId(), dir, ["read-secret", "write-secret"]);
  await mkdir(store.worktreePath, { recursive: true });
  await runGit(store.worktreePath, ["init", "-b", "feature/test"]);
  await writeFile(join(store.worktreePath, "a.txt"), "base\n");
  await runGit(store.worktreePath, ["add", "a.txt"]);
  await runGit(store.worktreePath, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  const baseCommit = (await runGit(store.worktreePath, ["rev-parse", "HEAD"])).trim();
  const state = stateSchema.parse({ schemaVersion: 2, runId: store.runId, issueId: issue.id,
    repositoryId: "github.com/test/repo", repositoryPath: store.worktreePath, branchName: "feature/test", worktreePath: store.worktreePath,
    baseCommit, phase: "plan", status: "running", phaseStatus: "pending", fixCount: 0, retryCount: {}, verificationArtifact: null,
    codexThreadId: null, reviewThreadIds: [], resultCommits: [], reviewedTreeId: null, error: null, updatedAt: new Date().toISOString() });
  await store.createGitHub(state);
  await store.saveArtifact("issue-input", context);
  const control = new WorkflowControl(store, state);
  const scripts: Script[] = [];
  const prompts: string[] = [];
  let newCount = 0;
  const thread = (initial: string | null, id: string) => ({ id: initial, runStreamed: jest.fn(async (prompt: string) => {
    prompts.push(prompt);
    const script = scripts.shift();
    if (!script) throw new Error("テストの応答不足");
    return { events: (async function* () {
      for await (const event of script(id)) {
        if (event.type === "thread.started") result.id = event.thread_id;
        yield event;
      }
    })() };
  }) });
  let result: ReturnType<typeof thread>;
  // 各generatorは自分のthreadを参照する。並行実行は製品側でも禁止。
  const connection: PhaseConnection = {
    start: jest.fn(() => { result = thread(null, `thread-${++newCount}`); return result; }),
    resume: jest.fn(id => { result = thread(id, id); return result; }),
  };
  const onBlock = jest.fn(async (_reasons: string[]) => {});
  const phases = new CodexPhases({ control, connection, block: async reasons => { await onBlock(reasons); return control.stop(new WorkflowError("blocker", reasons.join("\n")), "human_decision", "blocked"); }, warningAfterMs });
  const savedReview = async (attempt: number) => {
    const verification: Verification = { source: "harness", attempt, worktreePath: store.worktreePath, baseCommit, diffId: diffId("diff"),
      commands: [], validationPlan: [command], validationPlanUpdates: implementation.validationPlanUpdates, undetectedValidation: ["lintなし"] };
    await store.saveVerification(verification);
    await store.saveReviewInput({ attempt, issueInput: context, plan, implementation, verification, baseCommit, verificationArtifact: `verification-${attempt}.json` }, "diff");
    await control.recordPhase("verification", "succeeded");
  };
  return { store, control, scripts, phases, connection, onBlock, prompts, savedReview };
}
async function planned(f: Awaited<ReturnType<typeof setup>>) { f.scripts.push(answer(plan)); await f.phases.plan(context); }

// 実Gitと多数のfsyncを含むため、テスト実行側だけ余裕を持たせる。SDKに時間制限は設けない。
describe("Codexフェーズ（SDK/GitHubはテストダブル、Git・保存は実物）", () => {
  jest.setTimeout(15_000);
  it("不正更新のフィードバック後に全置換を採用し、検証は一度だけ実行する", async () => {
    const f = await setup(); await planned(f);
    const marker = join(f.store.runPath, "executions.txt");
    const valid = [{ operation: "update" as const, definition: { ...command, command: `printf x >> '${marker}'` }, reason: "検証対象" }];
    f.scripts.push(answer({ ...implementation, validationPlanUpdates: [
      { operation: "add", definition: { ...command, id: "extra" }, reason: "途中まで有効" },
      { operation: "remove", id: "unknown", reason: "誤削除" },
    ] }), answer({ validationPlanUpdates: valid }));
    expect(await f.phases.implementation(context)).toMatchObject({ validationPlanUpdates: valid });
    expect(f.prompts.at(-1)).toContain("ID=unknown");
    expect(f.prompts.at(-1)).toContain("remainingSubmissions");
    expect(f.connection.resume).toHaveBeenLastCalledWith("thread-1", true);
    await expect(readFile(marker, "utf8")).rejects.toThrow();
    expect(f.control.snapshot()).toMatchObject({ fixCount: 0, retryCount: {}, phase: "implementation", phaseStatus: "succeeded" });
    const submissions = await f.store.loadValidationSubmissions();
    expect(submissions.map(s => s.accepted)).toEqual([false, true]);
    const saved = await verifyImplementation(f.control);
    expect(saved.input.verification.validationPlan.map(d => d.id)).toEqual(["test"]);
    expect(saved.input.validationSubmissions).toEqual(submissions);
    expect(await readFile(marker, "utf8")).toBe("x");
    await expect(verifyImplementation(f.control)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(await readFile(marker, "utf8")).toBe("x");
  });
  it("構造不正の旧removeをID指定へ再提出し、実際の旧定義を保存", async () => {
    const f = await setup();
    const original = { ...command, id: "prepare-image", kind: "prepare" as const, command: "docker compose build", workingDirectory: "/old/worktree" };
    f.scripts.push(answer({ ...plan, validationPlan: [original] })); await f.phases.plan(context);
    const replacement = { ...original, workingDirectory: ".", command: "true" };
    f.scripts.push(answer({ ...implementation, validationPlanUpdates: [{ operation: "remove", definition: { ...original, command: "true", kind: "other" }, reason: "誤転記" }] }),
      answer({ validationPlanUpdates: [{ operation: "remove", id: original.id, reason: "cwd変更" }, { operation: "add", definition: replacement, reason: "必須準備の再登録" }] }));
    await f.phases.implementation(context);
    const { input } = await verifyImplementation(f.control);
    expect(input.verification.validationHistory?.[0]).toEqual({ operation: "remove", id: original.id, reason: "cwd変更", before: original, after: null });
    expect(await f.store.loadArtifact("validation-plan", 1)).toMatchObject({ validationHistory: input.verification.validationHistory });
    expect((await f.store.loadValidationSubmissions()).map(s => s.accepted)).toEqual([false, true]);
  });
  it("初回含む3回で停止し、診断と全候補を保持して検証を開始しない", async () => {
    const f = await setup(); await planned(f);
    const invalid = [{ operation: "remove", id: "unknown", reason: "存在しない" }];
    f.scripts.push(answer({ ...implementation, validationPlanUpdates: invalid }), answer({ validationPlanUpdates: invalid }), answer({ validationPlanUpdates: invalid }));
    await expect(f.phases.implementation(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.control.snapshot()).toMatchObject({ status: "stopped", fixCount: 0, retryCount: {}, error: { message: expect.stringContaining("初回含む3回") } });
    expect((await f.store.loadValidationSubmissions()).map(s => [s.submission, s.accepted])).toEqual([[1, false], [2, false], [3, false]]);
    expect(f.prompts).toHaveLength(4); // Plan + 初回 + 再提出2回
    await expect(f.store.loadArtifact("implementation", 1)).rejects.toThrow();
    await expect(f.store.loadArtifact("verification", 1)).rejects.toThrow();
    expect(f.onBlock).not.toHaveBeenCalled();
  });
  it("Fix内の再提出はfixCountを二重加算せず、既採用の追加を再適用しない", async () => {
    const f = await setup(); await planned(f);
    const extra = { ...command, id: "extra" };
    f.scripts.push(answer({ ...implementation, validationPlanUpdates: [{ operation: "add", definition: extra, reason: "追加" }] }));
    await f.phases.implementation(context); await f.savedReview(1);
    f.scripts.push(answer(review)); await f.phases.review(1);
    f.scripts.push(answer({ ...implementation, validationPlanUpdates: [{ operation: "add", definition: extra, reason: "重複" }] }),
      answer({ validationPlanUpdates: [{ operation: "update", definition: { ...extra, command: "true" }, reason: "内容変更" }] }));
    await f.phases.fix(1);
    expect(f.control.snapshot()).toMatchObject({ phase: "fix", fixCount: 1, phaseStatus: "succeeded", retryCount: {} });
    expect((await f.store.loadValidationSubmissions()).filter(s => s.phase === "fix").map(s => s.accepted)).toEqual([false, true]);
    expect(f.prompts.at(-1)).toContain("登録済みID");
    expect(await f.store.loadArtifact("implementation", 2)).toMatchObject({ validationPlanUpdates: [{ operation: "update" }] });
  });
  it("再提出中のコード変更は採用せず停止", async () => {
    const f = await setup(); await planned(f);
    f.scripts.push(answer({ ...implementation, validationPlanUpdates: [{ operation: "remove", id: "unknown", reason: "誤り" }] }),
      answer({ validationPlanUpdates: [] }, () => writeFile(join(f.store.worktreePath, "a.txt"), "unauthorized")));
    await expect(f.phases.implementation(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.control.snapshot().error?.message).toContain("再提出中にコード");
    await expect(f.store.loadArtifact("implementation", 1)).rejects.toThrow();
    await expect(f.store.loadArtifact("verification", 1)).rejects.toThrow();
  });
  it("更新履歴を保存できない場合は再提出モデルを呼ばず停止", async () => {
    const f = await setup(); await planned(f);
    jest.spyOn(f.store, "saveValidationSubmission").mockRejectedValue(new StorageError("io"));
    f.scripts.push(answer({ ...implementation, validationPlanUpdates: [{ operation: "remove", id: "unknown", reason: "誤り" }] }));
    await expect(f.phases.implementation(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.prompts).toHaveLength(2);
    await expect(f.store.loadArtifact("verification", 1)).rejects.toThrow();
  });
  it("絶対cwdの更新を具体的に返して相対cwdの再提出を受理", async () => {
    const f = await setup(); await planned(f);
    f.scripts.push(answer({ ...implementation, validationPlanUpdates: [{ operation: "update", definition: { ...command, workingDirectory: "/tmp" }, reason: "誤り" }] }),
      answer({ validationPlanUpdates: implementation.validationPlanUpdates }));
    await f.phases.implementation(context);
    expect(f.prompts.at(-1)).toContain("worktree内の相対パスが必要");
    expect((await f.store.loadValidationSubmissions()).map(s => s.accepted)).toEqual([false, true]);
  });
  it("Plan→Implementation→独立Review→同一セッションFix→別Reviewと履歴を保存", async () => {
    const f = await setup();
    await planned(f);
    expect(await f.store.loadPlan()).toMatchObject({ plan });
    f.scripts.push(answer(implementation, () => writeFile(join(f.store.worktreePath, "new.txt"), "変更")));
    expect(await f.phases.implementation(context)).toEqual(implementation);
    await f.savedReview(1);
    f.scripts.push(answer(review)); await f.phases.review(1);
    f.scripts.push(answer(implementation)); await f.phases.fix(1);
    await f.savedReview(2);
    f.scripts.push(answer(review)); await f.phases.review(2);
    const state = await f.store.loadGitHubState();
    expect(state).toMatchObject({ codexThreadId: "thread-1", reviewThreadIds: ["thread-2", "thread-3"], phase: "review", phaseStatus: "succeeded", fixCount: 1, resultCommits: [] });
    expect(f.connection.resume).toHaveBeenNthCalledWith(1, "thread-1");
    expect(f.connection.resume).toHaveBeenNthCalledWith(2, "thread-1");
    expect(f.connection.start).toHaveBeenCalledTimes(3);
    expect(f.connection.start).toHaveBeenCalledWith(true);
    expect(await f.store.loadArtifact("implementation", 1)).toEqual(implementation);
    expect(await f.store.loadArtifact("implementation", 2)).toEqual(implementation);
    expect(f.prompts[0]).toContain("完了条件");
    expect(f.prompts[0]).toContain("レビュー合格前のgit commitは禁止");
    expect(f.prompts[2]).toContain("cumulativeDiff");
    expect(f.prompts[2]).toContain("validationPlanUpdates");
    expect(f.prompts[3]).toContain("修正必須");
    // 総数ではなく、各フェーズの主要イベントとセッションを保証する。
    const events = (await f.store.loadEvents()).filter(e => e.type === "codex.event");
    for (const [phase, attempt, threadId] of [["plan", 1, "thread-1"], ["implementation", 1, "thread-1"],
      ["review", 1, "thread-2"], ["fix", 1, "thread-1"], ["review", 2, "thread-3"]] as const) {
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase, data: expect.objectContaining({ attempt, type: "thread.started", threadId }) }),
        expect.objectContaining({ phase, data: expect.objectContaining({ attempt, type: "item.completed", itemType: "agent_message" }) }),
        expect.objectContaining({ phase, data: expect.objectContaining({ attempt, type: "turn.completed" }) }),
      ]));
    }
    expect(f.onBlock).not.toHaveBeenCalled();
  }, 15_000);

  it.each(["plan", "implementation", "review", "fix"] as const)("T6/T7: %sのblockersは保存してblocked、以降呼び出さない", async phase => {
    const f = await setup();
    if (phase !== "plan") await planned(f);
    if (phase === "review" || phase === "fix") {
      f.scripts.push(answer(implementation)); await f.phases.implementation(context); await f.savedReview(1);
    }
    if (phase === "fix") { f.scripts.push(answer(review)); await f.phases.review(1); }
    f.scripts.push(answer({ ...(phase === "plan" ? plan : phase === "review" ? review : implementation), blockers: ["権限付与が必要"] }));
    const invoke = () => phase === "plan" ? f.phases.plan(context) : phase === "implementation" ? f.phases.implementation(context) : phase === "review" ? f.phases.review(1) : f.phases.fix(1);
    await expect(invoke()).rejects.toBeInstanceOf(WorkflowStopped);
    expect(await f.store.loadGitHubState()).toMatchObject({ status: "blocked", error: { classification: "blocker" } });
    const count = f.prompts.length;
    await expect(f.phases.implementation(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.prompts).toHaveLength(count);
    expect(f.onBlock).toHaveBeenCalledWith(["権限付与が必要"]);
    const output = phase === "plan" ? (await f.store.loadArtifact("plan-output", 1)).plan : await f.store.loadArtifact(phase === "review" ? "review" : "implementation", phase === "fix" ? 2 : 1);
    expect(output.blockers).toEqual(["権限付与が必要"]);
  }, 15_000);

  it.each(["not-json", { ...plan, blockers: 123 }, { ...plan, status: "passed" }])("構造化出力不正を正常終了にしない", async output => {
    const f = await setup(); f.scripts.push(answer(output));
    await expect(f.phases.plan(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(await f.store.loadGitHubState()).toMatchObject({ status: "stopped", codexThreadId: null, error: { message: "Codex SDK: response" } });
    expect(f.prompts).toHaveLength(1);
    expect(f.onBlock).not.toHaveBeenCalled();
  });

  it.each(["EAGAIN", "EAI_AGAIN", "ECONNREFUSED"])("実行開始前の%sは最大2回まで安全に再試行", async code => {
    const f = await setup();
    const failure: Script = async function* () { throw Object.assign(new Error("secret"), { code }); };
    f.scripts.push(failure, failure, answer(plan));
    await f.phases.plan(context);
    expect(await f.store.loadGitHubState()).toMatchObject({ retryCount: { "codex.plan.1": 2 }, phaseStatus: "succeeded" });
    expect(f.prompts).toHaveLength(3);
    expect(JSON.stringify(await f.store.loadEvents())).not.toContain("secret");
  });

  it("実行開始前エラーの継続失敗は初回+2回で停止", async () => {
    const f = await setup();
    const failure: Script = async function* () { throw Object.assign(new Error(), { code: "EAGAIN" }); };
    f.scripts.push(failure, failure, failure);
    await expect(f.phases.plan(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.prompts).toHaveLength(3);
    expect(await f.store.loadGitHubState()).toMatchObject({ status: "stopped", retryCount: { "codex.plan.1": 2 } });
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "EACCES", "UNKNOWN"])("不明反映または致命的な%sは再試行しない", async code => {
    const f = await setup(); f.scripts.push(async function* () { throw Object.assign(new Error("secret"), { code }); });
    await expect(f.phases.plan(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.prompts).toHaveLength(1); expect(f.connection.resume).not.toHaveBeenCalled();
  });

  it("イベント受信後の一時エラー・途中変更を保持し再適用しない", async () => {
    const f = await setup(); await planned(f);
    f.scripts.push(async function* (id) {
      yield { type: "thread.started", thread_id: id };
      await writeFile(join(f.store.worktreePath, "partial.txt"), "途中変更");
      throw Object.assign(new Error("write-secret"), { code: "EAGAIN" });
    });
    await expect(f.phases.implementation(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(await readFile(join(f.store.worktreePath, "partial.txt"), "utf8")).toBe("途中変更");
    expect(f.connection.resume).toHaveBeenCalledTimes(1);
    expect(await f.store.loadGitHubState()).toMatchObject({ status: "stopped", phase: "implementation", retryCount: {} });
  });

  it("イベントなしでもGit内容に変化があれば再試行しない", async () => {
    const f = await setup(); f.scripts.push(async function* () {
      await writeFile(join(f.store.worktreePath, "secret-file"), "write-secret");
      throw Object.assign(new Error(), { code: "EAGAIN" });
    });
    await expect(f.phases.plan(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.prompts).toHaveLength(1);
    expect(await f.store.loadGitHubState()).toMatchObject({ error: { classification: "uncertain" } });
  });

  it.each(["plan", "implementation", "review"] as const)("%sの不正commitを検出して停止（履歴を改変しない）", async phase => {
    const f = await setup();
    if (phase !== "plan") await planned(f);
    if (phase === "review") { f.scripts.push(answer(implementation)); await f.phases.implementation(context); await f.savedReview(1); }
    f.scripts.push(answer(phase === "plan" ? plan : phase === "review" ? review : implementation, async () => {
      await runGit(f.store.worktreePath, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "unauthorized"]);
    }));
    await expect(phase === "plan" ? f.phases.plan(context) : phase === "review" ? f.phases.review(1) : f.phases.implementation(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(await f.store.loadGitHubState()).toMatchObject({ status: "stopped", error: { message: "レビュー前のcommitまたは履歴・ブランチ変更を検出" } });
    expect((await runGit(f.store.worktreePath, ["log", "-1", "--format=%s"])).trim()).toBe("unauthorized");
  });

  it("Planの読み取りフェーズで内容変更した場合は停止", async () => {
    const f = await setup(); f.scripts.push(answer(plan, () => writeFile(join(f.store.worktreePath, "a.txt"), "changed")));
    await expect(f.phases.plan(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(await f.store.loadGitHubState()).toMatchObject({ error: { message: "読み取りフェーズでGit内容変更を検出" } });
  });

  it("T19: 公開対象外MCPイベントは停止し引数・応答を保存しない", async () => {
    const f = await setup(); f.scripts.push(async function* (id) {
      yield { type: "thread.started", thread_id: id };
      yield { type: "item.started", item: { id: "m", type: "mcp_tool_call", server: "external", tool: "write_data", arguments: { token: "write-secret" }, status: "in_progress" } };
    });
    await expect(f.phases.plan(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(JSON.stringify(await f.store.loadEvents())).not.toContain("write-secret");
    expect(await f.store.loadGitHubState()).toMatchObject({ status: "stopped", error: { message: "読み取り専用MCPの範囲外の呼び出しを検出" } });
  });

  it("無応答は警告を保存し、時間だけでは終了せず後の応答を受け取る", async () => {
    const f = await setup(10);
    f.scripts.push(answer(plan, async () => { await new Promise(resolve => setTimeout(resolve, 65)); }));
    await f.phases.plan(context);
    expect((await f.store.loadEvents()).some(e => e.type === "codex.unresponsive_warning")).toBe(true);
    expect(await f.store.loadGitHubState()).toMatchObject({ status: "running", phaseStatus: "succeeded" });
  });

  it.each(["session", "event", "plan"])("%sの保存失敗は再実行せず停止", async target => {
    const f = await setup();
    if (target === "session") {
      const original = f.store.saveGitHubState.bind(f.store);
      jest.spyOn(f.store, "saveGitHubState").mockImplementation(async state => { if (state.codexThreadId) throw new StorageError("io"); await original(state); });
    } else if (target === "event") {
      const original = f.store.appendEvent.bind(f.store);
      jest.spyOn(f.store, "appendEvent").mockImplementation(async event => { if (event.type === "codex.event") throw new StorageError("io"); await original(event); });
    } else jest.spyOn(f.store, "savePlan").mockRejectedValue(new StorageError("io"));
    f.scripts.push(answer(plan));
    await expect(f.phases.plan(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.prompts).toHaveLength(1);
    expect(f.control.snapshot().status).toBe("stopped");
  });

  it("不正な開始順序・Plan再実行はSDKを呼ばず停止", async () => {
    const f = await setup(); await planned(f);
    await expect(f.phases.plan(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.prompts).toHaveLength(1);
    const g = await setup(); await expect(g.phases.implementation(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(g.prompts).toHaveLength(0);
  });

  it.each(["turn.failed", "error", "incomplete"])("SDKの%sは成功・blockedにせずセッションIDを保持", async kind => {
    const f = await setup(); f.scripts.push(async function* (id) {
      yield { type: "thread.started", thread_id: id };
      expect(await f.store.loadArtifact("plan-session", 1)).toEqual({ threadId: id, readonly: true });
      expect(await f.store.loadGitHubState()).toMatchObject({ codexThreadId: null, phaseStatus: "running" });
      if (kind === "turn.failed") yield { type: "turn.failed", error: { message: "write-secret" } };
      if (kind === "error") yield { type: "error", message: "write-secret" };
    });
    await expect(f.phases.plan(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(await f.store.loadGitHubState()).toMatchObject({ status: "stopped", codexThreadId: null, phaseStatus: "failed" });
    expect(f.onBlock).not.toHaveBeenCalled(); expect(f.prompts).toHaveLength(1);
  });

  it.each(["implementation", "review"] as const)("%sのスキーマ不正も成功にしない", async phase => {
    const f = await setup(); await planned(f);
    if (phase === "review") { f.scripts.push(answer(implementation)); await f.phases.implementation(context); await f.savedReview(1); }
    f.scripts.push(answer({ summary: "欠落フィールド" }));
    await expect(phase === "review" ? f.phases.review(1) : f.phases.implementation(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(await f.store.loadGitHubState()).toMatchObject({ status: "stopped", error: { message: "Codex SDK: response" } });
  });

  it("継続セッションIDの不一致は停止", async () => {
    const f = await setup(); await planned(f);
    f.scripts.push(answer(implementation));
    (f.connection.resume as ReturnType<typeof mock<typeof f.connection.resume>>).mockReturnValue({ id: "other", runStreamed: jest.fn() });
    await expect(f.phases.implementation(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.prompts).toHaveLength(1);
  });

  it("Reviewで実装セッションのIDが返された場合は独立Reviewとして受理しない", async () => {
    const f = await setup(); await planned(f);
    f.scripts.push(answer(implementation)); await f.phases.implementation(context); await f.savedReview(1);
    f.scripts.push(async function* () { yield { type: "thread.started", thread_id: "thread-1" }; });
    await expect(f.phases.review(1)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(await f.store.loadGitHubState()).toMatchObject({ status: "stopped", reviewThreadIds: [] });
  });

  it("未許可のMCP呼び出しは拒否し、ログへ秘密を保存しない", async () => {
    const f = await setup(); f.scripts.push(async function* (id) {
      yield { type: "thread.started", thread_id: id };
      yield { type: "item.completed", item: { id: "m", type: "mcp_tool_call", server: "external", tool: "read_data", status: "completed", arguments: { secret: "write-secret" }, result: { content: [{ type: "text", text: "read-secret" }], structured_content: null } } };
      yield { type: "item.completed", item: { id: "a", type: "agent_message", text: JSON.stringify({ plan, branchName: null }) } };
      yield { type: "turn.completed", usage };
    });
    await expect(f.phases.plan(context)).rejects.toBeInstanceOf(WorkflowStopped);
    const events = await f.store.loadEvents();
    expect((await f.store.loadGitHubState()).error?.message).toContain("MCP");
    expect(JSON.stringify(events)).not.toMatch(/read-secret|write-secret/);
  });

  it("無応答警告の保存失敗も安全停止しSDKを再実行しない", async () => {
    const f = await setup(10); const original = f.store.appendEvent.bind(f.store);
    jest.spyOn(f.store, "appendEvent").mockImplementation(async event => {
      if (event.type === "codex.unresponsive_warning") throw new StorageError("io");
      await original(event);
    });
    f.scripts.push(answer(plan, async () => { await new Promise(resolve => setTimeout(resolve, 65)); }));
    await expect(f.phases.plan(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.prompts).toHaveLength(1);
    expect(await f.store.loadGitHubState()).toMatchObject({ status: "stopped", error: { message: "実行記録: io" } });
  });
});
