import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { GitCommandError, fingerprintWorktree, readHeadBranch, type GitCommand } from "./git.js";
import type { CheckInclusion } from "./github-evidence.js";
import { fullSha } from "./github-issue.js";
import { captureReviewDiff, environmentSecrets } from "./state.js";
import { isolatedGitHubEnvironment } from "./github-auth.js";
import { BranchStore, WorkspaceError, contentBranchSchema, pathInfo, recordMatches, sameIdentity, workspaceIdentitySchema,
  type BranchRecord, type WorkspaceIdentity, type WorkspaceRun } from "./github-workspace-store.js";
import { fetchExact, localBranch, readRemoteHeads, verifyIssueRemote, type RemoteHeads, type RepositoryTransport } from "./github-repository.js";

/** 欠落object・Git障害は未確認。非包含と区別し、成果を自動取得/mergeしない。 */
export function gitInclusion(path: string, git: GitCommand): CheckInclusion {
  return async (commit, startCommit) => {
    if (!fullSha.safeParse(commit).success || !fullSha.safeParse(startCommit).success) return { status: "unconfirmed", reason: "完全SHAが必要です" };
    try {
      // replace/graftsによる見かけ上の包含を信頼しない。
      const grafts = resolve(path, (await git(path, ["rev-parse", "--git-path", "info/grafts"])).trim());
      if (await pathInfo(grafts)) return { status: "unconfirmed", reason: "graftsが存在します" };
      for (const sha of [commit, startCommit]) if ((await git(path, ["--no-replace-objects", "rev-parse", "--verify", `${sha}^{commit}`])).trim() !== sha)
        return { status: "unconfirmed", reason: "コミットobjectが未確認です" };
      try { await git(path, ["--no-replace-objects", "merge-base", "--is-ancestor", commit, startCommit]); return { status: "included" }; }
      catch (e) { if (e instanceof GitCommandError && e.exitCode === 1) return { status: "not_included" }; throw e; }
    } catch { return { status: "unconfirmed", reason: "Git包含を確認できません" }; }
  };
}
async function requireIncluded(path: string, commit: string, start: string, git: GitCommand, reason: string) {
  if ((await gitInclusion(path, git)(commit, start)).status !== "included") throw new WorkspaceError(reason);
}
async function commonDirectory(path: string, git: GitCommand) {
  return realpath(resolve(path, (await git(path, ["rev-parse", "--git-common-dir"])).trim()));
}
async function checkedOut(path: string, branch: string, git: GitCommand): Promise<boolean> {
  return (await git(path, ["worktree", "list", "--porcelain", "-z"])).split("\0").includes(`branch refs/heads/${branch}`);
}
function conflict(a: string, b: string): boolean { return a === b || a.startsWith(b + "/") || b.startsWith(a + "/"); }
export type PreparedIssueWorkspace = WorkspaceRun & { repositoryPath: string; worktreePath: string; baseCommit: string;
  startCommit: string; branchRecord: BranchRecord | null; remoteHeads: RemoteHeads; warnings: string[];
  restart: null | { previousRunId: string; worktreeOriginRunId: string; worktreePath: string; restartHead: string;
    fingerprint: string; cumulativeDiff: string; instructionDiff: string; previousRuns: string[]; redacted: boolean; redactions: string[] } };
export type WorkspaceOptions = {
  root: string; runId: string; issue: WorkspaceIdentity; managementIssue: WorkspaceIdentity;
  managementContent: { title: string; body: string | null; comments: string[] };
  repositoryPath: string; pushRemote?: string; git: GitCommand; transport: RepositoryTransport;
  /** 開始点に対する依存確認・指示/必須資料取得。未充足なら例外で止め、worktreeを作らない。 */
  confirmStart: (startCommit: string, check: CheckInclusion, restart: PreparedIssueWorkspace["restart"]) => Promise<void>;
  /** stateへ実パスを永続保存する。必ずworktree作成前に呼ぶ。過去runへは書き込まない。 */
  savePrepared: (prepared: PreparedIssueWorkspace) => Promise<void>;
  redact: (text: string) => string;
};
/** 日時で選ばず、連続した再実行chainの末尾だけを一意な候補にする。 */
function restartCandidate(runs: WorkspaceRun[], issue: WorkspaceIdentity): WorkspaceRun | null {
  const same = runs.filter(r => r.issue.repositoryId === issue.repositoryId && r.issue.issueId === issue.issueId);
  if (same.some(r => !sameIdentity(r.issue, issue))) throw new WorkspaceError("過去Issueの名前/番号/IDが不一致です");
  const candidates = same.filter(r => r.worktreePath !== null);
  if (!candidates.length) return null;
  for (const run of candidates) {
    if (run.previousRunId) {
      const previous = same.find(r => r.runId === run.previousRunId);
      if (!previous || previous.worktreePath !== run.worktreePath || previous.worktreeOriginRunId !== run.worktreeOriginRunId
        || previous.baseCommit !== run.baseCommit || !sameIdentity(previous.managementIssue, run.managementIssue))
        throw new WorkspaceError("再実行chainが欠落・不一致です", [run.runId]);
    } else if (run.worktreeOriginRunId !== run.runId) throw new WorkspaceError("初回worktreeのrun IDが不一致です", [run.runId]);
    const visited = new Set<string>();
    let cursor: WorkspaceRun | undefined = run;
    while (cursor) {
      if (visited.has(cursor.runId)) throw new WorkspaceError("再実行chainが循環しています");
      visited.add(cursor.runId); cursor = same.find(r => r.runId === cursor!.previousRunId);
    }
  }
  const leaves = candidates.filter(r => !candidates.some(next => next.previousRunId === r.runId));
  if (leaves.length !== 1) throw new WorkspaceError("worktree候補が複数です。履歴と実物を確認してください", leaves.map(r => r.worktreePath!));
  return leaves[0]!;
}
async function validatePrevious(run: WorkspaceRun, options: WorkspaceOptions, record: BranchRecord | null, allowRemoved = false) {
  const { git } = options;
  if (!run.repositoryPath || !run.worktreePath || !run.baseCommit || !sameIdentity(run.managementIssue, options.managementIssue)
    || (run.branchName !== (record?.branchName ?? null)) || run.branchRecordPath !== (record ? new BranchStore(options.root).path(options.managementIssue) : null))
    throw new WorkspaceError("過去runとブランチ対応が不一致です", [run.runId]);
  if (await realpath(run.repositoryPath) !== await realpath(options.repositoryPath))
    throw new WorkspaceError("過去runのcloneが不一致です", [run.runId]);
  const origin = z.uuid().parse(run.worktreeOriginRunId);
  if (run.workBranchName !== null && (!record || run.workBranchName !== `harness/run/${origin}`))
    throw new WorkspaceError("作業用ブランチが不一致です", [run.runId]);
  if (!await pathInfo(run.worktreePath) && allowRemoved && run.workBranchName) {
    const head = await localBranch(options.repositoryPath, run.workBranchName, git);
    if (!head) throw new WorkspaceError("削除済みworktreeの成果コミットを確認できません", [run.runId]);
    await requireIncluded(options.repositoryPath, run.baseCommit, head, git, "過去成果が開始点を含みません");
    return head;
  }
  if (!await pathInfo(run.worktreePath)
    || await commonDirectory(run.worktreePath, git) !== await commonDirectory(options.repositoryPath, git))
    throw new WorkspaceError("worktreeが欠落・破損・別cloneです", [run.worktreePath]);
  if (await readHeadBranch(run.worktreePath, git) !== (run.workBranchName ? `refs/heads/${run.workBranchName}` : null))
    throw new WorkspaceError("worktree実パス/作業用ブランチが不一致です", [run.worktreePath]);
  const listed = (await git(options.repositoryPath, ["worktree", "list", "--porcelain", "-z"])).split("\0");
  if (!listed.includes(`worktree ${await realpath(run.worktreePath)}`)) throw new WorkspaceError("Gitにworktreeが登録されていません", [run.worktreePath]);
  const head = fullSha.parse((await git(run.worktreePath, ["rev-parse", "HEAD"])).trim());
  await requireIncluded(run.worktreePath, run.baseCommit, head, git, "再利用HEADが最初の開始点を含みません");
  return head;
}

export async function prepareIssueWorkspace(options: WorkspaceOptions): Promise<PreparedIssueWorkspace> {
  z.uuid().parse(options.runId); workspaceIdentitySchema.parse(options.issue); workspaceIdentitySchema.parse(options.managementIssue);
  if (options.issue.repositoryId !== options.managementIssue.repositoryId || options.issue.repository !== options.managementIssue.repository)
    throw new WorkspaceError("管理単位のリポジトリが不一致です");
  const path = await realpath(options.repositoryPath), { git, transport } = options;
  await verifyIssueRemote(path, options.issue.repository, options.pushRemote ?? "origin", git);
  const store = new BranchStore(options.root), record = await store.read(options.managementIssue), runs = await store.runs(options.managementIssue, options.issue, options.runId);
  if (record?.creationStatus === "reserved") throw new WorkspaceError("reservedで中断しています。記録とrefを手動確認してください", [store.path(options.managementIssue)]);
  const related = runs.filter(r => r.managementIssue.repositoryId === options.managementIssue.repositoryId && r.managementIssue.issueId === options.managementIssue.issueId);
  if (related.some(r => !sameIdentity(r.managementIssue, options.managementIssue))) throw new WorkspaceError("管理単位の名前/番号/IDが過去runと不一致です");
  if (!record && related.some(r => r.branchName !== null)) throw new WorkspaceError("過去runのブランチ対応記録が欠落しています");
  if (record) {
    const decision = related.find(r => r.runId === record.decisionRunId);
    if (!decision) throw new WorkspaceError("ブランチ決定runの記録が欠落しています");
    if (decision.baseCommit !== record.initialBaseCommit || decision.branchName !== record.branchName
      || decision.branchRecordPath !== store.path(options.managementIssue))
      throw new WorkspaceError("対応記録とブランチ決定runの開始点/名前/記録先が不一致です");
  }
  const previous = restartCandidate(runs, options.issue), remote = await readRemoteHeads(path, transport, !record && !previous);
  let local: string | null = null, remoteTip: string | null = null;
  if (record) {
    if (await checkedOut(path, record.branchName, git)) throw new WorkspaceError("成果ブランチが別worktreeでcheckout中です");
    local = await localBranch(path, record.branchName, git);
    if (local !== record.localTip) throw new WorkspaceError("成果ブランチのローカルrefが記録と不一致です");
    remoteTip = remote.heads.get(record.branchName) ?? null;
    if (record.remoteTip !== null && remoteTip === null) throw new WorkspaceError("公開済み成果ブランチがremoteにありません");
    if (remoteTip) await fetchExact(path, record.branchName, remoteTip, git, transport);
    await requireIncluded(path, record.initialBaseCommit, local!, git, "成果refが初回開始点を含みません");
    if (record.remoteTip && remoteTip) await requireIncluded(path, record.remoteTip, remoteTip, git, "remote成果ブランチが巻き戻り・分岐しています");
  }
  // 別Issueの未公開変更をreadyや新runで無視しない。chain末尾の実物を確認する。
  const others = new Map<string, WorkspaceIdentity>();
  for (const run of related) if (!sameIdentity(run.issue, options.issue) && run.worktreePath) others.set(run.issue.issueId, run.issue);
  for (const issue of others.values()) {
    const other = restartCandidate(runs, issue)!;
    const latestPublication = await store.publicationStatus(other.runId);
    for (const run of related.filter(r => sameIdentity(r.issue, issue))) {
      const status = await store.publicationStatus(run.runId);
      if (latestPublication !== "succeeded" && (status === "in_flight" || status === "unknown"))
        throw new WorkspaceError("別Issueのpush成否が未確認です。提出記録を人間が確認してください", [run.runId]);
    }
    const head = await validatePrevious(other, options, record, true);
    if (!remoteTip || await pathInfo(other.worktreePath!) && (await git(other.worktreePath!, ["status", "--porcelain=v1", "--untracked-files=all"])).trim())
      throw new WorkspaceError("別Issueの未公開変更があります。そのIssueを再実行するか人間が整理してください", [other.runId]);
    await requireIncluded(path, head, remoteTip, git, "別Issueの未pushコミットがあります");
  }
  let start: string, base: string, worktreePath: string, workBranchName: string | null;
  let restart: PreparedIssueWorkspace["restart"] = null;
  if (previous) {
    start = await validatePrevious(previous, options, record); base = previous.baseCommit!; worktreePath = previous.worktreePath!; workBranchName = previous.workBranchName;
    if (remoteTip) await requireIncluded(path, remoteTip, start, git, "remote成果が再利用HEADより先行・分岐しています");
    if (local) await requireIncluded(path, local, start, git, "ローカル成果refが再利用HEADより先行・分岐しています");
    const capture = await captureReviewDiff(worktreePath, base, environmentSecrets(), {
      ...await isolatedGitHubEnvironment(), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1",
    });
    const rawDiff = capture.diff;
    const instructionDiff = await git(worktreePath, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", ":(glob)**/AGENTS.md", ":(glob)**/AGENTS.override.md", ":(glob)**/CLAUDE.md"]);
    const cumulativeDiff = options.redact(rawDiff), safeInstructions = options.redact(instructionDiff);
    restart = { previousRunId: previous.runId, worktreeOriginRunId: previous.worktreeOriginRunId, worktreePath, restartHead: start,
      fingerprint: await fingerprintWorktree(worktreePath, git), cumulativeDiff, instructionDiff: safeInstructions,
      previousRuns: related.filter(r => sameIdentity(r.issue, options.issue)).map(r => join(resolve(options.root), "runs", r.runId)),
      redacted: capture.redactions.length > 0 || cumulativeDiff !== rawDiff || safeInstructions !== instructionDiff, redactions: capture.redactions };
  } else {
    if (record) {
      if (!remoteTip) throw new WorkspaceError("別Issueへ引き継げる公開済み成果ブランチがありません");
      await requireIncluded(path, local!, remoteTip, git, "ローカル成果refがremoteより先行・分岐しています");
      start = remoteTip;
    } else {
      // 初回の元cloneはclean・既定ブランチ・ff-onlyという既存条件を維持する。
      if (!remote.defaultBranch || !remote.defaultCommit) throw new WorkspaceError("初回の既定ブランチが未確認です");
      if (await readHeadBranch(path, git) !== `refs/heads/${remote.defaultBranch}` || (await git(path, ["status", "--porcelain=v1", "--untracked-files=all"])).trim())
        throw new WorkspaceError("初回はcleanな既定ブランチのcloneが必要です");
      await fetchExact(path, remote.defaultBranch, remote.defaultCommit, git, transport);
      const before = fullSha.parse((await git(path, ["rev-parse", "HEAD"])).trim());
      await requireIncluded(path, before, remote.defaultCommit, git, "元cloneに独自コミットまたは履歴分岐があります");
      if (before !== remote.defaultCommit) await git(path, ["-c", "merge.autoStash=false", "merge", "--ff-only", remote.defaultCommit]);
      start = remote.defaultCommit;
    }
    const directory = join(resolve(options.root), "worktrees");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    base = start; worktreePath = join(await realpath(directory), options.runId); workBranchName = null;
    if (await pathInfo(worktreePath)) throw new WorkspaceError("新規worktree保存先が既存です", [worktreePath]);
  }
  // ここで依存未充足/資料不足を止める。ready→runningは呼び出し側がPlan後に行う。
  await options.confirmStart(start, gitInclusion(path, git), restart);
  let currentRecord = record;
  if (record && remoteTip && local !== remoteTip && !previous) {
    await git(path, ["update-ref", "--no-deref", `refs/heads/${record.branchName}`, remoteTip, local!]); local = remoteTip;
  }
  if (record && (record.localTip !== local || record.remoteTip !== remoteTip)) {
    currentRecord = { ...record, localTip: local, remoteTip, updatedAt: new Date().toISOString() };
    await store.update(record, currentRecord);
  }
  const prepared: PreparedIssueWorkspace = { schemaVersion: 2, backend: "github", runId: options.runId, issue: options.issue,
    managementIssue: options.managementIssue, repositoryPath: path, worktreePath, previousRunId: previous?.runId ?? null,
    worktreeOriginRunId: previous?.worktreeOriginRunId ?? options.runId, branchName: record?.branchName ?? null,
    workBranchName, branchRecordPath: record ? store.path(options.managementIssue) : null, baseCommit: base,
    restartHead: previous ? start : null, remoteStartCommit: remoteTip, startCommit: start, branchRecord: currentRecord, remoteHeads: remote, warnings: store.warnings, restart };
  await options.savePrepared(prepared);
  if (!previous) {
    await git(path, ["worktree", "add", "--detach", worktreePath, start]);
    if (await commonDirectory(worktreePath, git) !== await commonDirectory(path, git)
      || await readHeadBranch(worktreePath, git) !== null || (await git(worktreePath, ["rev-parse", "HEAD"])).trim() !== start)
      throw new WorkspaceError("新規worktreeの開始点を確認できません");
  }
  return prepared;
}

export async function validateContentBranch(path: string, name: string | null, store: BranchStore, identity: WorkspaceIdentity,
  remote: RemoteHeads, git: GitCommand): Promise<string | null> {
  if (!contentBranchSchema.safeParse(name).success) return "feature/fix/hotfix/chore/docs/refactor/<英語ケバブケース>で内容を命名してください";
  try { await git(path, ["check-ref-format", "--branch", name!]); }
  catch (e) { if (e instanceof GitCommandError && e.exitCode === 128) return "Gitのブランチ形式に適合しません"; throw e; }
  const names = (await git(path, ["for-each-ref", "--format=%(refname)", "refs/heads/"])).trim().split("\n").map(r => r.replace(/^refs\/heads\//, ""));
  if ([...names, ...remote.heads.keys(), ...await store.reservedNames(identity.repositoryId)].some(n => conflict(n, name!))) return "ローカル/remote/対応予約の名前と衝突します";
  if (await checkedOut(path, name!, git)) return "別worktreeで使用中です";
  return null;
}
/** 読み取りPlanを最大3回。既存対応では名前を再生成しない。同じ呼出しで対象Issueの計画も作る。 */
export async function planIssueBranch(prepared: PreparedIssueWorkspace, options: Pick<WorkspaceOptions, "root" | "git" | "transport" | "savePrepared" | "managementContent"> & {
  plan: (input: { attempt: number; branchName: string | null; reason: string | null; managementIssue: WorkspaceIdentity;
    managementContent: WorkspaceOptions["managementContent"]; namingInstruction: string }) => Promise<string | null>;
}): Promise<PreparedIssueWorkspace> {
  const { git } = options, store = new BranchStore(options.root);
  const fingerprint = await fingerprintWorktree(prepared.worktreePath, git);
  let name = prepared.branchName, reason: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const candidate = await options.plan({ attempt, branchName: name, reason, managementIssue: prepared.managementIssue, managementContent: options.managementContent,
      namingInstruction: name ? "保存済みの成果ブランチ名を再利用する。改名しない。対象Issueの新しいPlanを作る。"
        : "管理単位Issue全体の本文・コメント・作業内容から意味のある英語ケバブケースで命名する。Issue番号から機械的に生成しない。" });
    if (await fingerprintWorktree(prepared.worktreePath, git) !== fingerprint) throw new WorkspaceError("読み取り専用Plan中にworktreeが変更されました");
    const remote = await readRemoteHeads(prepared.repositoryPath, options.transport);
    if (prepared.branchName) {
      if ((remote.heads.get(prepared.branchName) ?? null) !== prepared.remoteStartCommit) throw new WorkspaceError("Plan中にremote成果ブランチが変化しました");
      break;
    }
    reason = await validateContentBranch(prepared.repositoryPath, candidate, store, prepared.managementIssue, remote, git);
    if (reason === null) { name = candidate; break; }
  }
  if (!name) throw new WorkspaceError(`初回込み3回のPlanで命名できません: ${reason}`);
  const workBranchName = prepared.workBranchName ?? `harness/run/${prepared.worktreeOriginRunId}`;
  // 後続Issueの新worktreeも内部ブランチだけをcheckoutする。
  if (!prepared.workBranchName && await localBranch(prepared.repositoryPath, workBranchName, git)) throw new WorkspaceError("作業用ブランチが既存です");
  let record = prepared.branchRecord;
  if (!record) {
    record = { schemaVersion: 2, host: "github.com", repositoryId: prepared.managementIssue.repositoryId, repository: prepared.managementIssue.repository,
      managementIssueId: prepared.managementIssue.issueId, managementIssueNumber: prepared.managementIssue.number, branchName: name,
      decisionRunId: prepared.runId, initialBaseCommit: prepared.baseCommit, creationStatus: "reserved", localTip: null, remoteTip: null, updatedAt: new Date().toISOString() };
    await store.reserve(record); // 必ずref作成より先。中断しても自動復旧しない。
    await git(prepared.repositoryPath, ["update-ref", "--no-deref", `refs/heads/${name}`, prepared.baseCommit, "0".repeat(prepared.baseCommit.length)]);
  } else {
    const latest = await store.read(prepared.managementIssue);
    if (!latest || JSON.stringify(latest) !== JSON.stringify(record) || !recordMatches(record, prepared.managementIssue)) throw new WorkspaceError("Plan中に対応記録が変化しました");
  }
  if (!prepared.workBranchName) await git(prepared.worktreePath, ["checkout", "-b", workBranchName, prepared.startCommit]);
  if (await readHeadBranch(prepared.worktreePath, git) !== `refs/heads/${workBranchName}`
    || (await git(prepared.worktreePath, ["rev-parse", "HEAD"])).trim() !== prepared.startCommit
    || await localBranch(prepared.repositoryPath, name, git) !== (record.creationStatus === "reserved" ? prepared.baseCommit : record.localTip))
    throw new WorkspaceError("作業用ブランチまたは成果refを確認できません");
  if (record.creationStatus === "reserved") {
    const created = { ...record, creationStatus: "created" as const, localTip: prepared.baseCommit, updatedAt: new Date().toISOString() };
    await store.update(record, created); record = created;
  }
  const result = { ...prepared, branchName: name, workBranchName, branchRecord: record, branchRecordPath: store.path(prepared.managementIssue),
    warnings: [...new Set([...prepared.warnings, ...store.warnings])] };
  await options.savePrepared(result);
  return result;
}
