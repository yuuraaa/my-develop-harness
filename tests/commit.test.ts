import { mkdtemp, readFile, rm, writeFile, symlink, chmod, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { runGit, GitCommandError, executeCommitPlan, captureWorktreeTree } from "../src/git.js";
import { setupDevelopment } from "./helpers/development.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup(prepareSource?: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "harness-commit-")); roots.push(root);
  const f = await setupDevelopment(root, prepareSource);
  const plan = { summary: "ファイル単位で分割", commits: [{ message: "✨ 実装", paths: ["partial.txt"] }], blockers: [] as string[] };
  const output = f.behavior.output;
  f.behavior.output = phase => phase === "commit" ? plan : output(phase);
  const afterCommit = { called: false };
  f.afterReview.run = async ({ phases }) => { await phases.commit(); afterCommit.called = true; };
  return { ...f, plan, afterCommit };
}

describe("ハーネスによるファイル単位のコミット（実Git）", () => {
  it.each([1, 2])("%i件の計画からハーネスがコミットしSHAを保存する", async count => {
    const f = await setup();
    const during = f.behavior.duringStream;
    f.behavior.duringStream = async phase => {
      await during(phase);
      if (phase === "implementation") await writeFile(join(f.store.worktreePath, "second.txt"), "second");
    };
    if (count === 1) f.plan.commits[0]!.paths.push("second.txt");
    else f.plan.commits.push({ message: "✨ 二つ目", paths: ["second.txt"] });
    expect(await f.run()).toBe("running");
    const state = await f.store.loadGitHubState();
    expect(state.resultCommits).toHaveLength(count);
    expect((await f.store.loadArtifact("commit")).commitHashes).toEqual(state.resultCommits);
    expect((await runGit(state.worktreePath, ["rev-parse", "HEAD^{tree}"])).trim()).toBe(state.reviewedTreeId!);
    expect((await runGit(state.worktreePath, ["status", "--porcelain"])).trim()).toBe("");
    expect(f.prompts.at(-1)).toContain("git add・git commit・index操作・ファイル変更・履歴変更は禁止");
    expect(f.prompts.at(-1)).toContain('"changedPaths"');
    expect(f.afterCommit.called).toBe(true);
    if (count === 2) expect((await runGit(state.worktreePath, ["diff-tree", "--no-commit-id", "--name-only", "-r", state.resultCommits[0]!])).trim()).toBe("partial.txt");
  });

  it.each(["duplicate", "missing", "extra", "traversal", "directory", "empty-message", "empty-group"])("不正計画%sはindexも履歴も変更せず停止する", async mode => {
    const f = await setup(); let beforeIndex = "";
    f.behavior.beforeStream = async phase => {
      if (phase === "commit") beforeIndex = await runGit(f.store.worktreePath, ["diff", "--cached", "--binary"]);
    };
    if (mode === "duplicate") f.plan.commits.push({ message: "重複", paths: ["partial.txt"] });
    if (mode === "missing") f.plan.commits = [];
    if (mode === "extra") f.plan.commits[0]!.paths.push("check.cjs");
    if (mode === "traversal") f.plan.commits[0]!.paths = ["../partial.txt"];
    if (mode === "directory") f.plan.commits[0]!.paths = ["."];
    if (mode === "empty-message") f.plan.commits[0]!.message = " ";
    if (mode === "empty-group") f.plan.commits[0]!.paths = [];
    expect(await f.run()).toBe("stopped");
    const state = await f.store.loadGitHubState();
    expect((await runGit(state.worktreePath, ["rev-parse", "HEAD"])).trim()).toBe(state.baseCommit);
    expect(await runGit(state.worktreePath, ["diff", "--cached", "--binary"])).toBe(beforeIndex);
    expect(f.afterCommit.called).toBe(false);
  });

  it.each(["content", "index", "commit"])("Codexによる%s変更を検出しハーネスのコミットには進まない", async mode => {
    const f = await setup(); const during = f.behavior.duringStream;
    f.behavior.duringStream = async phase => {
      await during(phase); if (phase !== "commit") return;
      if (mode === "content") await writeFile(join(f.store.worktreePath, "partial.txt"), "未レビュー");
      else {
        await runGit(f.store.worktreePath, ["add", "."]);
        if (mode === "commit") await runGit(f.store.worktreePath, ["commit", "-m", "不正"]);
      }
    };
    expect(await f.run()).toBe("stopped");
    expect(f.afterCommit.called).toBe(false);
    expect((await f.store.loadGitHubState()).resultCommits).toEqual([]);
  });

  it("二つ目のcommit失敗時は作成済みコミットと残りの変更を保持して再試行しない", async () => {
    const f = await setup(); const during = f.behavior.duringStream; let attempts = 0;
    f.behavior.duringStream = async phase => {
      await during(phase);
      if (phase === "implementation") await writeFile(join(f.store.worktreePath, "second.txt"), "second");
    };
    f.plan.commits.push({ message: "✨ 二つ目", paths: ["second.txt"] });
    f.behavior.git = async (cwd, args) => {
      if (args.includes("commit") && ++attempts === 2) throw new GitCommandError(1);
      return runGit(cwd, args);
    };
    expect(await f.run()).toBe("stopped");
    const state = await f.store.loadGitHubState();
    expect(attempts).toBe(2);
    expect((await runGit(state.worktreePath, ["rev-list", "--count", `${state.baseCommit}..HEAD`])).trim()).toBe("1");
    expect(await readFile(join(state.worktreePath, "second.txt"), "utf8")).toBe("second");
    expect((await runGit(state.worktreePath, ["diff", "--cached", "--name-only"])).trim()).toBe("second.txt");
    expect(f.phasesCalled.filter(p => p === "commit")).toHaveLength(1);
    expect(f.afterCommit.called).toBe(false);
  });

  it("部分ステージ・削除・実行属性・symlink・特殊なファイル名を正確にコミットする", async () => {
    const f = await setup(async path => {
      await writeFile(join(path, "deleted.txt"), "base");
      await runGit(path, ["add", "."]); await runGit(path, ["commit", "-m", "base file"]);
    }); const during = f.behavior.duringStream;
    const special = ":(glob)* [a]\n.txt";
    f.behavior.duringStream = async phase => {
      await during(phase);
      if (phase !== "implementation") return;
      const path = f.store.worktreePath;
      await unlink(join(path, "deleted.txt"));
      await writeFile(join(path, "staged.txt"), "index"); await runGit(path, ["add", "staged.txt"]);
      await writeFile(join(path, "staged.txt"), "final");
      await writeFile(join(path, "exec.sh"), "#!/bin/sh\n"); await chmod(join(path, "exec.sh"), 0o755);
      await symlink("staged.txt", join(path, "link")); await writeFile(join(path, special), "literal");
    };
    f.plan.commits[0]!.paths.push("staged.txt", "exec.sh", "link", special, "deleted.txt");
    expect([await f.run(), (await f.store.loadGitHubState()).error]).toEqual(["running", null]);
    expect(await readFile(join(f.store.worktreePath, "staged.txt"), "utf8")).toBe("final");
    expect(await runGit(f.store.worktreePath, ["ls-tree", "HEAD", "exec.sh", "link"])).toContain("100755");
    expect(await runGit(f.store.worktreePath, ["ls-tree", "HEAD", "link"])).toContain("120000");
  });
  it("コミット作成者の設定をハーネスのGit実行に適用する", async () => {
    const f = await setup(); await f.run();
    const path = f.store.worktreePath;
    await writeFile(join(path, "identity.txt"), "identity");
    await executeCommitPlan(path, await captureWorktreeTree(path), [{ message: "✨ 作成者", paths: ["identity.txt"] }],
      runGit, { name: "Harness Author", email: "harness@example.invalid" });
    expect((await runGit(path, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).trim())
      .toBe("Harness Author <harness@example.invalid>|Harness Author <harness@example.invalid>");
  });

  it("blockersのある計画はGit書き込みをせず停止する", async () => {
    const f = await setup(); f.plan.blockers.push("コミット規約の判断が必要");
    expect(await f.run()).toBe("blocked");
    const state = await f.store.loadGitHubState();
    expect((await runGit(state.worktreePath, ["rev-parse", "HEAD"])).trim()).toBe(state.baseCommit);
    expect(f.afterCommit.called).toBe(false);
  });

  it("計画開始前の一時障害だけを再試行し、コミットは一度だけ作成する", async () => {
    const f = await setup(); let attempts = 0;
    f.behavior.beforeStream = async phase => {
      if (phase === "commit" && attempts++ < 2) throw Object.assign(new Error(), { code: "EAI_AGAIN" });
    };
    expect(await f.run()).toBe("running");
    const state = await f.store.loadGitHubState();
    expect(state.resultCommits).toHaveLength(1);
    expect(f.phasesCalled.filter(p => p === "commit")).toHaveLength(3);
  });

  it("計画の途中でSDKが失敗した場合はGit操作せず停止する", async () => {
    const f = await setup(); const during = f.behavior.duringStream;
    f.behavior.duringStream = async phase => {
      await during(phase);
      if (phase === "commit") throw Object.assign(new Error(), { code: "EAI_AGAIN" });
    };
    expect(await f.run()).toBe("stopped");
    const state = await f.store.loadGitHubState();
    expect((await runGit(state.worktreePath, ["rev-parse", "HEAD"])).trim()).toBe(state.baseCommit);
    expect(f.phasesCalled.filter(p => p === "commit")).toHaveLength(1);
  });

});
