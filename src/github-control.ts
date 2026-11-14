import { z } from "zod";
import type { RunStore } from "./state.js";
import { redact } from "./state.js";
import { WorkflowError, classifyFailure, type DevelopmentControl, type DevelopmentState, type RetryDecision } from "./workflow.js";
import { githubStateSchema, type GitHubRunState } from "./github-state.js";
import { GitHubError } from "./github.js";
import { WorkspaceError } from "./github-workspace-store.js";
import { IssueContextError, normalizeIssueReference } from "./github-issue.js";
import { postBlockedComment, transitionIssueLabels, type IssueWriteApi } from "./github-labels.js";
import type { GitHubConfig } from "./github-config.js";
import type { RunState } from "./schemas.js";

export class GitHubWorkflowStopped extends Error {
  constructor(readonly state: GitHubRunState, readonly recordingFailures: string[] = []) { super("GitHubワークフロー停止"); }
}
export function githubFailure(error: unknown): WorkflowError {
  if (error instanceof GitHubError) return new WorkflowError(error.kind === "unknown" ? "uncertain" : "fatal", error.message);
  if (error instanceof WorkspaceError) return new WorkflowError("fatal", error.message);
  if (error instanceof IssueContextError) return new WorkflowError("fatal", `${error.message} ${JSON.stringify(error.details)}`);
  return classifyFailure(error);
}

/** Issueの状態を保持し、開発・検証工程へ確定済みの実パスを渡す。 */
export class GitHubControl implements DevelopmentControl {
  private halted = false;
  private rateLimited = false;
  constructor(readonly store: RunStore, private state: GitHubRunState, private readonly api: IssueWriteApi,
    private readonly config: GitHubConfig, private readonly secrets: readonly string[]) {}
  githubSnapshot() { return structuredClone(this.state); }
  snapshot(): DevelopmentState {
    const s = this.githubSnapshot();
    if (!s.worktreePath || !s.repositoryPath || !s.baseCommit || ["push", "comment", "review_state"].includes(s.phase))
      throw new WorkflowError("fatal", "開発対象が未確定です");
    return { ...s, phase: s.phase as DevelopmentState["phase"],
      worktreePath: s.worktreePath, repositoryPath: s.repositoryPath, baseCommit: s.baseCommit,
      executionHead: s.restartHead ?? s.baseCommit };
  }
  async patch(values: Partial<GitHubRunState>) {
    this.state = githubStateSchema.parse({ ...this.state, ...values, updatedAt: new Date().toISOString() });
    await this.store.saveGitHubState(this.state);
  }
  private event(type: string, data: Record<string, string | number | null> = {}) {
    return this.store.appendEvent({ timestamp: new Date().toISOString(), type,
      phase: this.state.phase as RunState["phase"], data });
  }
  async recordPhase(phase: RunState["phase"], phaseStatus: RunState["phaseStatus"], data: Record<string, string | number> = {}) {
    await this.patch({ phase, phaseStatus }); await this.event(`phase.${phaseStatus}`, data);
  }
  async recordCodexSession(id: string, review: boolean) {
    if (!id.trim() || (review ? id === this.state.codexThreadId || this.state.reviewThreadIds.includes(id)
      : this.state.codexThreadId !== null && this.state.codexThreadId !== id)) throw new WorkflowError("fatal", "CodexセッションIDが不整合");
    await this.patch(review ? { reviewThreadIds: [...this.state.reviewThreadIds, id] } : { codexThreadId: id });
  }
  async recordFix(attempt: number) {
    if (attempt !== this.state.fixCount + 1 || attempt > 3) throw new WorkflowError("fatal", "Fix回数が不整合");
    await this.patch({ fixCount: attempt });
  }
  async recordCommitState(values: Pick<RunState, "reviewedTreeId" | "resultCommits">) { await this.patch(values); }
  async recordVerification(attempt: number) { await this.patch({ verificationArtifact: `verification-${attempt}.json` }); }
  async execute<T>(options: { operation: string; run: () => Promise<T>; confirmRetry: (failure: WorkflowError) => Promise<RetryDecision<T>> }): Promise<T> {
    if (this.halted) throw new GitHubWorkflowStopped(this.githubSnapshot());
    for (;;) {
      try {
        await this.event("operation.started", { operation: options.operation, retryCount: this.state.retryCount[options.operation] ?? 0 });
        const value = await options.run();
        await this.event("operation.succeeded", { operation: options.operation });
        return value;
      } catch (error) {
        if (error instanceof GitHubWorkflowStopped) throw error;
        if (error instanceof GitHubError && error.kind === "rate_limit") this.rateLimited = true;
        const failure = githubFailure(error);
        if (failure.classification === "transient") {
          try {
            const decision = await options.confirmRetry(failure), count = this.state.retryCount[options.operation] ?? 0;
            if (decision.outcome === "applied") return decision.value;
            if (decision.outcome === "retry" && count < 2) {
              await this.patch({ retryCount: { ...this.state.retryCount, [options.operation]: count + 1 } });
              continue;
            }
          } catch { /* 照会/保存できなければ停止。 */ }
        }
        return this.stop(error, options.operation);
      }
    }
  }
  async start() {
    await this.patch({ phase: "start", phaseStatus: "running", startTransition: "in_flight" });
    let confirmed = false;
    try {
      await transitionIssueLabels(this.api, this.store, normalizeIssueReference(this.state.issue.url), this.config.github.labels, "ready", "running", "start");
      confirmed = true;
      await this.patch({ startTransition: "succeeded", phaseStatus: "succeeded" });
    } catch (error) {
      if (!confirmed) await this.patch({ startTransition: error instanceof GitHubError && error.kind === "unknown" ? "unknown" : "failed" }).catch(() => {});
      throw error;
    }
  }
  block = async (blockers: string[]): Promise<never> => {
    const reasons = z.array(z.string().trim().min(1)).min(1).parse(blockers);
    return this.stop(new WorkflowError("blocker", reasons.join("\n")), "human_decision", "blocked");
  };
  async stop(error: unknown, operation: string, status: "blocked" | "stopped" = "stopped"): Promise<never> {
    this.halted = true;
    const failure = githubFailure(error), failures: string[] = [];
    this.state = { ...this.state, status, phaseStatus: "failed", error: {
      classification: failure.classification, operation, message: redact(failure.message, this.secrets) }, updatedAt: new Date().toISOString() };
    // GitHub反映より先にローカル停止を確定する。保存失敗でも以後の開発は実行しない。
    try { await this.store.saveGitHubState(this.state); } catch { failures.push("state"); }
    try { await this.event("workflow.stopped", { operation, status, message: this.state.error!.message }); } catch { failures.push("events"); }
    if (error instanceof GitHubError && error.kind === "rate_limit") this.rateLimited = true;
    if (this.state.startTransition === "succeeded") {
      try {
        if (failures.length || this.rateLimited) throw new WorkflowError("uncertain", this.rateLimited ? "レート制限中のため停止反映を実行しません" : "記録失敗のため停止反映を実行できません");
        const issue = normalizeIssueReference(this.state.issue.url);
        await transitionIssueLabels(this.api, this.store, issue, this.config.github.labels, "running", status, "stop");
        if (status === "blocked") {
          const body = `人間の判断が必要です。\n\n理由: ${this.state.error!.message}\n\n選択肢: 要件・権限・方針を明確にして再実行する／実施を見送る。\n推奨: 保存済みの計画・検証・レビューを確認して必要な指示を追加し、再実行する場合は単一readyへ戻してください。\n\nrun ID: ${this.state.runId}`;
          await postBlockedComment(this.api, this.store, issue, body);
        }
        this.state.stopReflection = { status: "succeeded", message: null };
      } catch (reflectionError) {
        this.state.stopReflection = { status: reflectionError instanceof GitHubError && reflectionError.kind === "unknown" ? "unknown" : "failed",
          message: redact(githubFailure(reflectionError).message, this.secrets) };
      }
      try { await this.store.saveGitHubState(this.state); } catch { failures.push("stopReflection"); }
    }
    throw new GitHubWorkflowStopped(this.githubSnapshot(), failures);
  }
}
