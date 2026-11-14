import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GitCommandError, runGit, type GitCommand } from "./git.js";
import { WorkflowError } from "./workflow-error.js";
import type { GitHubConfig } from "./github-config.js";

export type RepositoryConfig = NonNullable<GitHubConfig["repository"]>;
type Clone = { path: string; remotes: { name: string; urls: string[] }[] };
function fail(message: string): never { throw new WorkflowError("business", message); }
async function info(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function rejectSymlinkAncestors(path: string): Promise<void> {
  let cursor = resolve(path);
  for (;;) {
    if ((await info(cursor))?.isSymbolicLink()) fail(`${path}: symlinkを含む探索先はたどりません`);
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function remotes(path: string, git: GitCommand): Promise<Clone> {
  const names = (await git(path, ["remote"])).trim().split("\n").filter(Boolean);
  const result: Clone = { path, remotes: [] };
  for (const name of names) {
    if (!/^(?!-)[\w./-]+$/.test(name)) fail(`${path}: remote名を安全に解釈できません`);
    result.remotes.push({ name, urls: (await git(path, ["config", "--get-all", `remote.${name}.url`])).trim().split("\n").filter(Boolean) });
  }
  return result;
}
async function ordinary(path: string, git: GitCommand): Promise<Clone> {
  const stat = await info(path), metadata = await info(join(path, ".git"));
  if (!stat?.isDirectory() || stat.isSymbolicLink() || !metadata?.isDirectory() || metadata.isSymbolicLink()) fail(`${path}: 通常のcloneではありません`);
  const canonical = await realpath(path);
  if (await realpath((await git(path, ["rev-parse", "--show-toplevel"])).trim()) !== canonical
    || (await git(path, ["rev-parse", "--is-bare-repository"])).trim() !== "false") fail(`${path}: 通常のcloneではありません`);
  return remotes(canonical, git);
}

/** 不完全な探索を「一致なし」へ変換しない。symlinkと.gitファイルの先へ降りない。 */
export async function discoverClones(config: RepositoryConfig, git: GitCommand = runGit): Promise<Clone[]> {
  if (!config.searchRoots?.length || !config.cloneRoot) fail("自動選択にはrepository.searchRootsとrepository.cloneRootが必要です");
  const found: Clone[] = [], boundaries: string[] = [], visited = new Set<string>();
  const visit = async (path: string, optional = false): Promise<void> => {
    try {
      const stat = await info(path);
      if (!stat && optional) return;
      if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`${path}: 探索先が存在しない・ディレクトリではない・symlinkです`);
      const canonical = await realpath(path);
      if (visited.has(canonical) || boundaries.some(boundary => canonical.startsWith(boundary + "/"))) return;
      visited.add(canonical);
      // readdir自体の失敗も必須の探索失敗として扱う。
      const entries = await readdir(canonical, { withFileTypes: true });
      const metadata = entries.find(entry => entry.name === ".git");
      if (metadata) {
        boundaries.push(canonical);
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) found.push(await ordinary(canonical, git));
        return;
      }
      // 名前だけでbareと決めずGitで確認する。通常フォルダを見落とさない。
      if (entries.some(entry => entry.name === "HEAD" && entry.isFile()) && entries.some(entry => entry.name === "objects" && entry.isDirectory())) {
        try { if ((await git(canonical, ["rev-parse", "--is-bare-repository"])).trim() === "true") { boundaries.push(canonical); return; } }
        catch (error) { if (!(error instanceof GitCommandError && error.exitCode === 128)) throw error; }
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isDirectory() || entry.name.startsWith(".harness-clone-pending-")) continue;
        await visit(join(canonical, entry.name));
      }
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new WorkflowError("fatal", `${path}: 探索を確認できません (${code === "EACCES" || code === "EPERM" ? "権限不足" : "読取・Git確認失敗"})`);
    }
  };
  for (const root of [...config.searchRoots!].sort((a, b) => a.length - b.length)) {
    await rejectSymlinkAncestors(root);
    await visit(root);
  }
  // 未作成のcloneRootは作成可能な祖先まで確認する。読取不能を一致なしにしない。
  try {
    await rejectSymlinkAncestors(config.cloneRoot!);
    const root = await info(config.cloneRoot!);
    if (root && (!root.isDirectory() || root.isSymbolicLink())) fail(`${config.cloneRoot}: cloneRootを確認できません`);
    if (root) await readdir(config.cloneRoot!);
    else {
      let ancestor = dirname(config.cloneRoot!);
      while (!await info(ancestor)) ancestor = dirname(ancestor);
      await readdir(ancestor);
    }
    await visit(join(config.cloneRoot!, "harness-clone"), true);
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new WorkflowError("fatal", `${config.cloneRoot}: cloneRootの探索を確認できません (${code === "EACCES" || code === "EPERM" ? "権限不足" : "読取失敗"})`);
  }
  return found;
}
