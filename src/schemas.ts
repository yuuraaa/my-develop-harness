import { z } from "zod";

const text = z.string();
const strings = z.array(text);
const nonempty = z.string().min(1);
const timestamp = z.iso.datetime();
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
export const runIdSchema = z.string().uuid();
export const phaseSchema = z.enum(["prepare", "start", "plan", "implementation", "fix", "verification", "review", "commit", "report", "push", "comment", "review_state"]);
export const validationDefinitionSchema = z.strictObject({
  id: nonempty, kind: z.enum(["prepare", "test", "typecheck", "build", "other"]), command: nonempty,
  workingDirectory: nonempty, executionMethod: nonempty, evidence: nonempty, required: z.boolean(),
});
/** 新規AI入力。削除前定義はハーネスが取得する。 */
export const validationInputUpdateSchema = z.union([
  z.strictObject({ operation: z.enum(["add", "update"]), definition: validationDefinitionSchema, reason: nonempty }),
  z.strictObject({ operation: z.literal("remove"), id: nonempty, reason: nonempty }),
]);
export const validationUpdateSchema = validationInputUpdateSchema;
export const validationHistorySchema = z.strictObject({
  operation: z.enum(["add", "update", "remove"]), id: nonempty, reason: nonempty,
  before: validationDefinitionSchema.nullable(), after: validationDefinitionSchema.nullable(),
});
export const validationSubmissionSchema = z.strictObject({
  phase: z.enum(["implementation", "fix"]), attempt: z.number().int().min(1).max(4),
  submission: z.number().int().min(1).max(3), candidate: z.json(),
  error: text.nullable(), accepted: z.boolean(),
});
export const planSchema = z.strictObject({
  summary: text, steps: strings, validationPlan: z.array(validationDefinitionSchema), undetectedValidation: strings, blockers: strings,
});
/** API用。候補の内容検証はGit/業務層で行い、再Planにつなぐ。 */
export const planOutputSchema = z.strictObject({ plan: planSchema, branchName: z.string().nullable() });
export const planStartSchema = z.strictObject({ attempt: z.number().int().min(1).max(3), readonly: z.literal(true),
  branchName: text.nullable(), reason: text.nullable() });
export const planSessionSchema = z.strictObject({ threadId: nonempty, readonly: z.literal(true) });
export const planDecisionSchema = z.strictObject({ accepted: z.boolean(), candidate: text.nullable(),
  branchName: text.nullable(), reason: text.nullable(), threadId: nonempty });
export const implementationSchema = z.strictObject({
  summary: text,
  validation: z.array(z.strictObject({ command: text, status: z.enum(["passed", "failed", "skipped"]), details: text })),
  validationPlanUpdates: z.array(validationUpdateSchema), remainingIssues: strings, blockers: strings,
});
export const implementationOutputSchema = implementationSchema.extend({
  validationPlanUpdates: z.array(validationInputUpdateSchema),
});
// 更新部分だけが不正なら診断付き再提出に回す。他の出力不正は従来どおり停止する。
export const implementationCandidateSchema = implementationSchema.extend({ validationPlanUpdates: z.json() });
export const validationRepairSchema = z.strictObject({ validationPlanUpdates: z.array(validationInputUpdateSchema) });
export const validationRepairCandidateSchema = z.strictObject({ validationPlanUpdates: z.json() });
export const reviewSchema = z.strictObject({
  summary: text,
  findings: z.array(z.strictObject({
    severity: z.enum(["critical", "major", "minor"]), description: nonempty,
    validationCommandIds: z.array(nonempty), location: text.nullable(),
  })),
  unverifiedItems: strings, blockers: strings,
});
/** Codexは計画だけを返す。SHAはハーネスが作成後に記録する。 */
export const commitPlanSchema = z.strictObject({
  summary: text,
  commits: z.array(z.strictObject({ message: nonempty, paths: z.array(nonempty).min(1) })),
  blockers: strings,
});
export const commitSchema = z.strictObject({ summary: text, commitHashes: z.array(sha), blockers: strings })
  .refine(v => v.commitHashes.length > 0 || v.blockers.length > 0, { message: "成果コミットまたは具体的なblockersが必要" });
export const outputSchema = z.strictObject({ text: z.string().max(65536), truncated: z.boolean(), omittedReason: text.nullable() })
  .refine(v => !v.truncated || !!v.omittedReason, { message: "出力省略の理由が必要" });
export const verificationCommandSchema = z.strictObject({
  definition: validationDefinitionSchema, startedAt: timestamp.nullable(), endedAt: timestamp.nullable(),
  exitCode: z.number().int().nullable(), status: z.enum(["passed", "failed", "skipped"]), skippedReason: text.nullable(),
  outcome: z.enum(["passed", "preparation_failed", "verification_failed", "permission_denied", "not_run"]).optional(),
  stdout: outputSchema, stderr: outputSchema,
  execution: z.strictObject({ program: nonempty, args: strings, workingDirectory: nonempty }).nullable().optional(),
}).refine(v => v.status === "skipped"
  ? v.exitCode === null && !!v.skippedReason
  : v.startedAt !== null && v.endedAt !== null && v.endedAt >= v.startedAt && v.exitCode !== null
    && v.skippedReason === null && (v.status !== "passed" || v.exitCode === 0),
{ message: "検証結果の状態・終了コード・未実施理由が不整合" });
export const validationResolutionSchema = z.strictObject({
  validationPlan: z.array(validationDefinitionSchema), validationPlanUpdates: z.array(validationUpdateSchema),
  validationHistory: z.array(validationHistorySchema), undetectedValidation: strings,
});
export const verificationSchema = z.strictObject({
  source: z.literal("harness"), attempt: z.number().int().min(1).max(4), worktreePath: nonempty,
  baseCommit: sha, diffId: sha, commands: z.array(verificationCommandSchema),
  worktreeFingerprint: sha.optional(),
  validationPlan: z.array(validationDefinitionSchema), validationPlanUpdates: z.array(validationUpdateSchema), undetectedValidation: strings,
  validationHistory: z.array(validationHistorySchema).optional(),
});
export const errorSchema = z.strictObject({ classification: nonempty, message: text, operation: text.nullable() });
export const eventSchema = z.strictObject({ timestamp, type: nonempty, phase: phaseSchema, data: z.record(text, z.json()) });
export const issueInputSchema = z.strictObject({ issue: z.record(text, z.json()), repositoryInstructions: strings });
export const reviewChecklist = [
  "要件・完了条件: 元の要件ごとに実装・検証の根拠を確認し、未実装・範囲外の変更を指摘する。",
  "Plan: 元の要件とリポジトリの設計・指示に合うか、Planの誤りをそのまま実装していないか確認する。",
  "累積差分: 不具合・回帰・境界条件・エラー処理・権限・秘密情報・既存設計との不整合を確認する。",
  "ハーネスの検証結果: 対象worktreeと差分への対応を確認。必須確認の失敗・未実施・原因不明は各コマンドIDをvalidationCommandIdsに列挙したmajor以上の指摘とし、原因・根拠・影響・必要な修正をdescriptionに記載する。locationはファイル・行・説明またはnull。1指摘で複数IDを参照でき、一般のコード指摘は空配列にする。IDは今回のvalidationPlanから選び、重複・未知IDは使わない。",
  "テストと検出範囲: コマンドの検出漏れ・実行対象の不足・必須確認の削除や弱体化を調査する。テストコードが意図した動作と回帰を検証し、単に成功させる変更になっていないか確認する。",
  "未解決・未確認事項: remainingIssues・未検出事項・出力省略・秘密除外の影響を確認。重要な未確認事項と完了条件違反はmajor以上、または具体的な人間対応が必要なblockersで返す。unverifiedItemsは合格を妨げる未確認事項に限る。",
  "合格条件: critical/major・重要な未確認事項・blockersがなく、要件充足の根拠があり必須確認がすべて成功していること。テスト成功のみでは合格にしない。",
] as const;
export const reviewInputSchema = z.strictObject({
  attempt: z.number().int().min(1).max(4), issueInput: issueInputSchema, plan: planSchema,
  implementation: implementationSchema, verification: verificationSchema,
  baseCommit: sha, diffId: sha, diffArtifact: nonempty, verificationArtifact: nonempty, redactions: strings,
  checklist: strings.default([...reviewChecklist]),
  implementationHistory: z.array(implementationSchema).min(1).max(4).optional(),
  validationSubmissions: z.array(validationSubmissionSchema).optional(),
});
export type Plan = z.infer<typeof planSchema>;
export type Implementation = z.infer<typeof implementationSchema>;
export type Verification = z.infer<typeof verificationSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type RunState = import("./workflow.js").DevelopmentState;
export type RunEvent = z.infer<typeof eventSchema>;
export type IssueInput = z.infer<typeof issueInputSchema>;
export type ReviewInput = z.infer<typeof reviewInputSchema>;
