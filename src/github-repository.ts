import { mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GitCommandError, normalizeRepositoryUrl, type GitCommand } from "./git.js";
import { discoverClones } from "./repository.js";
import { githubProcess, isolatedGitHubEnvironment, runAuthenticatedGit, type GitHubProcess } from "./github-auth.js";
import { repositoryNameSchema, type GitHubConfig } from "./github-config.js";
import { fullSha } from "./github-issue.js";
import type { GitHubRecord } from "./github.js";
import { pathInfo, WorkspaceError } from "./github-workspace-store.js";

/** ローカル操作は空HOMEで実行。認証設定の検査は明示認証を渡す通信境界で行う。 */
export async function workspaceGit(options: { env?: NodeJS.ProcessEnv; run?: GitHubProcess; secrets?: readonly string[] } = {}): Promise<GitCommand> {
  const env = await isolatedGitHubEnvironment(options.env), run = options.run ?? githubProcess;
  env.GIT_NO_REPLACE_OBJECTS = "1"; env.GIT_NO_LAZY_FETCH = "1";
  return async (cwd, args) => {
    const result = await run("git", ["-c", "submodule.recurse=false", ...args], env, undefined, cwd);
    if (result.code !== 0) throw new GitCommandError(result.code);
    let output = result.stdout;
    for (const secret of options.secrets ?? []) if (secret) output = output.split(secret).join("[REDACTED]");
    return output;
  };
}
export type RepositoryTransport = (cwd: string, operation: "clone" | "fetch" | "push" | "ls-remote", refs: string[], destination?: string) => Promise<string>;
export function repositoryTransport(options: { repository: string; token: string; env?: NodeJS.ProcessEnv; run?: GitHubProcess;
  record?: (event: GitHubRecord) => Promise<void> }): RepositoryTransport {
  return async (cwd, operation, refs, destination) => (await runAuthenticatedGit({ ...options, cwd, operation, refs,
    ...(destination === undefined ? {} : { destination }) })).stdout;
}
function matches(url: string, repository: string): boolean {
  // GitHubのrepo名は大小文字を同一視する。URL内の認証は受け入れない。
  if (/^https?:\/\/[^/]*@/i.test(url)) return false;
  return normalizeRepositoryUrl(url)?.toLowerCase() === `github.com/${repository}`;
}
export type IssueRepositorySelection = { repository: string; path: string | null; destination: string | null; pushRemote: string; cloned: boolean };
/** Issue所属repoだけを選択する。作業先はIssueの所属リポジトリで確定する。 */
export async function inspectIssueRepository(repository: string, config: GitHubConfig, git: GitCommand,
  explicitPath?: string): Promise<IssueRepositorySelection> {
  repository = repositoryNameSchema.parse(repository);
  const remote = config.repositories[repository]?.pushRemote ?? "origin";
  let paths: { path: string; urls: string[] }[];
  if (explicitPath !== undefined) {
    const path = await realpath((await git(await realpath(resolve(explicitPath)), ["rev-parse", "--show-toplevel"])).trim());
    const names = (await git(path, ["remote"])).trim().split("\n").filter(Boolean);
    const urls: string[] = [];
    for (const name of names) urls.push(...(await git(path, ["remote", "get-url", "--all", name])).trim().split("\n").filter(Boolean));
    paths = [{ path, urls }];
  } else paths = (await discoverClones(config.repository ?? {}, git)).map(c => ({ path: c.path, urls: c.remotes.flatMap(r => r.urls) }));
  const matching = paths.filter(p => p.urls.some(u => matches(u, repository)));
  if (matching.length > 1) throw new WorkspaceError("複数のcloneが一致します。--repoで指定してください", matching.map(p => p.path));
  if (matching.length === 1) {
    const selected = { repository, path: matching[0]!.path, destination: null, pushRemote: remote, cloned: false };
    await verifyIssueRemote(selected.path, repository, remote, git);
    return selected;
  }
  if (explicitPath !== undefined || !config.repository?.cloneRoot) throw new WorkspaceError("Issue所属リポジトリとcloneが一致しません");
  return { repository, path: null, destination: join(config.repository.cloneRoot, "harness-clone", ...repository.split("/")), pushRemote: remote, cloned: false };
}
export async function verifyIssueRemote(path: string, repository: string, remote: string, git: GitCommand): Promise<void> {
  if (!remote || remote.startsWith("-") || /[\x00-\x20\x7f]/.test(remote)) throw new WorkspaceError("push remote名が不正です");
  const names = (await git(path, ["remote"])).trim().split("\n");
  if (!names.includes(remote)) throw new WorkspaceError("設定したpush remoteがありません");
  for (const args of [["remote", "get-url", "--all", remote], ["remote", "get-url", "--push", "--all", remote]]) {
    const urls = (await git(path, args)).trim().split("\n").filter(Boolean);
    if (urls.length !== 1 || !matches(urls[0]!, repository)) throw new WorkspaceError("fetch/push先が不一致または複数です。fork提出には対応しません");
  }
}
/** clone失敗時も保存先を残し、自動再送・削除で途中成果を消さない。 */
export async function acquireIssueRepository(selection: IssueRepositorySelection, git: GitCommand, transport: RepositoryTransport): Promise<string> {
  if (selection.path) return selection.path;
  if (!selection.destination) throw new WorkspaceError("clone保存先が未確定です");
  await mkdir(dirname(selection.destination), { recursive: true, mode: 0o700 });
  if (await pathInfo(selection.destination)) throw new WorkspaceError("clone保存先が既存です", [selection.destination]);
  // git clone自身の作成競合検査に任せ、空でない保存先には合流しない。
  await transport(dirname(selection.destination), "clone", [], selection.destination);
  selection.path = await realpath(selection.destination); selection.cloned = true;
  if (selection.pushRemote !== "origin") await git(selection.path, ["remote", "rename", "origin", selection.pushRemote]);
  await verifyIssueRemote(selection.path, selection.repository, selection.pushRemote, git);
  return selection.path;
}
export type RemoteHeads = { defaultBranch: string | null; defaultCommit: string | null; heads: Map<string, string> };
export async function readRemoteHeads(path: string, transport: RepositoryTransport, requireDefault = false): Promise<RemoteHeads> {
  const output = await transport(path, "ls-remote", requireDefault ? ["HEAD", "refs/heads/*"] : ["refs/heads/*"]);
  const defaults = [...output.matchAll(/^ref: refs\/heads\/(.+)\tHEAD$/gm)];
  const heads = new Map<string, string>();
  let head: string | null = null;
  for (const line of output.trim().split("\n").filter(Boolean)) {
    if (line.startsWith("ref: ")) continue;
    const match = /^([a-f0-9]{40}|[a-f0-9]{64})\t(HEAD|refs\/heads\/(.+))$/.exec(line);
    if (!match) throw new WorkspaceError("remoteのref応答を確認できません");
    if (match[2] === "HEAD") { if (head !== null) throw new WorkspaceError("remote HEADが重複しています"); head = match[1]!; }
    else { if (heads.has(match[3]!)) throw new WorkspaceError("remoteブランチが重複しています"); heads.set(match[3]!, match[1]!); }
  }
  if (requireDefault && (defaults.length !== 1 || head === null || heads.get(defaults[0]![1]!) !== head)) throw new WorkspaceError("remoteの既定ブランチを一意に確定できません");
  return { defaultBranch: defaults[0]?.[1] ?? null, defaultCommit: head, heads };
}
export async function localBranch(path: string, name: string, git: GitCommand): Promise<string | null> {
  const lines = (await git(path, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", `refs/heads/${name}`])).split("\n").filter(Boolean);
  const fields = lines.map(line => line.split("\0")).find(parts => parts[0] === `refs/heads/${name}`);
  if (!fields) return null;
  if (fields.length !== 3 || fields[2]) throw new WorkspaceError("ブランチrefがsymbolic refまたは不正です");
  return fullSha.parse(fields[1]);
}
export async function fetchExact(path: string, name: string, expected: string, git: GitCommand, transport: RepositoryTransport): Promise<void> {
  fullSha.parse(expected);
  await git(path, ["check-ref-format", `refs/heads/${name}`]);
  await transport(path, "fetch", [`refs/heads/${name}`]);
  if ((await git(path, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).trim() !== expected)
    throw new WorkspaceError("取得中にremoteブランチが変化しました");
}
