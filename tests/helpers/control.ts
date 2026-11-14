import { testStateSchema as stateSchema } from "./issue-state.js";
import { z } from "zod";
import { CodexError } from "../../src/codex.js";
import { CodexHomeError } from "../../src/codex-home.js";
import { CodexPathError } from "../../src/codex-path.js";
import { StorageError, RunStore } from "../../src/state.js";
import { type RunEvent, type RunState } from "../../src/schemas.js";
import { diagnosticDetail } from "../../src/codex-diagnostics.js";

import { WorkflowStopped, WorkflowError, type RetryDecision } from "../../src/workflow.js";
export { WorkflowError, type FailureClassification } from "../../src/workflow-error.js";

/** 生の例外を保存しない。SDK実行・Git失敗の一時性は呼び出し側で判断する。 */
export function classifyFailure(error: unknown): WorkflowError {
  if (error instanceof WorkflowError) return error;
  if (error instanceof CodexError || error instanceof CodexHomeError || error instanceof CodexPathError || error instanceof StorageError) return new WorkflowError("fatal", error.message);
  return new WorkflowError("fatal", "未分類の実行エラー");
}

/** 保存に失敗しても制御を終了する。呼び出し側はこの例外から開発を続行しない。 */

type StopStatus = "stopped";

/** 固定フロー用の停止・回数管理。resumeや接続先共通の復旧機能は持たない。 */
export class WorkflowControl {
  private halted = false;
  constructor(readonly store: RunStore, private state: RunState) {
    const parsed = stateSchema.safeParse(state);
    if (!parsed.success) throw new WorkflowError("fatal", "実行状態が不正");
    this.state = stateSchema.parse(parsed.data);
    if (state.runId !== store.runId) throw new WorkflowError("fatal", "実行記録のrun IDが不一致");
  }

  private async event(type: string, data: RunEvent["data"]) {
    await this.store.appendEvent({ timestamp: new Date().toISOString(), type, phase: this.state.phase, data });
  }

  snapshot(): RunState { return structuredClone(this.state); }

  async recordCommitState(values: Pick<RunState, "reviewedTreeId" | "resultCommits">) {
    await this.execute({ operation: "git.record_commit_state", run: async () => {
      const next = stateSchema.parse({ ...this.state, ...values, updatedAt: new Date().toISOString() });
      await this.store.saveGitHubState(next);
      this.state = next;
    }, confirmRetry: async () => ({ outcome: "uncertain" }) });
  }

  async recordVerification(attempt: number) {
    await this.execute({ operation: "verification.record_artifact", run: async () => {
      const next = { ...this.state, verificationArtifact: `verification-${attempt}.json`, updatedAt: new Date().toISOString() };
      await this.store.saveGitHubState(next);
      this.state = next;
    }, confirmRetry: async () => ({ outcome: "uncertain" }) });
  }

  async recordFix(attempt: number) {
    await this.execute({ operation: `codex.fix.${attempt}.count`, run: async () => {
      if (attempt !== this.state.fixCount + 1 || attempt > 3) throw new WorkflowError("fatal", "Fix回数が不整合");
      const next = { ...this.state, fixCount: attempt, updatedAt: new Date().toISOString() };
      await this.store.saveGitHubState(next);
      this.state = next;
    }, confirmRetry: async () => ({ outcome: "uncertain" }) });
  }

  async recordCodexSession(id: string, review: boolean) {
    await this.execute({ operation: "codex.save_session", run: async () => {
      if (!id.trim() || (review ? this.state.codexThreadId === id
        || this.state.reviewThreadIds.includes(id) : this.state.codexThreadId !== null && this.state.codexThreadId !== id)) {
        throw new WorkflowError("fatal", "CodexセッションIDが不整合");
      }
      const next = { ...this.state, ...(review ? { reviewThreadIds: [...this.state.reviewThreadIds, id] } : { codexThreadId: id }), updatedAt: new Date().toISOString() };
      await this.store.saveGitHubState(next);
      this.state = next;
    }, confirmRetry: async () => ({ outcome: "uncertain" }) });
  }

  /** 同じcontrolの最新状態を保持してフェーズと観測結果を確定する。 */
  async recordPhase(phase: RunState["phase"], phaseStatus: RunState["phaseStatus"], data: Record<string, string | number> = {}) {
    await this.execute({ operation: `workflow.${phase}.${phaseStatus}`, run: async () => {
      const next = { ...this.state, phase, phaseStatus, updatedAt: new Date().toISOString() };
      await this.store.saveGitHubState(next);
      this.state = next;
      await this.event(`phase.${phaseStatus}`, data);
    }, confirmRetry: async () => ({ outcome: "uncertain" }) });
  }

  async stop(error: unknown, operation: string, status: StopStatus | "blocked" = "stopped"): Promise<never> {
    this.halted = true;
    const failure = classifyFailure(error);
    this.state = { ...this.state, status, phaseStatus: "failed",
      error: { classification: failure.classification, message: failure.message, operation }, updatedAt: new Date().toISOString() };
    const recordingFailures: string[] = [];
    try { await this.store.saveGitHubState(this.state); } catch { recordingFailures.push("state"); }
    try { await this.event("workflow.stopped", { operation, classification: failure.classification, message: failure.message, status }); }
    catch { recordingFailures.push("events"); }
    throw new WorkflowStopped(this.state, recordingFailures);
  }

  /** operationは検証回等を含む一意な操作名。成功確認・再実行の安全性は呼び出し側の責務。 */
  async execute<T>(options: {
    operation: string;
    run: () => Promise<T>;
    confirmRetry: (failure: WorkflowError) => Promise<RetryDecision<T>>;
    failureStatus?: StopStatus;
    inspectFailure?: boolean;
  }): Promise<T> {
    if (this.halted || (this.state.status !== "running")) {
      throw new WorkflowStopped(this.state);
    }
    const { operation, failureStatus = "stopped" } = options;
    if (!operation.trim()) return this.stop(new WorkflowError("fatal", "操作名が空"), "workflow");
    for (;;) {
      // 記録失敗を対象操作の一時的失敗として扱わない。
      try { await this.event("operation.started", { operation, retryCount: this.state.retryCount[operation] ?? 0 }); }
      catch (error) { return this.stop(error, operation); }
      let value: T;
      try { value = await options.run(); }
      catch (error) {
        if (error instanceof WorkflowStopped) throw error;
        const failure = classifyFailure(error);
        try { await this.event("operation.failed", { operation, classification: failure.classification, message: failure.message }); }
        catch (recordingError) { return this.stop(recordingError, operation); }
        if (failure.classification !== "transient" && !options.inspectFailure) return this.stop(failure, operation, failureStatus);
        let decision: RetryDecision<T>;
        // 再実行は一時的失敗に限定する。
        try { decision = await options.confirmRetry(failure); }
        catch (inspectionError) {
          if (inspectionError instanceof WorkflowStopped) throw inspectionError;
          if (inspectionError instanceof StorageError) return this.stop(inspectionError, operation);
          return this.stop(new WorkflowError("uncertain", "再実行の安全性を確認できない"), operation, failureStatus);
        }
        if (decision.outcome === "applied") {
          try { await this.event("operation.confirmed", { operation }); }
          catch (recordingError) { return this.stop(recordingError, operation); }
          return decision.value;
        }
        if (decision.outcome === "uncertain") return this.stop(new WorkflowError("uncertain", "操作の反映状態または再実行の安全性が不明"), operation, failureStatus);
        const retryCount = this.state.retryCount[operation] ?? 0;
        if (failure.classification !== "transient" || retryCount >= 2) return this.stop(failure, operation, failureStatus);
        this.state = { ...this.state, retryCount: { ...this.state.retryCount, [operation]: retryCount + 1 }, updatedAt: new Date().toISOString() };
        try {
          await this.store.saveGitHubState(this.state);
          await this.event("operation.retry", { operation, retryCount: retryCount + 1 });
        } catch (recordingError) { return this.stop(recordingError, operation); }
        continue;
      }
      try { await this.event("operation.succeeded", { operation }); }
      catch (error) { return this.stop(error, operation); }
      return value;
    }
  }

}
