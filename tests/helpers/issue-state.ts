import { RunStore } from "../../src/state.js";
import { githubStateSchema } from "../../src/github-state.js";
import type { DevelopmentState } from "../../src/workflow.js";
export function issueState(values: Record<string, unknown> = {}): DevelopmentState {
  const issue = { host: "github.com", repositoryId: "10", repository: "owner/repo", issueId: String(values.issueId ?? "93"), number: Number(values.issueId ?? 93), url: "https://github.com/owner/repo/issues/" + (values.issueId ?? 93) };
  const state = githubStateSchema.parse({ schemaVersion: 2, backend: "github", runId: "00000000-0000-4000-8000-000000000001", issue, managementIssue: issue,
    repositoryPath: "/repo", worktreePath: "/absent", branchName: "feature/test", workBranchName: values.branchName ?? "feature/test", branchRecordPath: null,
    previousRunId: null, worktreeOriginRunId: values.runId ?? "00000000-0000-4000-8000-000000000001", baseCommit: "a".repeat(40), restartHead: null, remoteStartCommit: null,
    startTransition: "succeeded", stopReflection: { status: "not_started", message: null }, submissionArtifact: null,
    phase: "plan", status: "running", phaseStatus: "pending", fixCount: 0, retryCount: {}, verificationArtifact: null, codexThreadId: null,
    reviewThreadIds: [], resultCommits: [], reviewedTreeId: null, error: null, updatedAt: new Date().toISOString(), ...values });
  if (!state.repositoryPath || !state.worktreePath || !state.baseCommit) throw new Error("開発fixtureの作業先が不足");
  return { ...state, repositoryPath: state.repositoryPath, worktreePath: state.worktreePath, baseCommit: state.baseCommit };
}
export const testStateSchema = { parse: issueState, safeParse: githubStateSchema.safeParse.bind(githubStateSchema) };

export class DevelopmentStore extends RunStore {
  override async loadGitHubState(): Promise<DevelopmentState> {
    const state = await super.loadGitHubState();
    if (!state.repositoryPath || !state.worktreePath || !state.baseCommit) throw new Error("開発対象が未確定");
    return { ...state, repositoryPath: state.repositoryPath, worktreePath: state.worktreePath, baseCommit: state.baseCommit };
  }
}
