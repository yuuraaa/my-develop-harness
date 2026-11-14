import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { GitHubError } from "./github.js";
import { GitHubControl, githubFailure } from "./github-control.js";
import type { GitHubConfig } from "./github-config.js";
import { issueEndpoint, githubId, normalizeIssueReference } from "./github-issue.js";
import { transitionIssueLabels, type IssueWriteApi } from "./github-labels.js";
import { issueReportDraftSchema, issueReportEvidence, issueReportMarkdown, type IssueReport } from "./github-report.js";
import { localBranch, readRemoteHeads, verifyIssueRemote, type RepositoryTransport } from "./github-repository.js";
import { BranchStore, type BranchRecord } from "./github-workspace-store.js";
import { gitInclusion, type PreparedIssueWorkspace } from "./github-workspace.js";
import type { GitCommand } from "./git.js";
import { WorkflowError } from "./workflow.js";

const now = () => new Date().toISOString();
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const stepSchema = z.object({ status: z.enum(["not_started", "in_flight", "succeeded", "failed", "unknown"]),
  attempts: z.number().int().nonnegative(), intendedAt: z.string().nullable(), completedAt: z.string().nullable(),
  expected: z.record(z.string(), z.json()), observed: z.record(z.string(), z.json()).nullable(),
  error: z.object({ classification: z.string(), message: z.string() }).nullable(), retryAfter: z.string().nullable() });
export const submissionSchema = z.object({ push: stepSchema, comment: stepSchema, reviewState: stepSchema });
type Submission = z.infer<typeof submissionSchema>;
const step = (expected: Submission["push"]["expected"]): Submission["push"] => ({ status: "not_started", attempts: 0,
  intendedAt: null, completedAt: null, expected, observed: null, error: null, retryAfter: null });

/** 新runの一回限りの提出。保存された意図があれば再開・再送しない。 */
export async function submitIssueResult(options: { control: GitHubControl; api: IssueWriteApi; config: GitHubConfig;
  prepared: PreparedIssueWorkspace; pushRemote: string; transport: RepositoryTransport; git: GitCommand }): Promise<"completed"> {
  const { control, api, config, prepared: p, pushRemote, transport, git } = options, store = control.store;
  const state = control.githubSnapshot(), issue = normalizeIssueReference(state.issue.url);
  if (state.phase !== "report" || state.phaseStatus !== "succeeded" || state.status !== "running" || !p.branchRecord || !p.branchName)
    throw new WorkflowError("fatal", "提出開始状態が不正です");
  const developmentState = control.snapshot(), development = { store, snapshot: () => developmentState };
  const stored = JSON.parse(await readFile(join(store.artifactsPath, "report.json"), "utf8"));
  const draft = issueReportDraftSchema.parse({ summary: stored.summary, changes: stored.changes, acceptanceCriteria: stored.acceptanceCriteria });
  const evidence = await issueReportEvidence(control, git), report: IssueReport = { ...evidence, ...draft };
  const body = await readFile(join(store.artifactsPath, "report.md"), "utf8");
  if (!isDeepStrictEqual(stored, report) || body !== issueReportMarkdown(report)) throw new WorkflowError("fatal", "保存済みIssue報告が最終成果と不一致です");
  const head = evidence.result.headCommit!, branch = p.branchName;
  const submission: Submission = {
    push: step({ remote: pushRemote, repository: issue.repository, destination: `https://github.com/${issue.repository}.git`,
      ref: `refs/heads/${branch}`, startCommit: state.remoteStartCommit, headCommit: head }),
    comment: step({ runId: state.runId, issueId: state.issue.issueId, endpoint: `${issueEndpoint(issue)}/comments`, bodySha256: hash(body) }),
    reviewState: step({ from: config.github.labels.running, to: config.github.labels.review }),
  };
  // 新規作成を先に行い、同runの再提出を拒否する。
  await store.saveJson("submission.json", submission);
  await control.patch({ submissionArtifact: "submission.json" });
  let record: BranchRecord = p.branchRecord;
  const branches = new BranchStore(store.root);
  const uncertain = new Set<keyof Submission>();
  const save = () => store.saveSubmission(submissionSchema.parse(submission));
  async function perform(key: keyof Submission, operation: () => Promise<void>) {
    const s = submission[key];
    await control.patch({ phase: key === "reviewState" ? "review_state" : key, phaseStatus: "running" });
    s.status = "in_flight"; s.intendedAt = now();
    await save();
    await store.appendEvent({ timestamp: now(), type: `submission.${key}.started`, phase: control.githubSnapshot().phase, data: { expected: s.expected } });
    let completed = false;
    try {
      await operation();
      completed = true;
      s.status = "succeeded"; s.completedAt = now(); await save();
      await store.appendEvent({ timestamp: now(), type: `submission.${key}.succeeded`, phase: control.githubSnapshot().phase, data: { observed: s.observed } });
      await control.patch({ phaseStatus: "succeeded" });
    } catch (error) {
      // 操作後の保存失敗もunknown。最後の永続記録in_flightを成功と解釈しない。
      const failure = githubFailure(error);
      s.status = completed || uncertain.has(key) ? "unknown"
        : error instanceof GitHubError && ["permission", "request", "rate_limit", "configuration"].includes(error.kind)
          || error instanceof WorkflowError && error.classification === "fatal" || s.attempts === 0 ? "failed" : "unknown";
      s.error = { classification: error instanceof GitHubError ? error.kind : failure.classification, message: failure.message };
      s.retryAfter = error instanceof GitHubError ? error.retryAt : null;
      await save().catch(() => {});
      throw error;
    }
  }
  await perform("push", async () => {
    const s = submission.push;
    await verifyIssueRemote(p.repositoryPath, issue.repository, pushRemote, git);
    const current = await branches.read(p.managementIssue);
    if (!isDeepStrictEqual(current, record) || await localBranch(p.repositoryPath, branch, git) !== record.localTip
      || (await git(p.repositoryPath, ["worktree", "list", "--porcelain", "-z"])).split("\0").includes(`branch refs/heads/${branch}`)
      || !record.localTip || (await gitInclusion(p.repositoryPath, git)(record.localTip, head)).status !== "included")
      throw new WorkflowError("fatal", "成果refまたはブランチ対応の期待値が変化しました");
    const before = (await readRemoteHeads(p.repositoryPath, transport)).heads.get(branch) ?? null;
    s.observed = { beforeCommit: before }; await save();
    if (before !== state.remoteStartCommit) throw new WorkflowError("fatal", "開始後にremote成果ブランチが変化しました");
    if (before && (await gitInclusion(p.repositoryPath, git)(before, head)).status !== "included") throw new WorkflowError("fatal", "成果はremoteへfast-forwardできません");
    await git(p.repositoryPath, ["update-ref", "--no-deref", `refs/heads/${branch}`, head, record.localTip]);
    const local = { ...record, localTip: head, updatedAt: now() };
    await branches.update(record, local); record = local;
    // 本文生成後にもレビュー済みtree・clean・全成果SHAを照合する。
    if (!isDeepStrictEqual(evidence, await issueReportEvidence(development, git))) throw new WorkflowError("fatal", "提出前に成果が変化しました");
    if (before !== head) {
      s.attempts = 1; await save();
      let failure: unknown;
      try { await transport(p.worktreePath, "push", [`${head}:refs/heads/${branch}`]); } catch (error) { failure = error; }
      if (failure instanceof GitHubError && failure.kind !== "unknown") throw failure;
      let after: string | null;
      try { after = (await readRemoteHeads(p.repositoryPath, transport)).heads.get(branch) ?? null; }
      catch (error) { uncertain.add("push"); throw error; }
      s.observed = { beforeCommit: before, afterCommit: after, reconciled: failure !== undefined }; await save();
      if (after !== head) {
        if (after === before) throw new GitHubError("request");
        throw new GitHubError("unknown");
      }
    } else { s.observed = { beforeCommit: before, afterCommit: head, alreadyPublished: true }; }
    const published = { ...record, remoteTip: head, updatedAt: now() };
    await branches.update(record, published); record = published;
  });
  await perform("comment", async () => {
    const s = submission.comment, endpoint = `${issueEndpoint(issue)}/comments`;
    const schema = z.object({ id: githubId, html_url: z.url(), body: z.string() });
    const reconcile = async () => {
      if (s.attempts) uncertain.add("comment");
      const comments = z.array(schema).parse(await api.getPages(endpoint));
      const matches = comments.filter(c => c.body.includes(state.runId));
      s.observed = { candidates: matches.map(c => ({ id: c.id, url: c.html_url, bodySha256: hash(c.body) })) }; await save();
      return matches.length === 1 && matches[0]!.body === body ? { confirmed: true as const, value: matches[0]! } : { confirmed: false as const };
    };
    // 同runの既存報告や矛盾があるときも新規投稿しない。
    const existing = await reconcile();
    let value: unknown;
    if (existing.confirmed) value = existing.value;
    else {
      if ((s.observed!.candidates as unknown[]).length) throw new GitHubError("unknown");
      s.attempts = 1; await save();
      value = await api.update("POST", endpoint, { body }, reconcile);
    }
    let parsed = schema.safeParse(value);
    if (!parsed.success || parsed.data.body !== body) {
      const confirmed = await reconcile();
      if (!confirmed.confirmed) throw new GitHubError("unknown");
      parsed = schema.safeParse(confirmed.value);
    }
    if (!parsed.success) throw new GitHubError("unknown");
    const c = parsed.data;
    if (!c.html_url.startsWith(`${issue.url}#issuecomment-`)) throw new GitHubError("unknown");
    s.observed = { commentId: c.id, url: c.html_url, bodySha256: hash(c.body) };
  });
  await perform("reviewState", async () => {
    const s = submission.reviewState;
    const actual = await transitionIssueLabels(api, store, issue, config.github.labels, "running", "review", "submission", {
      observe: async states => { s.observed = { states }; await save(); },
      write: async () => { s.attempts++; await save(); },
      unconfirmed: () => { if (s.attempts) uncertain.add("reviewState"); },
    });
    submission.reviewState.observed = { states: actual };
  });
  await control.patch({ status: "completed", phaseStatus: "succeeded", error: null });
  return "completed";
}
