import { z } from "zod";
import { GitHubError } from "./github.js";
import { fetchIssueContext, evaluateIssueEligibility, localCommitFiles, type CommitFileReader, type IssueEligibility } from "./github-context.js";
import { normalizeIssueReference, fullSha, parseResponse, type IssueApi, type Issue } from "./github-issue.js";
import { inspectIssueRepository, workspaceGit, type IssueRepositorySelection } from "./github-repository.js";
import { BranchStore, sameIdentity, WorkspaceError, type WorkspaceIdentity } from "./github-workspace-store.js";
import { gitInclusion } from "./github-workspace.js";
import type { GitHubConfig } from "./github-config.js";
import type { GitCommand } from "./git.js";

const identity = (i: Issue): WorkspaceIdentity => ({ host: "github.com", repositoryId: i.repositoryId, repository: i.repository, issueId: i.id, number: i.number });
/** cloneがなくても開始SHAの資料を診断する。APIから読むだけでローカルobjectを作らない。 */
export function apiCommitFiles(api: IssueApi, repository: string): CommitFileReader {
  const entries = async (commit: string) => parseResponse(z.object({ truncated: z.literal(false),
    tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: fullSha })) }),
    await api.get(`/repos/${repository}/git/trees/${fullSha.parse(commit)}?recursive=1`)).tree;
  return {
    list: entries,
    async read(commit, path) {
      const entry = (await entries(commit)).find(e => e.path === path);
      if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw new WorkspaceError("資料が通常ファイルではありません");
      const blob = parseResponse(z.object({ encoding: z.literal("base64"), content: z.string(), size: z.number().int().nonnegative() }),
        await api.get(`/repos/${repository}/git/blobs/${entry.sha}`));
      const encoded = blob.content.replace(/\s/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new WorkspaceError("資料のbase64が不正です");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length !== blob.size) throw new WorkspaceError("資料のサイズが不一致です");
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    },
  };
}
export type IssueInspection = { eligibility: IssueEligibility; selection: IssueRepositorySelection | null; startCommit: string | null;
  worktreePath: string | null; previousRunId: string | null; warnings: string[] };
/** runと同じ文脈・着手判定を使う読み取り診断。fetch/clone/worktree/記録の作成はしない。 */
export async function inspectIssue(options: { api: IssueApi; config: GitHubConfig; root: string; issue: string;
  env?: NodeJS.ProcessEnv; repositoryPath?: string; git?: GitCommand }): Promise<IssueInspection> {
  const { api, config } = options, reference = normalizeIssueReference(options.issue);
  let context = await fetchIssueContext(api, config, reference.url);
  const basic = await evaluateIssueEligibility(api, config, { ...context, dependencies: [], sourcesComplete: true });
  if (basic.status !== "ready") return { eligibility: basic, selection: null, startCommit: null, worktreePath: null, previousRunId: null, warnings: [] };
  const git = options.git ?? await workspaceGit({ ...(options.env ? { env: options.env } : {}) });
  const selection = await inspectIssueRepository(reference.repository, config, git, options.repositoryPath);
  const store = new BranchStore(options.root), management = identity(context.managementIssue), target = identity(context.target.issue);
  const record = await store.read(management), runs = await store.runs(management, target);
  if (record?.creationStatus === "reserved") throw new WorkspaceError("reservedで中断しています。対応記録とrefを手動確認してください");
  if (!record && runs.some(r => r.branchName !== null)) throw new WorkspaceError("ブランチ対応記録が欠落しています");
  if (record && !runs.some(r => r.runId === record.decisionRunId && r.branchName === record.branchName && r.baseCommit === record.initialBaseCommit))
    throw new WorkspaceError("ブランチ対応と決定runが不一致です");
  const same = runs.filter(r => sameIdentity(r.issue, target) && r.worktreePath !== null);
  const previous = same.filter(r => !same.some(next => next.previousRunId === r.runId));
  if (previous.length > 1) throw new WorkspaceError("再利用候補が複数あります", previous.map(r => r.runId));
  const prior = previous[0];
  let start: string;
  if (prior) {
    start = fullSha.parse((await git(prior.worktreePath!, ["rev-parse", "--verify", "HEAD^{commit}"])).trim());
  } else {
    const branch = record?.branchName ?? parseResponse(z.object({ default_branch: z.string().min(1) }), await api.get(`/repos/${reference.repository}`)).default_branch;
    start = parseResponse(z.object({ sha: fullSha }), await api.get(`/repos/${reference.repository}/commits/${encodeURIComponent(branch)}`)).sha;
  }
  // ローカルに開始objectがなければAPIで資料・包含を読み、fetchは行わない。
  const path = prior?.worktreePath ?? selection.path;
  let local = false;
  if (path) try { local = (await git(path, ["rev-parse", "--verify", `${start}^{commit}`])).trim() === start; } catch { /* APIで診断 */ }
  context = await fetchIssueContext(api, config, reference.url, { startCommit: start,
    commitFiles: local ? localCommitFiles(path!, git) : apiCommitFiles(api, reference.repository) });
  const login = parseResponse(z.object({ login: z.string().min(1) }), await api.get("/user")).login;
  const eligibility = await evaluateIssueEligibility(api, config, context, { harnessLogin: login,
    checkInclusion: local ? gitInclusion(path!, git) : async (commit, base) => {
      try {
        const result = parseResponse(z.object({ status: z.enum(["identical", "ahead", "behind", "diverged"]) }),
          await api.get(`/repos/${reference.repository}/compare/${fullSha.parse(commit)}...${fullSha.parse(base)}`));
        return { status: ["identical", "ahead"].includes(result.status) ? "included" : "not_included" };
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return { status: "unconfirmed", reason: "比較対象のコミットを確認できません" };
        throw error;
      }
    } });
  return { eligibility, selection, startCommit: start, worktreePath: prior?.worktreePath ?? null, previousRunId: prior?.runId ?? null, warnings: store.warnings };
}
