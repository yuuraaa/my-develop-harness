import { createHash } from "node:crypto";
import { z } from "zod";
import { repositoryNameSchema } from "./github-config.js";
import { GitHubError } from "./github.js";
import { fullSha, parseResponse, type IssueApi, type IssueDocument, type IssueComment } from "./github-issue.js";

export const resultSchema = z.strictObject({
  schemaVersion: z.literal(2), repository: repositoryNameSchema, issueNumber: z.number().int().positive().safe(),
  source: z.enum(["harness", "human"]), runId: z.uuid().nullable(), branch: z.string().min(1).nullable(),
  baseCommit: fullSha.nullable(), headCommit: fullSha.nullable(), requiredCommits: z.array(fullSha),
  noCommitRequired: z.boolean(), reason: z.string().nullable(), publication: z.literal("confirmed"),
}).superRefine((r, ctx) => {
  const valid = r.noCommitRequired
    ? r.source === "human" && r.runId === null && !!r.reason?.trim() && r.branch === null && r.baseCommit === null && r.headCommit === null && !r.requiredCommits.length
    : !!r.branch && !!r.baseCommit && !!r.headCommit && r.requiredCommits.includes(r.headCommit)
      && new Set(r.requiredCommits).size === r.requiredCommits.length
      && (r.source === "harness" ? r.runId !== null : r.runId === null);
  if (!valid) ctx.addIssue({ code: "custom", message: "成果証拠の矛盾" });
});
export type ResultEvidence = z.infer<typeof resultSchema>;
export type EvidenceSelection = { status: "confirmed"; result: ResultEvidence; comment: IssueComment;
  bodySha256: string; permission: string; fetchedAt: string } | { status: "waiting"; reason: string };
/** 権限が不可視の候補を飛ばして古い証拠を採用しない。 */
export async function selectDependencyEvidence(api: IssueApi, document: IssueDocument, login: string | null): Promise<EvidenceSelection> {
  const candidates = document.comments.filter(c => c.body.includes("<!-- harness-result:"))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
  for (const comment of candidates) {
    if (!comment.user) return { status: "waiting", reason: "投稿者を確認できない" };
    const markers = [...comment.body.matchAll(/<!-- harness-result:([^\s]+)\s*([\s\S]*?)-->/g)];
    let raw: unknown;
    try { raw = markers.length === 1 ? JSON.parse(markers[0]![2]!) : null; } catch { raw = null; }
    const source = raw && typeof raw === "object" && "source" in raw ? raw.source : null;
    let permission: string;
    try {
      const p = parseResponse(z.object({ permission: z.string(), user: z.object({ id: z.union([z.string(), z.number()]), login: z.string() }) }),
        await api.get(`/repos/${document.issue.repository}/collaborators/${encodeURIComponent(comment.user.login)}/permission`));
      if (String(p.user.id) !== comment.user.id || p.user.login.toLowerCase() !== comment.user.login.toLowerCase())
        return { status: "waiting", reason: "投稿者権限の照合不一致" };
      permission = p.permission;
    } catch (error) {
      if (error instanceof GitHubError && (error.kind === "permission" || error.status === 404))
        return { status: "waiting", reason: "投稿者権限を確認できない" };
      throw error;
    }
    const sameLogin = login !== null && comment.user.login.toLowerCase() === login.toLowerCase();
    const humanPermission = comment.user.type === "User" && ["write", "maintain", "admin"].includes(permission);
    // source自体が壊れた最新報告も、信頼可能な投稿者なら古い候補へ戻さない。
    const trusted = source === "harness" ? sameLogin : source === "human" ? humanPermission : sameLogin || humanPermission;
    if (!trusted) continue;
    const parsed = resultSchema.safeParse(raw);
    if (markers.length !== 1 || (comment.body.match(/<!-- harness-result:/g)?.length ?? 0) !== 1 || markers[0]?.[1] !== "v2" || !parsed.success
      || parsed.data.repository !== document.issue.repository || parsed.data.issueNumber !== document.issue.number)
      return { status: "waiting", reason: "最新の信頼できる成果報告が不正・未公開・対象不一致" };
    return { status: "confirmed", result: parsed.data, comment, permission,
      bodySha256: createHash("sha256").update(comment.body).digest("hex"), fetchedAt: new Date().toISOString() };
  }
  return { status: "waiting", reason: "信頼できる成果証拠がない" };
}

export type Inclusion = { status: "included" | "not_included" | "unconfirmed"; reason?: string };
/** 実際の開始点・Git包含を確認する。未確認では通さない。 */
export type CheckInclusion = (commit: string, startCommit: string) => Promise<Inclusion>;
export type DependencyDecision = { issue: string; status: "satisfied" | "waiting"; reason: string;
  evidence: EvidenceSelection | null; inclusion: { commit: string; startCommit: string; status: Inclusion["status"]; reason?: string }[] };
export async function evaluateDependency(api: IssueApi, document: IssueDocument, login: string | null,
  startCommit: string | null, check?: CheckInclusion): Promise<DependencyDecision> {
  const decision: DependencyDecision = { issue: document.issue.url, status: "waiting", reason: "完了としてcloseされていない", evidence: null, inclusion: [] };
  if (document.issue.state !== "closed" || document.issue.state_reason !== "completed") return decision;
  const evidence = await selectDependencyEvidence(api, document, login);
  decision.evidence = evidence;
  if (evidence.status !== "confirmed") return { ...decision, reason: evidence.reason };
  if (evidence.result.noCommitRequired) return { ...decision, status: "satisfied", reason: "人間による成果コミット不要の表明" };
  if (!startCommit || !fullSha.safeParse(startCommit).success || !check) return { ...decision, reason: "開始点またはGit包含が未確認" };
  // requiredCommitsに加え、報告headがbaseと必要成果の履歴を含むことも確認する。
  for (const [commit, target] of [
    ...evidence.result.requiredCommits.map(c => [c, startCommit] as const),
    ...[evidence.result.baseCommit!, ...evidence.result.requiredCommits].map(c => [c, evidence.result.headCommit!] as const),
  ]) {
    const result = await check(commit, target);
    decision.inclusion.push({ commit, startCommit: target, ...result });
    if (result.status !== "included") return { ...decision, reason: result.status === "not_included" ? "依存成果が未包含、または成果履歴が不整合" : "Git包含が未確認" };
  }
  return { ...decision, status: "satisfied", reason: "完了・成果証拠・Git包含を確認" };
}
