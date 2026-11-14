import { testStateSchema as stateSchema } from "./helpers/issue-state.js";
import { WorkflowControl } from "./helpers/control.js";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, jest } from "bun:test";
import { runGit } from "../src/git.js";
import { RunStore, newRunId, StorageError } from "../src/state.js";
import { WorkflowError, WorkflowStopped } from "../src/workflow.js";
import { CodexPhases, type PhaseConnection } from "../src/codex.js";
import { assessReview, reviewImplementation } from "../src/review.js";
import { type Implementation, type Review } from "../src/schemas.js";

import { requiredReviewChecks } from "./helpers/spec.js";

const dirs: string[] = [];
afterEach(async () => { jest.restoreAllMocks(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const definition = { id: "test", kind: "test" as const, command: "bun check.cjs", workingDirectory: ".", executionMethod: "開発コンテナ内の専用worktree", evidence: "README/check.cjs", required: true };
const implementation: Implementation = { summary: "実装", validation: [], validationPlanUpdates: [], remainingIssues: [], blockers: [] };
const pass: Review = { summary: "要件ごとの根拠を確認", findings: [], unverifiedItems: [], blockers: [] };
const major: Review = { ...pass, findings: [{ severity: "major", description: "終了コード7。check.cjsの回帰が原因、失敗する条件を修正する", validationCommandIds: ["test"], location: "check.cjs:1" }] };
const issue = { id: "66", title: "検証用Issue", body: "要件と完了条件" };

async function setup(responses: (Review | Implementation | Error)[], options: { failed?: boolean; skipped?: boolean; undetected?: boolean; fixFailed?: boolean; ids?: string[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "harness-review-")); dirs.push(dir);
  const store = new RunStore(newRunId(), dir);
  const source = join(dir, "source"); await mkdir(source);
  await runGit(source, ["init", "-b", "main"]);
  await writeFile(join(source, "check.cjs"), `process.exit(${options.failed ? 7 : 0});`);
  await writeFile(join(source, "value.txt"), "base");
  await runGit(source, ["add", "."]);
  await runGit(source, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  const baseCommit = (await runGit(source, ["rev-parse", "HEAD"])).trim();
  await mkdir(join(dir, "worktrees"));
  await runGit(source, ["worktree", "add", "-b", "feature/test", store.worktreePath]);
  await writeFile(join(store.worktreePath, "value.txt"), "implementation");
  const state = stateSchema.parse({ schemaVersion: 2, runId: store.runId, issueId: issue.id,
    repositoryId: "github.com/test/repo", repositoryPath: source, branchName: "feature/test", worktreePath: store.worktreePath,
    baseCommit, phase: "implementation", status: "running", phaseStatus: "succeeded", fixCount: 0, retryCount: {}, verificationArtifact: null,
    codexThreadId: "implementation-thread", reviewThreadIds: [], resultCommits: [], reviewedTreeId: null, error: null, updatedAt: new Date().toISOString() });
  await store.createGitHub(state);
  await store.savePlan({ summary: "計画", steps: ["要件を満たす"], validationPlan: options.undetected ? [] : (options.ids ?? ["test"]).map(id => ({ ...definition, id, workingDirectory: options.skipped ? "missing" : "." })), undetectedValidation: options.undetected ? ["必須テスト未検出"] : [], blockers: [] });
  await store.saveArtifact("issue-input", { issue: { ...issue, description: "元の要件", acceptanceCriteria: "回帰しない" }, repositoryInstructions: ["テストを弱体化しない"] });
  await store.saveArtifact("implementation", implementation, 1);
  const control = new WorkflowControl(store, state);
  const prompts: string[] = []; let reviews = 0;
  const thread = (id: string, initial: string | null) => {
    const t = { id: initial, runStreamed: async (prompt: string) => {
      prompts.push(prompt); const response = responses.shift();
      if (response instanceof Error) throw response;
      return { events: (async function* () {
        t.id = id; yield { type: "thread.started" as const, thread_id: id };
        if (initial) {
          await writeFile(join(store.worktreePath, "check.cjs"), `process.exit(${options.fixFailed ? 7 : 0});`);
          await writeFile(join(store.worktreePath, "value.txt"), `fix-${control.snapshot().fixCount}`);
        }
        yield { type: "item.completed" as const, item: { id: "answer", type: "agent_message" as const, text: JSON.stringify(response) } };
        yield { type: "turn.completed" as const, usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
      })() };
    } };
    return t;
  };
  const connection: PhaseConnection = { start: jest.fn(() => thread(`review-${++reviews}`, null)), resume: jest.fn(id => thread(id, id)) };
  const onBlock = jest.fn(async (_reasons: string[]) => {});
  const phases = new CodexPhases({ control, connection, block: async reasons => { await onBlock(reasons); return control.stop(new WorkflowError("blocker", reasons.join("\n")), "human_decision", "blocked"); } });

  return { store, control, connection, onBlock, prompts, run: () => reviewImplementation({ control, phases, block: async reasons => { await onBlock(reasons); return control.stop(new WorkflowError("blocker", reasons.join("\n")), "human_decision", "blocked"); } }) };
}

// 全スイート並列実行時も、4回のReviewと実Git・永続化を完了してから後片付けする。
describe("独立ReviewとFixループ（実Git・実コマンド、SDK/GitHubはテストダブル）", () => {
  jest.setTimeout(60_000);
  it("重大指摘なしでは1回で終了し、入力に7.5節の全確認項目を明記", async () => {
    const f = await setup([pass]); expect(await f.run()).toMatchObject({ attempt: 1, review: pass });
    const checks = (await f.store.loadReviewInput(1)).input.checklist;
    for (const requirement of requiredReviewChecks) {
      expect(checks).toEqual(expect.arrayContaining([expect.stringMatching(requirement)]));
      expect(f.prompts[0]).toMatch(requirement);
    }
    for (const item of ["元の要件", "回帰しない", "テストを弱体化しない", "README/check.cjs", "+implementation"]) expect(f.prompts[0]).toContain(item);
    expect(f.connection.start).toHaveBeenCalledTimes(1); expect(f.connection.start).toHaveBeenCalledWith(true); expect(f.connection.resume).not.toHaveBeenCalled();
    expect(f.control.snapshot()).toMatchObject({ fixCount: 0, phase: "review", phaseStatus: "succeeded", resultCommits: [] });
    expect(f.onBlock).not.toHaveBeenCalled();
  });
  it.each(["major", "critical"] as const)("T2/T3: %s指摘後のみ同一実装セッションでFix、再検証後に新規Review", async severity => {
    const f = await setup([{ ...major, findings: [{ ...major.findings[0]!, severity }] }, implementation, pass], { failed: true });
    expect(await f.run()).toMatchObject({ attempt: 2, verification: { commands: [{ status: "passed", exitCode: 0 }] } });
    expect(f.prompts.map(p => p.split("フェーズ")[0])).toEqual(["review", "fix", "review"]);
    expect(f.prompts[0]).toContain('"exitCode":7'); expect(f.prompts[1]).toContain(major.findings[0]!.description);
    expect(f.prompts[2]).toContain('"exitCode":0'); expect(f.prompts[2]).toContain("-base"); expect(f.prompts[2]).toContain("+fix-1");
    expect(f.control.snapshot()).toMatchObject({ fixCount: 1, reviewThreadIds: ["review-1", "review-2"], retryCount: {} });
    expect(f.connection.resume).toHaveBeenCalledTimes(1); expect(f.connection.resume).toHaveBeenCalledWith("implementation-thread");
    expect((await f.store.loadArtifact("verification", 1)).commands[0]!.status).toBe("failed");
    expect((await f.store.loadArtifact("verification", 2)).commands[0]!.status).toBe("passed");
    expect((await f.store.loadReviewInput(2)).input.implementationHistory).toHaveLength(2);
  });
  it("T8: Review4にも必須指摘が残ればFix3回でblocked", async () => {
    const f = await setup([major, implementation, major, implementation, major, implementation, major], { failed: true, fixFailed: true });
    await expect(f.run()).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.connection.start).toHaveBeenCalledTimes(4); expect(f.connection.resume).toHaveBeenCalledTimes(3);
    expect(f.control.snapshot()).toMatchObject({ status: "blocked", fixCount: 3, reviewThreadIds: ["review-1", "review-2", "review-3", "review-4"] });
    expect(f.onBlock).toHaveBeenCalledWith([expect.stringContaining("最大3回")]);
    expect((await f.store.loadArtifact("verification", 4)).commands[0]!.status).toBe("failed");
  });
  it("自由記述locationと1指摘からの複数コマンド参照でFix・正式再検証・独立再Reviewへ進む", async () => {
    const finding = { ...major.findings[0]!, validationCommandIds: ["node-tests", "bun-tests"],
      location: "node-tests / bun-tests; tests/helpers/acceptance.ts:54; src/cli.ts:119" };
    const first = { ...major, findings: [finding] };
    const f = await setup([first, implementation, pass], { failed: true, ids: ["node-tests", "bun-tests"] });
    expect(await f.run()).toMatchObject({ attempt: 2, verification: { commands: [{ status: "passed" }, { status: "passed" }] } });
    expect((await f.store.loadArtifact("review", 1)).findings).toEqual([finding]);
    expect((await f.store.loadArtifact("verification", 1)).commands.map(c => c.status)).toEqual(["failed", "failed"]);
    expect(f.prompts[1]).toContain(JSON.stringify(first));
    expect(f.prompts[0]).toContain("validationCommandIds");
    expect(f.prompts[2]).toContain('"exitCode":0');
    expect(f.control.snapshot()).toMatchObject({ fixCount: 1, reviewThreadIds: ["review-1", "review-2"] });
    expect(f.connection.resume).toHaveBeenCalledTimes(1); expect(f.connection.resume).toHaveBeenCalledWith("implementation-thread");
  });
  it.each(["skipped", "undetected"] as const)("T20: %sの根拠をReviewで調査し、指摘に基づきFixする", async mode => {
    const update = mode === "undetected" ? [{ operation: "add" as const, definition, reason: "必須テスト検出漏れを修正" }] : [];
    const first = mode === "undetected" ? { ...major, findings: [{ ...major.findings[0]!, validationCommandIds: [] }] } : major;
    const f = await setup([first, { ...implementation, validationPlanUpdates: update }, major, implementation, major, implementation, major], { [mode]: true });
    await expect(f.run()).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.prompts[0]).toContain(mode === "skipped" ? "実行ディレクトリを確認できない" : "必須テスト未検出");
    expect(f.prompts[1]).toContain(major.findings[0]!.description);
    if (mode === "undetected") expect(f.prompts[2]).toContain("必須テスト検出漏れを修正");
    expect(f.control.snapshot().fixCount).toBe(3);
  });
  it.each(["failed", "skipped"] as const)("T21: 必須確認%sへの指摘のないReviewは整合性エラーで停止、Fix・コミット・提出なし", async mode => {
    const f = await setup([pass], { [mode]: true }); await expect(f.run()).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.control.snapshot()).toMatchObject({ status: "stopped", error: { classification: "fatal", message: expect.stringContaining("Review整合性エラー") }, fixCount: 0, resultCommits: [] });
    expect(f.connection.resume).not.toHaveBeenCalled(); expect(f.onBlock).not.toHaveBeenCalled();
  });
  it("別のmajor指摘で必須検証失敗を隠せない", async () => {
    const f = await setup([{ ...major, findings: [{ ...major.findings[0]!, validationCommandIds: [], location: "test" }] }], { failed: true });
    await expect(f.run()).rejects.toBeInstanceOf(WorkflowStopped); expect(f.connection.resume).not.toHaveBeenCalled();
  });
  it.each(["failed", "skipped"] as const)("%sへのminorのみ・無関係な指摘・対応漏れではFixも提出もしない", async mode => {
    for (const finding of [
      { ...major.findings[0]!, severity: "minor" as const, validationCommandIds: ["first", "second"] },
      { ...major.findings[0]!, validationCommandIds: [], location: "first / second; src/a.ts:1" },
      { ...major.findings[0]!, validationCommandIds: ["first"] },
    ]) {
      const f = await setup([{ ...pass, findings: [finding] }], { [mode]: true, ids: ["first", "second"] });
      await expect(f.run()).rejects.toBeInstanceOf(WorkflowStopped);
      expect(f.control.snapshot()).toMatchObject({ status: "stopped", fixCount: 0, resultCommits: [], reviewedTreeId: null });
      expect(f.connection.resume).not.toHaveBeenCalled(); expect(f.onBlock).not.toHaveBeenCalled();
    }
  });
  it.each([[["unknown"]], [["test", "unknown"]], [["test", "test"]], [[""]]])("不正なコマンド参照 %j は検証成功時も停止する", async (ids) => {
    const f = await setup([{ ...pass, findings: [{ ...major.findings[0]!, severity: "minor", validationCommandIds: ids }] }]);
    await expect(f.run()).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.control.snapshot()).toMatchObject({ status: "stopped", fixCount: 0, resultCommits: [], reviewedTreeId: null });
    expect(f.connection.resume).not.toHaveBeenCalled(); expect(f.onBlock).not.toHaveBeenCalled();
  });
  it("minorだけは合格可、未確認事項とPlan/完了条件違反のmajorは修正対象", async () => {
    const minor = { ...pass, findings: [{ severity: "minor" as const, description: "命名改善", validationCommandIds: [], location: null }] };
    const f = await setup([minor]); expect((await f.run()).attempt).toBe(1);
    for (const review of [{ ...minor, unverifiedItems: ["重要な境界条件未確認"] }, { ...major, findings: [{ ...major.findings[0]!, description: "Planが要件と矛盾し完了条件違反", validationCommandIds: [], location: null }] }]) {
      const g = await setup([review, implementation, pass]); expect((await g.run()).attempt).toBe(2);
    }
  });
  it("Reviewのblockersを共通blocked処理へ渡す", async () => {
    const f = await setup([{ ...pass, blockers: ["外部サービスの権限付与が必要"] }]);
    await expect(f.run()).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.control.snapshot().status).toBe("blocked"); expect(f.connection.resume).not.toHaveBeenCalled();
  });
  it("Review開始前の一時障害を再試行し、SDK再試行はFixに加算しない", async () => {
    const transient = Object.assign(new Error(), { code: "EAI_AGAIN" });
    const f = await setup([transient, major, transient, implementation, pass]);
    expect((await f.run()).attempt).toBe(2);
    expect(f.control.snapshot()).toMatchObject({ fixCount: 1, retryCount: { "codex.review.1": 1, "codex.fix.1": 1 } });
    expect(f.control.snapshot().reviewThreadIds).toHaveLength(2);
  });
  it("Review実行エラー・破損出力は安全停止し、Fixしない", async () => {
    for (const response of [new Error(), {} as Review]) {
      const f = await setup([response]); await expect(f.run()).rejects.toBeInstanceOf(WorkflowStopped);
      expect(f.control.snapshot().status).toBe("stopped"); expect(f.connection.resume).not.toHaveBeenCalled(); expect(f.onBlock).not.toHaveBeenCalled();
    }
  });
  it("Reviewの一時障害が続けば初回+2回で停止し、Fixとblockedに混ぜない", async () => {
    const transient = () => Object.assign(new Error(), { code: "EAI_AGAIN" });
    const f = await setup([transient(), transient(), transient(), pass]);
    await expect(f.run()).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.connection.start).toHaveBeenCalledTimes(3);
    expect(f.control.snapshot()).toMatchObject({ status: "stopped", fixCount: 0, retryCount: { "codex.review.1": 2 } });
    expect(f.connection.resume).not.toHaveBeenCalled(); expect(f.onBlock).not.toHaveBeenCalled();
  });
  it("同じ実行の並行ループを拒否し、SDKを開始しない", async () => {
    const f = await setup([pass]); const results = await Promise.allSettled([f.run(), f.run()]);
    expect(results.every(r => r.status === "rejected" && r.reason instanceof WorkflowStopped)).toBe(true);
    expect(f.connection.start).not.toHaveBeenCalled();
  });
  it("判定イベントの保存失敗は安全停止し、再実行しない", async () => {
    const f = await setup([pass]); const append = f.store.appendEvent.bind(f.store);
    jest.spyOn(f.store, "appendEvent").mockImplementation(event => event.type === "review.assessed" ? Promise.reject(new StorageError("io")) : append(event));
    await expect(f.run()).rejects.toBeInstanceOf(WorkflowStopped); expect(f.connection.start).toHaveBeenCalledTimes(1);
  });
  it("検証記録の不足・重複・定義不一致を拒否", async () => {
    const f = await setup([pass]); const { verification } = await f.run();
    expect(() => assessReview(pass, { ...verification, commands: [] })).toThrow("不一致");
    expect(() => assessReview(pass, { ...verification, validationPlan: [definition, definition] })).toThrow("不一致");
    expect(() => assessReview(pass, { ...verification, validationPlan: [{ ...definition, required: false }] })).toThrow("不一致");
    expect(await readFile(join(f.store.artifactsPath, "review-1.json"), "utf8")).toContain(pass.summary);
  });
});
