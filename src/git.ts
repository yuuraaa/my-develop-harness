import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, readlink, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { WorkflowError } from "./workflow-error.js";

export type GitCommand = (cwd: string, args: string[]) => Promise<string>;
/** 終了コードだけを保持し、stderrの認証値を公開しない。 */
export class GitCommandError extends WorkflowError {
  constructor(readonly exitCode: number | null, classification: "fatal" | "transient" = "fatal") {
    super(classification, "Gitコマンドの実行に失敗");
  }
}
const exec = promisify(execFile);
export function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_"))), GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes", GIT_SSH_VARIANT: "ssh", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false", GIT_OPTIONAL_LOCKS: "0", GCM_INTERACTIVE: "Never" };
}
/** shellを使わず、生のGit出力・remoteの認証値を例外や記録に含めない。 */
export const runGit: GitCommand = async (cwd, args) => {
  const env = gitEnvironment(process.env);
  try {
    return (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false", ...args],
      { cwd, env, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    throw new GitCommandError(typeof code === "number" ? code : null, ["EAGAIN", "EBUSY", "ETXTBSY"].includes(String(code ?? "")) ? "transient" : "fatal");
  }
};

/** 実indexをコピーした一時indexで最終ツリーを作る。ステージ状態を変更しない。 */
export async function captureWorktreeTree(path: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harness-index-"));
  try {
    const index = join(directory, "index");
    await copyFile(resolve(path, (await runGit(path, ["rev-parse", "--git-path", "index"])).trim()), index);
    const env = gitEnvironment(process.env);
    const git = async (args: string[]) => (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false", ...args],
      { cwd: path, env: { ...env, GIT_INDEX_FILE: index }, maxBuffer: 4 * 1024 * 1024 })).stdout;
    await git(["add", "--all", "--", ":/"]);
    // コピー先indexの新しいmtimeでracyなstat情報を信用しないよう、全内容を再読する。
    await git(["add", "--renormalize", "--", ":/"]);
    const tree = (await git(["write-tree"])).trim();
    if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Error();
    return tree;
  } catch { throw new WorkflowError("fatal", "レビュー対象ツリーの取得に失敗"); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

/** Gitのclean filter・改行正規化が隠す内容変更も検出する。index・HEADには依存しない。 */
export async function fingerprintWorktreeContents(path: string, git: GitCommand = runGit): Promise<string> {
  const hash = createHash("sha256");
  const paths = [...new Set((await git(path, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean))].sort();
  for (const file of paths) {
    try {
      const info = await lstat(join(path, file));
      hash.update(JSON.stringify([file, info.mode]));
      if (info.isSymbolicLink()) hash.update(JSON.stringify(await readlink(join(path, file))));
      else if (info.isFile()) hash.update(createHash("sha256").update(await readFile(join(path, file))).digest());
      else throw new WorkflowError("uncertain", "コミット対象に通常ファイル以外が存在");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return hash.digest("hex");
}

/** 全計画を検証してから、レビュー済みのファイル単位でコミットする。失敗時は巻き戻さない。 */
export async function executeCommitPlan(path: string, reviewedTree: string,
  commits: { message: string; paths: string[] }[], git: GitCommand = runGit,
  identity?: { name: string; email: string }): Promise<void> {
  const fail = () => { throw new WorkflowError("fatal", "コミット計画がレビュー済みの変更ファイルと不一致"); };
  const head = (await git(path, ["rev-parse", "HEAD"])).trim();
  if (await captureWorktreeTree(path) !== reviewedTree) fail();
  const changed = (await git(path, ["diff", "--name-only", "--no-renames", "-z", head, reviewedTree])).split("\0").filter(Boolean);
  const planned = commits.flatMap(commit => commit.paths);
  if (new Set(planned).size !== planned.length || planned.length !== changed.length
    || planned.some(file => !changed.includes(file) || file.startsWith("/") || file.split("/").some(part => !part || part === "." || part === ".."))
    || commits.some(commit => !commit.paths.length || !commit.message.trim() || commit.message.includes("\0"))) fail();
  if (!commits.length) return;
  const contents = await fingerprintWorktreeContents(path, git);
  // 部分ステージ済みの内容を取り込まないよう、indexだけをHEADに揃える。実ファイルは保持する。
  await git(path, ["read-tree", "HEAD"]);
  for (const commit of commits) {
    if (await fingerprintWorktreeContents(path, git) !== contents) fail();
    await git(path, ["add", "--all", "--", ...commit.paths.map(file => `:(literal)${file}`)]);
    const staged = (await git(path, ["diff", "--cached", "--name-only", "--no-renames", "-z"])).split("\0").filter(Boolean);
    if (staged.length !== commit.paths.length || staged.some(file => !commit.paths.includes(file))) fail();
    await git(path, [...(identity ? ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`] : []),
      "commit", "-m", commit.message]);
  }
}

/** baseからの直線的な追加履歴のみを許可し、各commitの対象パスも照合する。 */
export async function verifyResultCommits(state: import("./workflow.js").DevelopmentState, git: GitCommand = runGit): Promise<string[]> {
  const path = state.worktreePath;
  const fail = () => { throw new WorkflowError("fatal", "コミット後のGit整合性違反"); };
  if (!state.reviewedTreeId || (await git(path, ["symbolic-ref", "HEAD"])).trim() !== `refs/heads/${state.workBranchName ?? state.branchName}`
    || (await git(path, ["rev-parse", "HEAD^{tree}"])).trim() !== state.reviewedTreeId
    || (await git(path, ["status", "--porcelain=v1", "--untracked-files=all"])).trim()) fail();
  const reviewStart = state.issue ? state.executionHead ?? state.baseCommit : state.baseCommit;
  const paths = (await git(path, ["diff", "--name-only", "--no-renames", "-z", reviewStart, state.reviewedTreeId!])).split("\0").filter(Boolean);
  if (state.issue && (await git(path, ["rev-parse", "HEAD"])).trim() === state.baseCommit) {
    if (reviewStart !== state.baseCommit) fail();
    return [state.baseCommit];
  }
  if (!paths.length && !state.issue) fail();
  const lines = (await git(path, ["rev-list", "--reverse", "--topo-order", "--parents", `${state.baseCommit}..HEAD`])).trim().split("\n");
  let parent = state.baseCommit;
  let checkingNewCommits = !state.issue || reviewStart === state.baseCommit;
  const commits: string[] = [];
  for (const line of lines) {
    const parts = line.split(" ");
    if (parts.length !== 2 || parts[1] !== parent || !/^[a-f0-9]{40,64}$/.test(parts[0]!)) fail();
    const commit = parts[0]!;
    if (parent === reviewStart) checkingNewCommits = true;
    const changed = (await git(path, ["diff", "--name-only", "--no-renames", "-z", parent, commit])).split("\0").filter(Boolean);
    if (!changed.length || checkingNewCommits && changed.some(file => !paths.includes(file))) fail();
    commits.push(commit); parent = commit;
  }
  if (!commits.length || !checkingNewCommits && parent !== reviewStart
    || (await git(path, ["rev-parse", "HEAD"])).trim() !== parent) fail();
  return commits;
}

/** マスキング済み差分を使わず、未追跡・index・履歴を含めて再実行前の同一性を確認する。 */
export async function fingerprintWorktree(path: string, git: GitCommand = runGit, headRepresentation?: string | null): Promise<string> {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(headRepresentation === undefined ? await readHeadBranch(path, git) : headRepresentation));
  for (const args of [["rev-parse", "HEAD"],
    ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"]]) {
    hash.update(JSON.stringify(await git(path, args)));
  }
  const paths = [...new Set((await git(path, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean))].sort();
  for (const file of paths) {
    hash.update(JSON.stringify(file));
    try {
      const info = await lstat(join(path, file));
      hash.update(String(info.mode));
      if (info.isSymbolicLink()) hash.update(JSON.stringify(await readlink(join(path, file))));
      else if (info.isFile()) hash.update(createHash("sha256").update(await readFile(join(path, file))).digest());
      else throw new WorkflowError("uncertain", "再試行確認対象に通常ファイル以外が存在");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") hash.update("deleted");
      else throw error;
    }
  }
  return hash.digest("hex");
}

/** hostだけ大小文字を同一視する。未知の方式・ポート・URLの付加情報は推測しない。 */
export function normalizeRepositoryUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || /[\s\\\x00-\x1f\x7f]/.test(value)) return null;
  let host: string, path: string;
  const scp = /^(?:[^@/:]+@)?([^/:]+):([^/].*)$/.exec(value);
  if (!value.includes("://") && scp) {
    host = scp[1]!.toLowerCase(); path = scp[2]!;
  } else {
    try {
      const url = new URL(value);
      if (!["https:", "ssh:"].includes(url.protocol) || url.search || url.hash || !url.hostname
        || url.port && !(url.protocol === "ssh:" && url.port === "22")) return null;
      // URLによるdot-segment解消・percent decodeで別パスを同一視しない。
      path = value.slice(value.indexOf("://") + 3).replace(/^[^/]*\//, "");
      if (!value.slice(value.indexOf("://") + 3).includes("/")) return null;
      host = url.hostname.toLowerCase();
    } catch { return null; }
  }
  path = path.replace(/\/$/, "").replace(/\.git$/, "");
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".") || host.startsWith(".") || host.endsWith(".")) return null;
  if (!path || path.split("/").some(part => !part || part === "." || part === ".." || /[%?#@:]/.test(part))) return null;
  return `${host}/${path}`;
}

/** --quietの終了1だけがdetachedの証拠。任意のGit障害は伝播する。 */
export async function readHeadBranch(path: string, git: GitCommand = runGit): Promise<string | null> {
  try {
    const ref = (await git(path, ["symbolic-ref", "--quiet", "HEAD"])).trim();
    if (!ref.startsWith("refs/heads/")) throw new WorkflowError("fatal", "HEADの参照が不正");
    return ref;
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return null;
    throw error;
  }
}
