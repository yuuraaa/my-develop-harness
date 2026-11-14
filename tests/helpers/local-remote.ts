import { join } from "node:path";
import { runGit } from "../../src/git.js";

/** 識別URLは残し、実通信だけをローカルbareへ転送する。外部へpushしない。 */
export async function localRemote(repo: string, root: string) {
  const bare = join(root, "fixture-remote.git");
  await runGit(root, ["clone", "--bare", "--", repo, bare]);
  for (const url of ["git@example.com:owner/repo.git", "https://example.com/owner/repo.git", "https://example.invalid/owner/repo.git",
    "git@github.com:owner/repo.git", "ssh://git@github.com/other/repo.git"]) {
    await runGit(repo, ["config", "--add", `url.${bare}.insteadOf`, url]);
  }
  return bare;
}
