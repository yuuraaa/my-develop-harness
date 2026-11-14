import { chmod, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, jest } from "bun:test";
import { captureWorktreeTree, fingerprintWorktree, runGit } from "../src/git.js";
import { StorageError } from "../src/state.js";
import { setupDevelopment } from "./helpers/development.js";

const roots: string[] = [];
afterEach(async () => { jest.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup(prepareSource?: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "harness-commit-")); roots.push(root);
  const f = await setupDevelopment(root, prepareSource);
  const during = f.behavior.duringStream;
  let commits: string[] = [];
  const commit = async (paths = ["."]) => {
    await runGit(f.store.worktreePath, ["add", "--all", "--", ...paths]);
    await runGit(f.store.worktreePath, ["commit", "-m", "✨ 論理単位の変更"]);
    const sha = (await runGit(f.store.worktreePath, ["rev-parse", "HEAD"])).trim(); commits.push(sha); return sha;
  };
  const behavior = { commit: async () => { await commit(); }, beforeCommit: async () => {} };
  f.behavior.duringStream = async phase => {
    if (phase === "commit") await behavior.commit(); else await during(phase);
  };
  const output = f.behavior.output;
  f.behavior.output = phase => phase === "commit" ? { summary: "論理単位でコミット", commitHashes: commits, blockers: [] } : output(phase);
  const afterCommit = jest.fn();
  f.afterReview.run = async ({ control, phases }) => {
    expect(control.snapshot().reviewedTreeId).toMatch(/^[a-f0-9]{40,64}$/);
    await behavior.beforeCommit();
    await phases.commit();
    await afterCommit();
  };
  return { ...f, behaviorCommit: behavior, commit, afterCommit, commits };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function assertStopped(f: Fixture) {
  expect(await f.run()).toBe("stopped");
  expect(await f.store.loadGitHubState()).toMatchObject({ status: "stopped", phaseStatus: "failed" });
  expect(f.afterCommit).not.toHaveBeenCalled();
}

describe("レビュー後コミット（実Git・保存、Codex/GitHubはテストダブル）", () => {
  jest.setTimeout(60_000);
  it.each([1, 2])("T4: %i件のコミットで内容不変、作成順のresultCommitsを保存", async count => {
    const f = await setup(); const during = f.behavior.duringStream;
    f.behavior.duringStream = async phase => {
      await during(phase);
      if (phase === "implementation") await writeFile(join(f.store.worktreePath, "second.txt"), "second");
    };
    f.behaviorCommit.commit = async () => {
      if (count === 1) await f.commit();
      else { await f.commit(["partial.txt"]); await f.commit(["second.txt"]); }
    };
    expect(await f.run()).toBe("running");
    const state = await f.store.loadGitHubState();
    expect(state).toMatchObject({ phase: "commit", phaseStatus: "succeeded", resultCommits: f.commits });
    expect(state.resultCommits).toHaveLength(count);
    expect((await runGit(state.worktreePath, ["rev-parse", "HEAD^{tree}"])).trim()).toBe(state.reviewedTreeId!);
    expect((await runGit(state.worktreePath, ["status", "--porcelain"])).trim()).toBe("");
    expect((await f.store.loadArtifact("commit")).commitHashes).toEqual(f.commits);
    expect(f.afterCommit).toHaveBeenCalledTimes(1);
    expect(f.sessions.at(-1)).toBe("resume:thread-1");
    expect(f.prompts.at(-1)).toContain("ファイル内容を変更せず");
    expect(f.prompts.at(-1)).toContain("レビュー合格済み");
  });

  it.each(["content", "extra", "untracked", "unstaged", "staged", "branch", "amend", "merge", "transient-path", "empty"])("T10: %sの整合性違反を検出、履歴を自動修正しない", async mode => {
    const f = await setup();
    f.behaviorCommit.commit = async () => {
      const state = await f.store.loadGitHubState(); const path = state.worktreePath;
      if (mode === "content") await writeFile(join(path, "partial.txt"), "unreviewed");
      if (mode === "extra") await writeFile(join(path, "extra.txt"), "unreviewed");
      if (mode === "amend") {
        await runGit(path, ["add", "."]); await runGit(path, ["commit", "--amend", "-m", "改変"]);
        f.commits.push((await runGit(path, ["rev-parse", "HEAD"])).trim()); return;
      }
      if (mode === "transient-path") {
        await writeFile(join(path, "extra.txt"), "途中だけ存在"); await f.commit();
        await unlink(join(path, "extra.txt")); await f.commit(); return;
      }
      if (mode === "merge") {
        if (state.branchName === null) {
          throw new Error("コミット整合性テストには作成済みブランチが必要");
        }
        await runGit(path, ["switch", "-c", "feature/side"]); await f.commit();
        await runGit(path, ["switch", state.branchName]);
        await runGit(path, ["commit", "--allow-empty", "-m", "side parent"]);
        await runGit(path, ["merge", "--no-ff", "feature/side", "-m", "merge"]); return;
      }
      await f.commit();
      if (mode === "empty") await runGit(path, ["commit", "--allow-empty", "-m", "空コミット"]);
      if (mode === "untracked") await writeFile(join(path, "extra.txt"), "uncommitted");
      if (mode === "unstaged" || mode === "staged") await writeFile(join(path, "partial.txt"), "uncommitted");
      if (mode === "staged") await runGit(path, ["add", "."]);
      if (mode === "branch") await runGit(path, ["switch", "-c", "feature/unexpected"]);
    };
    await assertStopped(f);
    expect(f.phasesCalled.filter(p => p === "commit")).toHaveLength(1);
    const state = await f.store.loadGitHubState();
    expect(state.resultCommits).toEqual([]);
    // 不正な成果も保持し、reset/amend等で巻き戻さない。
    expect((await runGit(state.worktreePath, ["rev-parse", "HEAD"])).trim()).not.toBe(state.baseCommit);
  });

  it("T10: commitコマンド失敗では提出せず、未コミット変更を保持", async () => {
    const f = await setup(); f.behaviorCommit.commit = async () => { await runGit(f.store.worktreePath, ["commit", "-m", "未ステージ"]); };
    await assertStopped(f);
    const state = await f.store.loadGitHubState();
    expect((await runGit(state.worktreePath, ["rev-parse", "HEAD"])).trim()).toBe(state.baseCommit);
    expect(await readFile(join(state.worktreePath, "partial.txt"), "utf8")).toBe("implementation");
  });

  it("レビュー後・commit開始前の差分変更ではCodexを呼ばない", async () => {
    const f = await setup(); f.behaviorCommit.beforeCommit = () => writeFile(join(f.store.worktreePath, "partial.txt"), "変更");
    await assertStopped(f); expect(f.phasesCalled).not.toContain("commit");
  });

  it("改行正規化でGitツリーが同じになる実ファイルの変更も拒否", async () => {
    const f = await setup(async source => {
      await writeFile(join(source, ".gitattributes"), "*.txt text eol=lf\n");
      await runGit(source, ["add", "."]); await runGit(source, ["commit", "-m", "text attributes"]);
    });
    const during = f.behavior.duringStream;
    f.behavior.duringStream = async phase => {
      await during(phase);
      if (phase === "implementation") await writeFile(join(f.store.worktreePath, "partial.txt"), "implementation\r\n");
    };
    f.behaviorCommit.commit = async () => {
      await writeFile(join(f.store.worktreePath, "partial.txt"), "implementation\n"); await f.commit();
    };
    await assertStopped(f);
    const state = await f.store.loadGitHubState();
    expect((await runGit(state.worktreePath, ["rev-parse", "HEAD^{tree}"])).trim()).toBe(state.reviewedTreeId!);
    expect(state.error?.message).toContain("実ファイル");
  });

  it("保存済みReviewの重大指摘を再確認してcommitに進まない", async () => {
    const f = await setup(); f.behaviorCommit.beforeCommit = async () => {
      const path = join(f.store.artifactsPath, "review-1.json");
      const review = JSON.parse(await readFile(path, "utf8"));
      review.findings = [{ severity: "major", validationCommandIds: [], location: null, description: "未解決" }];
      await writeFile(path, JSON.stringify(review));
    };
    await assertStopped(f); expect(f.phasesCalled).not.toContain("commit");
  });

  it("SDK開始前の一時障害は同じ実装セッションで最大2回再試行", async () => {
    const f = await setup(); let n = 0;
    f.behavior.beforeStream = async phase => { if (phase === "commit" && n++ < 2) throw Object.assign(new Error(), { code: "EAI_AGAIN" }); };
    expect(await f.run()).toBe("running");
    expect(await f.store.loadGitHubState()).toMatchObject({ retryCount: { "codex.commit.1": 2 }, resultCommits: f.commits });
    expect(f.phasesCalled.filter(p => p === "commit")).toHaveLength(3);
  });

  it("SDK開始前の一時障害が継続すれば初回+2回で停止", async () => {
    const f = await setup();
    f.behavior.beforeStream = async phase => { if (phase === "commit") throw Object.assign(new Error(), { code: "EAI_AGAIN" }); };
    await assertStopped(f); expect(f.phasesCalled.filter(p => p === "commit")).toHaveLength(3);
  });

  it("途中commit後のSDK障害は再試行せずcommitを保持", async () => {
    const f = await setup(); f.behaviorCommit.commit = async () => { await f.commit(); throw Object.assign(new Error(), { code: "EAI_AGAIN" }); };
    await assertStopped(f); expect(f.phasesCalled.filter(p => p === "commit")).toHaveLength(1);
    expect((await runGit(f.store.worktreePath, ["rev-parse", "HEAD"])).trim()).toBe(f.commits[0]!);
  });

  it.each(["wrong", "malformed"])("%sのSHA申告では提出に進まない", async mode => {
    const f = await setup(); const output = f.behavior.output;
    f.behavior.output = phase => phase !== "commit" ? output(phase) : mode === "wrong"
      ? { summary: "commit", commitHashes: ["0".repeat(40)], blockers: [] } : {};
    await assertStopped(f); expect((await f.store.loadGitHubState()).resultCommits).toEqual([]);
  });

  it.each(["tree", "commits"])("%sの状態保存失敗では後続工程を呼ばない", async stage => {
    const f = await setup(); const save = f.store.saveGitHubState.bind(f.store);
    jest.spyOn(f.store, "saveGitHubState").mockImplementation(state =>
      (stage === "tree" ? !!state.reviewedTreeId : state.resultCommits.length > 0) && state.status === "running"
        ? Promise.reject(new StorageError("io")) : save(state));
    await assertStopped(f);
    if (stage === "tree") expect(f.phasesCalled).not.toContain("commit");
  });

  it("一時indexでステージ/未ステージ/削除/新規/実行属性/シンボリックリンクを保存、実indexは不変", async () => {
    const f = await setup(async source => {
      await writeFile(join(source, "delete.txt"), "delete");
      await runGit(source, ["add", "."]); await runGit(source, ["commit", "-m", "base deletion target"]);
    });
    const during = f.behavior.duringStream;
    f.behavior.duringStream = async phase => {
      await during(phase);
      if (phase !== "implementation") return;
      const path = f.store.worktreePath;
      await writeFile(join(path, "staged.txt"), "index"); await runGit(path, ["add", "staged.txt"]);
      await writeFile(join(path, "staged.txt"), "final worktree");
      await unlink(join(path, "delete.txt"));
      await writeFile(join(path, "exec.sh"), "#!/bin/sh\n"); await chmod(join(path, "exec.sh"), 0o755);
      await symlink("staged.txt", join(path, "link"));
    };
    f.behaviorCommit.beforeCommit = async () => {
      const fingerprint = await fingerprintWorktree(f.store.worktreePath);
      expect(await captureWorktreeTree(f.store.worktreePath)).toBe((await f.store.loadGitHubState()).reviewedTreeId!);
      expect(await fingerprintWorktree(f.store.worktreePath)).toBe(fingerprint);
    };
    expect(await f.run()).toBe("running");
    expect(await runGit(f.store.worktreePath, ["ls-tree", "HEAD", "exec.sh", "link"])).toContain("100755");
    expect(await runGit(f.store.worktreePath, ["ls-tree", "HEAD", "link"])).toContain("120000");
    expect(await readFile(join(f.store.worktreePath, "staged.txt"), "utf8")).toBe("final worktree");
  });
});
