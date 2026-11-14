import { DevelopmentStore as RunStore } from "./issue-state.js";
import { TestPhases as CodexPhases } from "./phases.js";
import { testStateSchema as stateSchema } from "./issue-state.js";
import { WorkflowControl } from "./control.js";
import { localRemote } from "./local-remote.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadEvent, TurnOptions } from "@openai/codex-sdk";
import { outputSchemaViolations } from "./output-schema.js";
import { type PhaseConnection } from "../../src/codex.js";
import { runGit } from "../../src/git.js";
import { type IssueInput } from "../../src/schemas.js";
import { reviewImplementation } from "../../src/review.js";
import { newRunId } from "../../src/state.js";
import { WorkflowStopped, WorkflowError } from "../../src/workflow.js";

export const definition = { id: "test", kind: "test" as const, command: "bun check.cjs", workingDirectory: ".",
  executionMethod: "開発コンテナ内の専用worktree", evidence: "check.cjs", required: true };
export const plan = { summary: "計画", steps: ["実装"], validationPlan: [definition], undetectedValidation: [], blockers: [] };
export const implementation = { summary: "実装", validation: [], validationPlanUpdates: [], remainingIssues: [], blockers: [] };
export const review = { summary: "レビュー", findings: [], unverifiedItems: [], blockers: [] };
export const major = { ...review, findings: [{ severity: "major", description: "check.cjsが終了コード7となる回帰を修正する", validationCommandIds: ["test"], location: "check.cjs:1" }] };
type Phase = "plan" | "implementation" | "fix" | "review" | "commit" | "report";
const usage = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 };

/** 実Git・worktree・保存・検証をつなぐ。GitHubとCodex SDK実行だけを置き換える。 */
export async function setupDevelopment(root: string, prepareSource?: (path: string) => Promise<void>) {
  const repositoryPath = join(root, "repo"); await mkdir(repositoryPath);
  await runGit(repositoryPath, ["init", "-b", "main"]);
  await runGit(repositoryPath, ["config", "user.name", "Test"]);
  await runGit(repositoryPath, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(repositoryPath, "check.cjs"), "process.exit(0);\n");
  await runGit(repositoryPath, ["add", "."]);
  await runGit(repositoryPath, ["commit", "-m", "initial"]);
  await runGit(repositoryPath, ["remote", "add", "origin", "https://example.com/owner/repo.git"]);
  await prepareSource?.(repositoryPath);
  await localRemote(repositoryPath, root);
  const store = new RunStore(newRunId(), join(root, "harness"));
  const issue = { id: "67", title: "停止経路", body: "要件・完了条件" };
  const calls: string[] = [], phasesCalled: Phase[] = [], prompts: string[] = [], sessions: string[] = [];
  const outputSchemas: { phase: Phase; schema: unknown }[] = [];
  const behavior = {
    git: runGit,
    beforePlan: async (_control: WorkflowControl) => {},
    planOutput: (value: unknown): unknown => ({ plan: value, branchName: "feature/development-checks" }),
    output: (_phase: Phase): unknown => _phase === "plan" ? plan : _phase === "review" ? review : implementation,
    beforeStream: async (_phase: Phase) => {},
    duringStream: async (phase: Phase) => {
      if (phase === "implementation" || phase === "fix") await writeFile(join(store.worktreePath, "partial.txt"), phase);
    },
    warningAfterMs: 60_000,
  };
  let threads = 0;
  const thread = (initial: string | null, id: string) => {
    const result = { id: initial, runStreamed: async (prompt: string, options?: TurnOptions) => {
      const phase = prompt.split("フェーズ")[0] as Phase;
      outputSchemas.push({ phase, schema: options?.outputSchema });
      const violations = outputSchemaViolations(options?.outputSchema);
      if (violations.length) throw new Error(violations.join("\n"));
      phasesCalled.push(phase); prompts.push(prompt);
      await behavior.beforeStream(phase);
      return { events: (async function* (): AsyncGenerator<ThreadEvent> {
        result.id = id;
        yield { type: "thread.started", thread_id: id };
        await behavior.duringStream(phase);
        yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: JSON.stringify(phase === "plan" ? behavior.planOutput(behavior.output(phase)) : behavior.output(phase)) } };
        yield { type: "turn.completed", usage };
      })() };
    } };
    return result;
  };
  const connection: PhaseConnection = {
    start: () => { sessions.push("start"); return thread(null, `thread-${++threads}`); },
    resume: id => { sessions.push(`resume:${id}`); return thread(id, id); },
  };
  const afterReview = { run: async (_input: { control: WorkflowControl; phases: CodexPhases }) => {} };
  const develop = async (control: WorkflowControl, context: IssueInput) => {
    const block = (reasons: string[]) => control.stop(new WorkflowError("blocker", reasons.join("\n")), "human_decision", "blocked");
    const phases = new CodexPhases({ control, connection, block, git: (cwd, args) => behavior.git(cwd, args), warningAfterMs: behavior.warningAfterMs });
    await behavior.beforePlan(control);
    await phases.plan(context);
    await phases.implementation(context);
    await reviewImplementation({ control, phases, block });
    await afterReview.run({ control, phases });
    return control.snapshot().status;
  };
  const run = async (branchName?: string) => {
    const state = stateSchema.parse({ schemaVersion: 2, runId: store.runId, issueId: issue.id,
      repositoryId: "example.com/owner/repo", repositoryPath, branchName: "feature/development-checks",
      worktreePath: store.worktreePath, baseCommit: (await runGit(repositoryPath, ["rev-parse", "HEAD"])).trim(), phase: "prepare", phaseStatus: "running", status: "running",
      fixCount: 0, retryCount: {}, verificationArtifact: null, codexThreadId: null, reviewThreadIds: [], resultCommits: [], reviewedTreeId: null,
      error: null, updatedAt: new Date().toISOString() });
    await mkdir(join(store.root, "worktrees"), { recursive: true });
    await runGit(repositoryPath, ["worktree", "add", "-b", "feature/development-checks", store.worktreePath]);
    await store.createGitHub(state);
    const control = new WorkflowControl(store, state);
    try {
      const context: IssueInput = { issue, repositoryInstructions: ["コンテナ内で検証"] };
      await store.saveArtifact("issue-input", context);
      await control.recordPhase("plan", "pending");
      return await develop(control, context);
    } catch (error) {
      if (error instanceof WorkflowStopped) return error.state.status;
      try { await control.stop(error, "test.development"); } catch (stopped) { if (stopped instanceof WorkflowStopped) return stopped.state.status; throw stopped; }
      throw error;
    }
  };
  return { store, repositoryPath, connection, behavior, calls, phasesCalled, prompts, sessions, outputSchemas, afterReview, run };
}
