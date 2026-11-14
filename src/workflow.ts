import { CodexError } from "./codex.js";
import { CodexHomeError } from "./codex-home.js";
import { CodexPathError } from "./codex-path.js";
import { StorageError, type RunStore } from "./state.js";
import type { GitHubRunState } from "./github-state.js";
import { WorkflowError } from "./workflow-error.js";
export { WorkflowError, type FailureClassification } from "./workflow-error.js";

export function classifyFailure(error: unknown): WorkflowError {
  if (error instanceof WorkflowError) return error;
  if (error instanceof CodexError || error instanceof CodexHomeError || error instanceof CodexPathError || error instanceof StorageError) return new WorkflowError("fatal", error.message);
  return new WorkflowError("fatal", "未分類の実行エラー");
}
export type DevelopmentState = Omit<GitHubRunState, "repositoryPath" | "worktreePath" | "baseCommit"> & {
  repositoryPath: string; worktreePath: string; baseCommit: string; executionHead?: string;
};
export class WorkflowStopped extends Error {
  constructor(readonly state: DevelopmentState, readonly recordingFailures: string[] = []) {
    super("ワークフロー停止");
  }
}
export type RetryDecision<T> = { outcome: "applied"; value: T } | { outcome: "retry" } | { outcome: "uncertain" };
export interface DevelopmentControl {
  readonly store: RunStore;
  snapshot(): DevelopmentState;
  execute<T>(options: { operation: string; run: () => Promise<T>; confirmRetry: (failure: WorkflowError) => Promise<RetryDecision<T>> }): Promise<T>;
  recordPhase(phase: GitHubRunState["phase"], status: GitHubRunState["phaseStatus"], data?: Record<string, string | number>): Promise<void>;
  recordFix(attempt: number): Promise<void>;
  recordVerification(attempt: number): Promise<void>;
  recordCommitState(values: Pick<GitHubRunState, "reviewedTreeId" | "resultCommits">): Promise<void>;
  recordCodexSession(id: string, review: boolean): Promise<void>;
  stop(error: unknown, operation: string): Promise<never>;
}
export const developmentIdentity = (state: DevelopmentState) => state.issue.issueId;
export const developmentBranch = (state: DevelopmentState) => state.workBranchName ?? state.branchName;
export const developmentHead = (state: DevelopmentState) => state.executionHead ?? state.restartHead ?? state.baseCommit;
