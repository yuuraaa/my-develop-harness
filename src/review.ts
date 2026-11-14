import { CodexPhases } from "./codex.js";
import { reviewSchema, verificationSchema, type Review, type Verification } from "./schemas.js";
import { verifyImplementation } from "./verification.js";
import { WorkflowError, type DevelopmentControl } from "./workflow.js";

/** 判定は保存済みのハーネス記録に基づく。独自の修正指摘を生成しない。 */
export function assessReview(review: Review, verification: Verification): "passed" | "fix" {
  reviewSchema.parse(review);
  verificationSchema.parse(verification);
  const definitions = verification.validationPlan;
  if (new Set(definitions.map(d => d.id)).size !== definitions.length
    || verification.commands.length !== definitions.length
    || definitions.some((d, index) => JSON.stringify(d) !== JSON.stringify(verification.commands[index]?.definition))) {
    throw new WorkflowError("fatal", "Review整合性エラー: 検証コマンドの定義と実行記録が不一致");
  }
  const knownIds = new Set(definitions.map(d => d.id));
  for (const finding of review.findings) {
    if (new Set(finding.validationCommandIds).size !== finding.validationCommandIds.length) {
      throw new WorkflowError("fatal", "Review整合性エラー: validationCommandIdsに重複したコマンドIDがある");
    }
    for (const id of finding.validationCommandIds) {
      if (!knownIds.has(id)) throw new WorkflowError("fatal", `Review整合性エラー: 未知の検証コマンドID ${id}`);
    }
  }
  const mandatory = review.findings.filter(f => f.severity === "critical" || f.severity === "major");
  for (const command of verification.commands) {
    if (!command.definition.required || command.status === "passed") continue;
    // 指摘の根拠をコマンドIDと対応付ける。別の重大指摘で失敗を隠さない。
    if (!mandatory.some(f => f.validationCommandIds.includes(command.definition.id))) {
      throw new WorkflowError("fatal", `Review整合性エラー: 必須確認 ${command.definition.id} の${command.status}に対応するmajor以上の指摘がない`);
    }
  }
  if (review.blockers.length) throw new WorkflowError("fatal", "Reviewのblockersはblocked処理が必要");
  return mandatory.length || review.unverifiedItems.length ? "fix" : "passed";
}

const activeLoops = new WeakSet<DevelopmentControl>();

/** Implementation成功後から合格Reviewまで。コミット・提出は呼び出し側の後続工程。 */
export async function reviewImplementation(options: {
  control: DevelopmentControl; phases: CodexPhases;
  block?: (reasons: string[]) => Promise<never>;
}): Promise<{ review: Review; verification: Verification; attempt: number }> {
  const { control, phases } = options;
  if (activeLoops.has(control)) return control.stop(new WorkflowError("fatal", "Reviewループの並行実行は禁止"), "review.loop");
  activeLoops.add(control);
  try {
    return await control.execute({ operation: "review.loop", run: async () => {
      const initial = control.snapshot();
      if (initial.status !== "running" || initial.phase !== "implementation" || initial.phaseStatus !== "succeeded"
        || initial.fixCount !== 0 || initial.reviewThreadIds.length !== 0) {
        throw new WorkflowError("fatal", "Reviewループの開始状態が不正");
      }
      for (let attempt = 1; attempt <= 4; attempt++) {
        await verifyImplementation(control);
        await phases.review(attempt); // blockersと実行エラーはCodexPhasesの共通停止経路へ。
        const { input } = await control.store.loadReviewInput(attempt);
        const review = await control.store.loadArtifact("review", attempt);
        const decision = assessReview(review, input.verification);
        await control.store.appendEvent({ timestamp: new Date().toISOString(), type: "review.assessed", phase: "review", data: { attempt, decision } });
        if (decision === "passed") {
          const { captureWorktreeTree, fingerprintWorktree } = await import("./git.js");
          const state = control.snapshot();
          const fingerprint = input.verification.worktreeFingerprint;
          if (!fingerprint || await fingerprintWorktree(state.worktreePath) !== fingerprint) {
            throw new WorkflowError("uncertain", "レビュー合格時の対象が検証時から変更された");
          }
          const reviewedTreeId = await captureWorktreeTree(state.worktreePath);
          if (await fingerprintWorktree(state.worktreePath) !== fingerprint) throw new WorkflowError("uncertain", "ツリー取得中にレビュー対象が変更された");
          await control.recordCommitState({ reviewedTreeId, resultCommits: [] });
          return { review, verification: input.verification, attempt };
        }
        if (attempt === 4) {
          const reasons = ["最大3回のFix後もReviewの修正必須事項が残っている。review-4.jsonの指摘・未確認事項を確認し、対応方針を判断してください。"];
          if (options.block) await options.block(reasons);
          else throw new WorkflowError("fatal", "blocked処理が未接続");
        }
        await phases.fix(attempt); // Fix依頼時の加算。SDK再試行とは別の回数。
      }
      throw new WorkflowError("fatal", "Review回数が不整合");
    }, confirmRetry: async () => ({ outcome: "uncertain" }) });
  } finally { activeLoops.delete(control); }
}
