import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { verifyResultCommits, type GitCommand } from "./git.js";
import { assessReview } from "./review.js";
import { resultSchema } from "./github-evidence.js";
import { WorkflowError, type DevelopmentControl } from "./workflow.js";

export const issueReportDraftSchema = z.strictObject({ summary: z.string().trim().min(1),
  changes: z.array(z.string().trim().min(1)).min(1),
  acceptanceCriteria: z.array(z.strictObject({ criterion: z.string().trim().min(1),
    result: z.string().trim().min(1), evidence: z.string().trim().min(1) })).min(1) });
export type IssueReportDraft = z.infer<typeof issueReportDraftSchema>;

/** 最終Reviewに渡した正式検証と最終Git成果を報告の事実として固定する。 */
export async function issueReportEvidence(control: Pick<DevelopmentControl, "store" | "snapshot">, git: GitCommand) {
  const state = control.snapshot(), attempt = state.reviewThreadIds.length;
  const { input } = await control.store.loadReviewInput(attempt);
  const review = await control.store.loadArtifact("review", attempt), commit = await control.store.loadArtifact("commit");
  const hashes = await verifyResultCommits(state, git);
  if (!state.issue || !state.branchName || !state.reviewedTreeId || !hashes.length
    || !isDeepStrictEqual(hashes, state.resultCommits) || !isDeepStrictEqual(commit.commitHashes, hashes)
    || commit.blockers.length || input.issueInput.issue.id !== state.issue.issueId
    || input.baseCommit !== state.baseCommit || input.verification.worktreePath !== state.worktreePath
    || state.verificationArtifact !== input.verificationArtifact || attempt !== state.fixCount + 1
    || assessReview(review, input.verification) !== "passed") throw new WorkflowError("fatal", "Issue報告と最終検証・Review・Git成果が不一致です");
  const headCommit = hashes.at(-1)!;
  const result = resultSchema.parse({ schemaVersion: 2, repository: state.issue.repository, issueNumber: state.issue.number,
    source: "harness", runId: state.runId, branch: state.branchName, baseCommit: state.baseCommit, headCommit,
    requiredCommits: hashes, noCommitRequired: false, reason: null, publication: "confirmed" });
  const remainingIssues = [...new Set([...input.implementation.remainingIssues, ...input.verification.undetectedValidation,
    ...input.redactions, ...review.unverifiedItems, ...review.findings.map(f => `${f.severity}: ${f.description}${f.location ? ` (${f.location})` : ""}`),
    ...input.verification.commands.flatMap(c => [
      ...(c.status === "passed" ? [] : [`${c.definition.id}: ${c.status} ${c.skippedReason ?? ""}`]),
      ...[c.stdout, c.stderr].filter(s => s.truncated).map(s => `${c.definition.id}: ${s.omittedReason}`),
    ])])];
  return { schemaVersion: 2 as const, backend: "github" as const, runId: state.runId, issue: state.issue,
    issueInput: input.issueInput, validation: input.verification, review, reviewAttempts: attempt,
    remainingIssues, result, compareUrl: `https://github.com/${state.issue.repository}/compare/${state.baseCommit}...${headCommit}` };
}
export type IssueReport = Awaited<ReturnType<typeof issueReportEvidence>> & IssueReportDraft;

/** publicationはpush照合後にだけ投稿する。この段階では保存済み投稿予定本文。 */
export function issueReportMarkdown(report: IssueReport): string {
  const checks = report.acceptanceCriteria.map(c => `- ${c.criterion}: ${c.result}（根拠: ${c.evidence}）`).join("\n");
  const validation = report.validation.commands.map(c => `- ${c.definition.id}: ${c.status}（終了コード: ${c.exitCode ?? "なし"}）${c.skippedReason ? ` ${c.skippedReason}` : ""}`).join("\n") || "実行コマンドなし";
  const narrative = `## 変更要約\n${report.summary}\n${report.changes.map(c => `- ${c}`).join("\n")}\n\n## 完了条件の確認\n${checks}\n\n## 正式検証\n${validation}\n\n## 独立レビュー\n${report.review.summary}\nReview ${report.reviewAttempts}回。重大指摘${report.review.findings.filter(f => f.severity !== "minor").length}件、軽微指摘${report.review.findings.filter(f => f.severity === "minor").length}件。\n\n## 未検証事項・残課題\n${report.remainingIssues.join("\n") || "なし"}\n\n## 成果\nrun ID: ${report.runId}\nブランチ: ${report.result.branch}\n成果コミット: ${report.result.requiredCommits.join(", ")}\n固定差分: ${report.compareUrl}\n`;
  // マーカーの説明を含む通常の文章は証拠マーカーとして数えさせない。
  return narrative.replaceAll("<!-- harness-result:", "&lt;!-- harness-result:")
    + `\n<!-- harness-result:v2\n${JSON.stringify(report.result, null, 2)}\n-->\n`;
}
