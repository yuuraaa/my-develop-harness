import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, unlink, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, fingerprintWorktree, type GitCommand } from "../src/git.js";
import { parseGitHubConfig } from "../src/github-config.js";
import { acquireIssueRepository, inspectIssueRepository, verifyIssueRemote, workspaceGit, repositoryTransport, type RepositoryTransport } from "../src/github-repository.js";
import { BranchStore, durableJson, pathInfo, workspaceRunSchema, type WorkspaceIdentity } from "../src/github-workspace-store.js";
import { gitInclusion, planIssueBranch, prepareIssueWorkspace, type PreparedIssueWorkspace, type WorkspaceOptions } from "../src/github-workspace.js";

const config = (overrides = {}) => parseGitHubConfig({ schemaVersion: 2, github: {}, ...overrides }, "/tmp/config.json");
const identity = (n: number): WorkspaceIdentity => ({ host: "github.com", repositoryId: "10", repository: "a/b", issueId: String(100 + n), number: n });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "github-workspace-")), repo = join(root, "repo"), bare = join(root, "remote.git"), harness = join(root, "harness");
  await mkdir(repo); await runGit(repo, ["init", "-b", "main"]);
  await runGit(repo, ["config", "user.name", "test"]); await runGit(repo, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(repo, "file.txt"), "base\n"); await writeFile(join(repo, "AGENTS.md"), "初期指示\n");
  await runGit(repo, ["add", "."]); await runGit(repo, ["commit", "-m", "base"]);
  await runGit(root, ["clone", "--bare", repo, bare]); await runGit(repo, ["remote", "add", "origin", "https://github.com/a/b.git"]);
  const base = (await runGit(repo, ["rev-parse", "HEAD"])).trim();
  const calls: string[] = [];
  const transport: RepositoryTransport = async (cwd, operation, refs, destination) => {
    calls.push(operation);
    if (operation === "ls-remote") return runGit(cwd, ["ls-remote", "--symref", bare, ...refs]);
    if (operation === "clone") return runGit(cwd, ["clone", "--", bare, destination!]);
    return runGit(cwd, ["fetch", "--no-tags", bare, ...refs]);
  };
  const options = (issue = identity(1), runId = randomUUID()): WorkspaceOptions => ({ root: harness, runId, issue, managementIssue: identity(1),
    managementContent: { title: "ログイン機能", body: "管理単位のログイン機能を実装する", comments: ["内容から命名する"] },
    repositoryPath: repo, git: runGit, transport, redact: s => s.replaceAll("private-value", "[REDACTED]"),
    async confirmStart(start, check) { calls.push("confirm"); expect((await check(base, start)).status).toBe("included"); },
    async savePrepared(prepared) {
      calls.push("save"); const path = join(harness, "runs", runId, "state.json");
      await durableJson(path, workspaceRunSchema.parse(prepared), !!await pathInfo(path));
    },
  });
  const first = async () => {
    const input = options(), prepared = await prepareIssueWorkspace(input);
    const done = await planIssueBranch(prepared, { ...input, plan: async () => "feature/add-login" });
    return { input, done };
  };
  const commit = async (path: string, text = "change\n") => {
    await writeFile(join(path, "file.txt"), text); await runGit(path, ["add", "."]); await runGit(path, ["commit", "-m", "change"]);
    return (await runGit(path, ["rev-parse", "HEAD"])).trim();
  };
  const publish = async (done: PreparedIssueWorkspace) => {
    const head = (await runGit(done.worktreePath, ["rev-parse", "HEAD"])).trim();
    await runGit(done.worktreePath, ["push", bare, `HEAD:refs/heads/${done.branchName}`]);
    const store = new BranchStore(harness), old = (await store.read(identity(1)))!;
    await runGit(repo, ["update-ref", `refs/heads/${done.branchName}`, head, old.localTip!]);
    await store.update(old, { ...old, localTip: head, remoteTip: head });
    return head;
  };
  return { root, repo, bare, harness, base, transport, calls, options, first, commit, publish };
}

describe("Issueリポジトリの選択とpush先", () => {
  it("Issue所属だけを選びoriginと設定remote、SSH/HTTPS、大文字を照合", async () => {
    const f = await fixture();
    expect((await inspectIssueRepository("A/B", config(), runGit, f.repo)).path).toBe(f.repo);
    await runGit(f.repo, ["remote", "rename", "origin", "publish"]);
    await runGit(f.repo, ["remote", "set-url", "publish", "git@github.com:A/B.git"]);
    expect((await inspectIssueRepository("a/b", config({ repositories: { "a/b": { pushRemote: "publish" } } }), runGit, f.repo)).pushRemote).toBe("publish");
    await expect(inspectIssueRepository("a/b", config(), runGit, f.repo)).rejects.toThrow("push remote");
  });
  it("fork・複数pushurl・fetch不一致・ユーザー情報付きURLで停止", async () => {
    for (const urls of [["https://github.com/fork/b.git"], ["https://github.com/a/b.git", "https://github.com/a/b.git"], ["https://user:private-value@github.com/a/b.git"]]) {
      const f = await fixture();
      for (const url of urls) await runGit(f.repo, ["config", "--add", "remote.origin.pushurl", url]);
      await expect(verifyIssueRemote(f.repo, "a/b", "origin", runGit)).rejects.toThrow("不一致または複数");
    }
    const f = await fixture(); await runGit(f.repo, ["remote", "set-url", "origin", "https://github.com/fork/b.git"]);
    await expect(inspectIssueRepository("a/b", config(), runGit, f.repo)).rejects.toThrow("一致しません");
  });
  it("探索で複数cloneを拒否し、対象なしなら安全なclone予定先を返す", async () => {
    const f = await fixture(), second = join(f.root, "second");
    await runGit(f.root, ["clone", f.repo, second]); await runGit(second, ["remote", "set-url", "origin", "https://github.com/a/b.git"]);
    const cfg = config({ repository: { searchRoots: [f.root], cloneRoot: join(f.root, "clones") } });
    await expect(inspectIssueRepository("a/b", cfg, runGit)).rejects.toThrow("複数");
    const selected = await inspectIssueRepository("other/project", cfg, runGit);
    expect(selected.path).toBeNull(); expect(selected.destination).toBe(join(f.root, "clones/harness-clone/other/project"));
  });
  it("cloneの宛先衝突を消さず、失敗した部分cloneも残す", async () => {
    const f = await fixture(), selected = { repository: "a/b", path: null, destination: join(f.root, "new/repo"), pushRemote: "origin", cloned: false };
    const partial: RepositoryTransport = async (_cwd, _op, _refs, destination) => { await mkdir(destination!); await writeFile(join(destination!, "partial"), "保持"); throw new Error("通信失敗"); };
    await expect(acquireIssueRepository(selected, runGit, partial)).rejects.toThrow("通信失敗");
    expect(await readFile(join(selected.destination, "partial"), "utf8")).toBe("保持");
    await expect(acquireIssueRepository(selected, runGit, partial)).rejects.toThrow("既存");
  });
  it("ローカルGitで認証設定を再検査せず、通信には明示tokenを渡す", async () => {
    const f = await fixture(), git = await workspaceGit();
    expect((await git(f.repo, ["rev-parse", "HEAD"])).trim()).toBe(f.base);
    await runGit(f.repo, ["config", "credential.helper", "store"]);
    expect((await git(f.repo, ["rev-parse", "HEAD"])).trim()).toBe(f.base);
    let observed = false;
    const transport = repositoryTransport({ repository: "a/b", token: "explicit-token", run: async (_program, args, env) => {
      if (args[0] === "config") return { code: 1, stdout: "", stderr: "" };
      observed = true; expect(args).toEqual(["ls-remote", "--symref", "--", "https://github.com/a/b.git", "HEAD"]);
      expect(env.HARNESS_GIT_TOKEN).toBe("explicit-token"); expect(args.join(" ")).not.toContain("explicit-token");
      return { code: 0, stdout: "output", stderr: "" };
    } });
    expect(await transport(f.repo, "ls-remote", ["HEAD"])).toBe("output"); expect(observed).toBe(true);
  });
});

describe("初回命名とブランチ対応", () => {
  it("開始点確認→detached→Plan→予約保存→ref作成を守り、成果ブランチをcheckoutしない", async () => {
    const f = await fixture(), input = f.options();
    const prepared = await prepareIssueWorkspace(input);
    expect(prepared.baseCommit).toBe(f.base); expect(prepared.remoteStartCommit).toBeNull(); expect(prepared.branchName).toBeNull();
    expect(f.calls.indexOf("confirm")).toBeLessThan(f.calls.indexOf("save"));
    expect((await runGit(prepared.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("HEAD");
    let reservationSeen = false;
    const traced: GitCommand = async (cwd, args) => {
      if (args[0] === "update-ref") { reservationSeen = true; expect((await new BranchStore(f.harness).read(identity(1)))?.creationStatus).toBe("reserved"); }
      return runGit(cwd, args);
    };
    const done = await planIssueBranch(prepared, { ...input, git: traced, plan: async i => {
      expect(i.managementIssue).toEqual(identity(1)); expect(i.namingInstruction).toContain("作業内容"); return "fix/login-validation";
    } });
    expect(reservationSeen).toBe(true); expect(done.branchName).toBe("fix/login-validation");
    expect((await runGit(done.worktreePath, ["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/harness/run/${input.runId}`);
    expect((await new BranchStore(f.harness).read(identity(1)))?.creationStatus).toBe("created");
  });
  it("不正・local/remote衝突を理由付き再Planし最大3回で停止", async () => {
    const f = await fixture(), input = f.options(), prepared = await prepareIssueWorkspace(input);
    await runGit(f.repo, ["branch", "feature/taken"]);
    const names = ["issue-1", "feature/taken", "docs/login-design"], reasons: (string | null)[] = [];
    const done = await planIssueBranch(prepared, { ...input, plan: async i => { reasons.push(i.reason); return names[i.attempt - 1]!; } });
    expect(done.branchName).toBe("docs/login-design"); expect(reasons[1]).toContain("英語ケバブ"); expect(reasons[2]).toContain("衝突");
    const g = await fixture(), bad = g.options(), p = await prepareIssueWorkspace(bad); let attempts = 0;
    await expect(planIssueBranch(p, { ...bad, plan: async () => { attempts++; return null; } })).rejects.toThrow("3回");
    expect(attempts).toBe(3); expect(await new BranchStore(g.harness).read(identity(1))).toBeNull();
  });
  it("ref作成中断はreservedを保持し、再実行で自動作成しない", async () => {
    const f = await fixture(), input = f.options(), p = await prepareIssueWorkspace(input);
    await expect(planIssueBranch(p, { ...input, git: async (cwd, args) => { if (args[0] === "update-ref") throw new Error("中断"); return runGit(cwd, args); }, plan: async () => "chore/update-config" })).rejects.toThrow("中断");
    await expect(prepareIssueWorkspace(f.options())).rejects.toThrow("reserved");
    expect(await pathInfo(p.worktreePath)).not.toBeNull();
  });
  it("依存未包含はworktree作成前に停止する", async () => {
    const f = await fixture(), input = f.options();
    await expect(prepareIssueWorkspace({ ...input, confirmStart: async (_start, check) => { expect((await check("a".repeat(40), f.base)).status).toBe("unconfirmed"); throw new Error("依存待ち"); } })).rejects.toThrow("依存待ち");
    expect(await pathInfo(join(f.harness, "worktrees", input.runId))).toBeNull();
  });
  it("clean既定branch条件・aheadを停止し、remoteのff-only更新を許可", async () => {
    const f = await fixture(); await writeFile(join(f.repo, "dirty"), "dirty");
    await expect(prepareIssueWorkspace(f.options())).rejects.toThrow("clean"); await unlink(join(f.repo, "dirty"));
    await runGit(f.repo, ["switch", "-c", "other"]); await expect(prepareIssueWorkspace(f.options())).rejects.toThrow("既定");
    await runGit(f.repo, ["switch", "main"]); await f.commit(f.repo);
    await expect(prepareIssueWorkspace(f.options())).rejects.toThrow("独自コミット");
    await runGit(f.repo, ["push", f.bare, "main"]);
    const p = await prepareIssueWorkspace(f.options()); expect(p.baseCommit).not.toBe(f.base);
  });
  it("Planによるコード変更を検出して予約しない", async () => {
    const f = await fixture(), input = f.options(), p = await prepareIssueWorkspace(input);
    await expect(planIssueBranch(p, { ...input, plan: async () => { await writeFile(join(p.worktreePath, "file.txt"), "変更"); return "feature/changed"; } })).rejects.toThrow("Plan中");
    expect(await new BranchStore(f.harness).read(identity(1))).toBeNull();
  });
});

describe("共有成果からの子Issueと同Issue再実行", () => {
  it("未承認でもpush済み成果から別子の内部branchを作り、既存worktreeを保持", async () => {
    const f = await fixture(), { done } = await f.first(); const head = await f.commit(done.worktreePath); await f.publish(done);
    const input = f.options(identity(2)), p = await prepareIssueWorkspace(input);
    expect(p.startCommit).toBe(head); expect(p.remoteStartCommit).toBe(head); expect(p.worktreePath).not.toBe(done.worktreePath);
    const d = await planIssueBranch(p, { ...input, plan: async i => { expect(i.branchName).toBe("feature/add-login"); return "feature/renamed-title"; } });
    expect(d.branchName).toBe("feature/add-login"); expect(d.workBranchName).not.toBe(done.workBranchName);
    expect(await pathInfo(done.worktreePath)).not.toBeNull();
    expect((await runGit(done.worktreePath, ["rev-parse", "HEAD"])).trim()).toBe(head);
  });
  it("同Issueのdirty/index/untracked/未pushコミットを同worktreeで保持し新runへ累積diff保存", async () => {
    const f = await fixture(), { input: first, done } = await f.first(); const head = await f.commit(done.worktreePath);
    await writeFile(join(done.worktreePath, "file.txt"), "index\n"); await runGit(done.worktreePath, ["add", "file.txt"]);
    await writeFile(join(done.worktreePath, "file.txt"), "private-value\n"); await writeFile(join(done.worktreePath, "new.txt"), "untracked\n");
    await writeFile(join(done.worktreePath, ".env"), "secret=private-value");
    const oldState = await readFile(join(f.harness, "runs", first.runId, "state.json"), "utf8"), before = await fingerprintWorktree(done.worktreePath);
    const input = f.options(), p = await prepareIssueWorkspace(input);
    expect(p.worktreePath).toBe(done.worktreePath); expect(p.previousRunId).toBe(first.runId); expect(p.restartHead).toBe(head); expect(p.baseCommit).toBe(f.base);
    expect(p.restart?.cumulativeDiff).toContain("new.txt"); expect(p.restart?.cumulativeDiff).not.toContain("private-value"); expect(p.restart?.cumulativeDiff).not.toContain(".env");
    expect(p.restart?.redacted).toBe(true); expect(await fingerprintWorktree(done.worktreePath)).toBe(before);
    const d = await planIssueBranch(p, { ...input, plan: async i => { expect(i.branchName).toBe(done.branchName); return "fix/ignore-rename"; } });
    expect(d.workBranchName).toBe(done.workBranchName); expect(await fingerprintWorktree(done.worktreePath)).toBe(before);
    expect(await readFile(join(f.harness, "runs", first.runId, "state.json"), "utf8")).toBe(oldState);
    const third = await prepareIssueWorkspace(f.options()); expect(third.previousRunId).toBe(input.runId);
  });
  it("Plan前中断のdetached worktreeを再利用し初回命名する", async () => {
    const f = await fixture(), input = f.options(), p = await prepareIssueWorkspace(input);
    const next = f.options(), reused = await prepareIssueWorkspace(next);
    expect(reused.worktreePath).toBe(p.worktreePath); expect(reused.branchName).toBeNull();
    const done = await planIssueBranch(reused, { ...next, plan: async () => "refactor/simplify-api" });
    expect(done.workBranchName).toBe(`harness/run/${input.runId}`);
    const third = await prepareIssueWorkspace(f.options()); expect(third.worktreePath).toBe(p.worktreePath);
  });
  it("同管理単位の別Issueの未公開成果をready・別runで回避しない", async () => {
    const f = await fixture(); await f.first();
    await expect(prepareIssueWorkspace(f.options(identity(2)))).rejects.toThrow("未公開");
    const g = await fixture(), { done } = await g.first(); await g.publish(done);
    await writeFile(join(done.worktreePath, "new"), "dirty");
    await expect(prepareIssueWorkspace(g.options(identity(2)))).rejects.toThrow("未公開");
  });
  it("対応記録の欠落・破損・ID不一致・ref不一致を止める", async () => {
    for (const mode of ["missing", "corrupt", "identity", "tip"] as const) {
      const f = await fixture(), { done } = await f.first(), store = new BranchStore(f.harness), path = store.path(identity(1));
      if (mode === "missing") await unlink(path);
      if (mode === "corrupt") await writeFile(path, "{");
      if (mode === "identity") { const record = (await store.read(identity(1)))!; await writeFile(path, JSON.stringify({ ...record, repository: "other/repo" })); }
      if (mode === "tip") { const head = await f.commit(done.worktreePath); await runGit(f.repo, ["update-ref", `refs/heads/${done.branchName}`, head]); }
      await expect(prepareIssueWorkspace(f.options())).rejects.toThrow();
    }
  });
  it("worktree欠落・実branch不一致・複数候補・chain不足を止める", async () => {
    for (const mode of ["missing", "branch", "multiple", "chain"] as const) {
      const f = await fixture(), { input, done } = await f.first();
      if (mode === "missing") await runGit(f.repo, ["worktree", "remove", done.worktreePath]);
      if (mode === "branch") await runGit(done.worktreePath, ["checkout", "--detach"]);
      if (mode === "multiple" || mode === "chain") {
        const runId = randomUUID(), clone = workspaceRunSchema.parse({ ...done, runId, previousRunId: mode === "chain" ? randomUUID() : null, worktreeOriginRunId: runId });
        await durableJson(join(f.harness, "runs", runId, "state.json"), clone);
      }
      await expect(prepareIssueWorkspace(f.options())).rejects.toThrow();
      expect(await pathInfo(join(f.harness, "runs", input.runId, "state.json"))).not.toBeNull();
    }
  });
  it("成果branch checkout中・remote先行・分岐を止める", async () => {
    const f = await fixture(), { done } = await f.first(); await f.publish(done);
    await runGit(f.repo, ["checkout", done.branchName!]); await expect(prepareIssueWorkspace(f.options())).rejects.toThrow("checkout中"); await runGit(f.repo, ["checkout", "main"]);
    await f.commit(f.repo, "remote ahead\n"); await runGit(f.repo, ["push", f.bare, `HEAD:refs/heads/${done.branchName}`]);
    await expect(prepareIssueWorkspace(f.options())).rejects.toThrow("先行・分岐");
  });
  it("記録ディレクトリsymlinkを許容し、新規予約の上書きは拒否", async () => {
    const f = await fixture(), { done } = await f.first(), store = new BranchStore(f.harness), r = (await store.read(identity(1)))!;
    await expect(store.reserve({ ...r, creationStatus: "reserved", localTip: null, remoteTip: null })).rejects.toThrow("既存");
    const other = join(f.root, "symlink-root"); await symlink(f.harness, other);
    expect((await new BranchStore(other).read(identity(1)))?.branchName).toBe(r.branchName);
    expect(done.branchRecordPath).toBe(store.path(identity(1)));
  });
  it("同名の無関係remote branch・他管理単位の予約を初回命名で拒否", async () => {
    const f = await fixture(), input = f.options(), p = await prepareIssueWorkspace(input);
    await runGit(f.repo, ["push", f.bare, "HEAD:refs/heads/feature/existing"]);
    const done = await planIssueBranch(p, { ...input, plan: async i => i.attempt === 1 ? "feature/existing" : "hotfix/repair-login" });
    const record = done.branchRecord!;
    await expect(new BranchStore(f.harness).reserve({ ...record, managementIssueId: "999", managementIssueNumber: 999,
      creationStatus: "reserved", localTip: null, remoteTip: null })).rejects.toThrow("予約");
  });
});

it("実Git包含は非包含・欠落・replace/graftsを区別し安全側へ倒す", async () => {
  const f = await fixture(), base = f.base; await runGit(f.repo, ["checkout", "-b", "left"]); const left = await f.commit(f.repo, "left\n");
  await runGit(f.repo, ["checkout", "-b", "right", base]); const right = await f.commit(f.repo, "right\n"); const check = gitInclusion(f.repo, runGit);
  expect((await check(base, left)).status).toBe("included"); expect((await check(left, right)).status).toBe("not_included");
  expect((await check("a".repeat(40), right)).status).toBe("unconfirmed");
  await runGit(f.repo, ["replace", right, left]); expect((await check(left, right)).status).toBe("not_included");
  await mkdir(join(f.repo, ".git/info"), { recursive: true }); await writeFile(join(f.repo, ".git/info/grafts"), `${right} ${left}\n`);
  expect((await check(left, right)).status).toBe("unconfirmed");
});

it("push応答不明の別IssueはremoteにSHAがあっても自動で引き継がない", async () => {
  const f = await fixture(), { input, done } = await f.first(); await f.publish(done);
  await durableJson(join(f.harness, "runs", input.runId, "artifacts/submission.json"), { push: { status: "unknown" } });
  await expect(prepareIssueWorkspace(f.options(identity(2)))).rejects.toThrow("push成否が未確認");
});
it("remoteの更新を初回にff-onlyで取り込み、fetch中のSHA変化は止める", async () => {
  const f = await fixture(), clone = join(f.root, "writer");
  await runGit(f.root, ["clone", f.repo, clone]); await runGit(clone, ["config", "user.name", "test"]); await runGit(clone, ["config", "user.email", "test@example.invalid"]);
  const head = await f.commit(clone, "new default\n"); await runGit(clone, ["push", f.bare, "HEAD:refs/heads/main"]);
  const p = await prepareIssueWorkspace(f.options()); expect(p.startCommit).toBe(head); expect((await runGit(f.repo, ["rev-parse", "HEAD"])).trim()).toBe(head);
  const g = await fixture(), options = g.options();
  await expect(prepareIssueWorkspace({ ...options, transport: async (cwd, op, refs, destination) => {
    if (op === "fetch") { await g.commit(g.repo); await runGit(g.repo, ["push", g.bare, "main"]); }
    return g.transport(cwd, op, refs, destination);
  } })).rejects.toThrow("取得中");
});
it("後続子はremote先行をFFで採用するが、履歴分岐は取り込まない", async () => {
  const f = await fixture(), { done } = await f.first(); await f.publish(done);
  const remoteHead = await f.commit(f.repo, "remote progress\n"); await runGit(f.repo, ["push", f.bare, `HEAD:refs/heads/${done.branchName}`]);
  const p = await prepareIssueWorkspace(f.options(identity(2))); expect(p.startCommit).toBe(remoteHead);
  expect((await new BranchStore(f.harness).read(identity(1)))!.localTip).toBe(remoteHead);
  // 同Issueの旧HEADへremote先行をresetして合わせない。
  await expect(prepareIssueWorkspace(f.options())).rejects.toThrow("先行・分岐");
});
it("対応決定run欠落・同一名前予約破損・改名/移転を推測して復旧しない", async () => {
  const f = await fixture(), { input } = await f.first();
  await unlink(join(f.harness, "runs", input.runId, "state.json"));
  await expect(prepareIssueWorkspace(f.options())).rejects.toThrow("決定runの記録が欠落");
  const g = await fixture(), { done } = await g.first(); await g.publish(done);
  const changed = g.options({ ...identity(1), number: 999 });
  await expect(prepareIssueWorkspace(changed)).rejects.toThrow("不一致");
});
it("本番の隔離Git環境でも初回から同Issue再実行まで動く", async () => {
  const f = await fixture(), git = await workspaceGit(), options = { ...f.options(), git };
  const p = await prepareIssueWorkspace(options), done = await planIssueBranch(p, { ...options, plan: async () => "feature/secure-workspace" });
  await writeFile(join(done.worktreePath, "new.txt"), "変更を保持\n");
  const next = await prepareIssueWorkspace({ ...f.options(), git });
  expect(next.worktreePath).toBe(done.worktreePath); expect(next.restart?.cumulativeDiff).toContain("変更を保持");
});
it("同Issue再実行で新しくpush成功した場合は過去runを上書きせず後続子へ引き継ぐ", async () => {
  const f = await fixture(), { input: old, done } = await f.first(); await f.publish(done);
  await durableJson(join(f.harness, "runs", old.runId, "artifacts/submission.json"), { push: { status: "unknown" } });
  const input = f.options(), p = await prepareIssueWorkspace(input), next = await planIssueBranch(p, { ...input, plan: async () => null });
  await f.publish(next);
  await durableJson(join(f.harness, "runs", input.runId, "artifacts/submission.json"), { push: { status: "succeeded" } });
  const child = await prepareIssueWorkspace(f.options(identity(2))); expect(child.remoteStartCommit).toBe(f.base);
  expect(JSON.parse(await readFile(join(f.harness, "runs", old.runId, "artifacts/submission.json"), "utf8")).push.status).toBe("unknown");
});
it("新規cloneはIssueの宛先を再照合して指定remoteへ接続する", async () => {
  const f = await fixture(), selected = { repository: "a/b", path: null, destination: join(f.root, "clones/a/b"), pushRemote: "publish", cloned: false };
  const path = await acquireIssueRepository(selected, runGit, async (cwd, op, refs, destination) => {
    const output = await f.transport(cwd, op, refs, destination);
    await runGit(destination!, ["remote", "set-url", "origin", "https://github.com/a/b.git"]);
    return output;
  });
  expect(selected.cloned).toBe(true); expect(path).toBe(selected.destination);
  expect((await runGit(path, ["remote"])).trim()).toBe("publish");
});
it("再利用の累積diffもrefs/replaceを無効にして実treeの変更を保持する", async () => {
  const f = await fixture(), { done } = await f.first();
  const replacement = await f.commit(f.repo, "replace-change\n");
  await writeFile(join(done.worktreePath, "file.txt"), "replace-change\n");
  await runGit(f.repo, ["replace", f.base, replacement]);
  const next = await prepareIssueWorkspace({ ...f.options(), git: await workspaceGit() });
  expect(next.restart?.cumulativeDiff).toContain("-base"); expect(next.restart?.cumulativeDiff).toContain("+replace-change");
});
it("成果refをmainへのsymbolic refへ差し替えられても元cloneを変更せず停止する", async () => {
  const f = await fixture(), { done } = await f.first(); await f.publish(done);
  await runGit(f.repo, ["symbolic-ref", `refs/heads/${done.branchName}`, "refs/heads/main"]);
  const writer = join(f.root, "writer"); await runGit(f.root, ["clone", f.repo, writer]);
  await runGit(writer, ["config", "user.name", "test"]); await runGit(writer, ["config", "user.email", "test@example.invalid"]);
  const head = await f.commit(writer, "remote-ahead\n"); await runGit(writer, ["push", f.bare, `HEAD:refs/heads/${done.branchName}`]);
  expect(head).not.toBe(f.base);
  await expect(prepareIssueWorkspace(f.options(identity(2)))).rejects.toThrow("symbolic ref");
  expect((await runGit(f.repo, ["rev-parse", "main"])).trim()).toBe(f.base);
  expect((await runGit(f.repo, ["status", "--porcelain=v1"])).trim()).toBe("");
});
it("到達可能な祖先SHAでも対応記録の初回baseが決定runと違えば停止する", async () => {
  const f = await fixture(); await f.commit(f.repo, "default advance\n"); await runGit(f.repo, ["push", f.bare, "main"]);
  const { done } = await f.first(), store = new BranchStore(f.harness), record = (await store.read(identity(1)))!;
  expect(record.initialBaseCommit).toBe(done.baseCommit); expect(done.baseCommit).not.toBe(f.base);
  await writeFile(store.path(identity(1)), JSON.stringify({ ...record, initialBaseCommit: f.base }));
  await expect(prepareIssueWorkspace(f.options())).rejects.toThrow("決定runの開始点");
});
it("後続runが正常でも決定runの名前/記録先の矛盾を無視しない", async () => {
  const f = await fixture(), { input: first, done } = await f.first(), input = f.options();
  const reused = await prepareIssueWorkspace(input); await planIssueBranch(reused, { ...input, plan: async () => null });
  const oldPath = join(f.harness, "runs", first.runId, "state.json"), original = JSON.parse(await readFile(oldPath, "utf8"));
  for (const change of [{ branchName: "feature/unrelated" }, { branchRecordPath: join(f.root, "wrong.json") }]) {
    await writeFile(oldPath, JSON.stringify({ ...original, ...change }));
    await expect(prepareIssueWorkspace(f.options())).rejects.toThrow("決定runの開始点/名前/記録先");
  }
  expect((await runGit(done.worktreePath, ["rev-parse", "HEAD"])).trim()).toBe(f.base);
});

it("無関係な履歴の破損は停止させず、所属を読めない履歴は警告へ残す", async () => {
  const f = await fixture(), unrelated = randomUUID(), unreadable = randomUUID();
  await durableJson(join(f.harness, "runs", unrelated, "state.json"), { schemaVersion: 2, managementIssue: { repositoryId: "20", issueId: "201" }, broken: true });
  await mkdir(join(f.harness, "runs", unreadable)); await writeFile(join(f.harness, "runs", unreadable, "state.json"), "{");
  const input = f.options(), p = await prepareIssueWorkspace(input);
  expect(p.warnings).toContain(`履歴を読み取れません: ${join(f.harness, "runs", unreadable, "state.json")}`);
  expect((await planIssueBranch(p, { ...input, plan: async () => "feature/limited-history" })).branchName).toBe("feature/limited-history");
  await durableJson(join(f.harness, "runs", randomUUID(), "state.json"), { schemaVersion: 2, managementIssue: { repositoryId: "10", issueId: "101" } });
  await expect(prepareIssueWorkspace(f.options())).rejects.toThrow("過去実行記録が破損");
});
it("他管理単位の予約は名前だけ照合し、無関係な項目の破損で停止しない", async () => {
  const f = await fixture(), input = f.options(), p = await prepareIssueWorkspace(input);
  await durableJson(join(f.harness, "branches/10/999.json"), { branchName: "feature/reserved", invalidBase: true });
  await writeFile(join(f.harness, "branches/10/998.json"), "{");
  const done = await planIssueBranch(p, { ...input, plan: async i => {
    if (i.attempt === 1) return "feature/reserved";
    expect(i.reason).toContain("衝突"); return "feature/valid-reservation";
  } });
  expect(done.branchName).toBe("feature/valid-reservation"); expect(done.warnings.some(w => w.includes("998.json"))).toBe(true);
});
it("symlink経由の管理領域でも初回作成と同Issue再利用ができる", async () => {
  const f = await fixture(), alias = join(f.root, "harness-link");
  await mkdir(f.harness); await symlink(f.harness, alias);
  const input = { ...f.options(), root: alias }, p = await prepareIssueWorkspace(input);
  const done = await planIssueBranch(p, { ...input, plan: async () => "feature/linked-storage" });
  await writeFile(join(done.worktreePath, "file.txt"), "保持\n");
  const next = await prepareIssueWorkspace({ ...f.options(), root: alias });
  expect(next.worktreePath).toBe(done.worktreePath); expect(next.restart?.cumulativeDiff).toContain("保持");
});
it("保存された実パスのworktreeを再利用し、run IDからの場所固定をしない", async () => {
  const f = await fixture(), { input, done } = await f.first(), moved = join(f.root, "moved-worktree");
  await runGit(f.repo, ["worktree", "move", done.worktreePath, moved]);
  const statePath = join(f.harness, "runs", input.runId, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")); await writeFile(statePath, JSON.stringify({ ...state, worktreePath: moved }));
  await writeFile(join(moved, "file.txt"), "moved changes\n");
  const next = await prepareIssueWorkspace(f.options());
  expect(next.worktreePath).toBe(moved); expect(next.restart?.cumulativeDiff).toContain("moved changes");
});
it("後続Issueと再実行のPlanは無関係な既定branchのHEADに依存しない", async () => {
  const f = await fixture(), { done } = await f.first(); await f.publish(done);
  await runGit(f.bare, ["symbolic-ref", "HEAD", "refs/heads/missing-default"]);
  const input = f.options(identity(2)), p = await prepareIssueWorkspace(input);
  expect(p.startCommit).toBe(f.base); expect(p.remoteHeads.defaultBranch).toBeNull();
  expect((await planIssueBranch(p, { ...input, plan: async () => null })).branchName).toBe(done.branchName);
  expect((await prepareIssueWorkspace(f.options())).worktreePath).toBe(done.worktreePath);
  const g = await fixture(); await runGit(g.bare, ["symbolic-ref", "HEAD", "refs/heads/missing-default"]);
  await expect(prepareIssueWorkspace(g.options())).rejects.toThrow("既定ブランチ");
});
it("別Issueのworktreeが手動削除済みでも、残る成果refのremote包含を確認して進む", async () => {
  const f = await fixture(), { done } = await f.first(); const head = await f.commit(done.worktreePath); await f.publish(done);
  await runGit(f.repo, ["worktree", "remove", done.worktreePath]);
  expect((await prepareIssueWorkspace(f.options(identity(2)))).startCommit).toBe(head);
  await expect(prepareIssueWorkspace(f.options())).rejects.toThrow("worktreeが欠落");
});
it("削除済みの別Issueの未push成果は引き続き停止する", async () => {
  const f = await fixture(), { done } = await f.first(); await f.publish(done); await f.commit(done.worktreePath);
  await runGit(f.repo, ["worktree", "remove", done.worktreePath]);
  await expect(prepareIssueWorkspace(f.options(identity(2)))).rejects.toThrow("未push");
});
it("対象Issueの管理単位が壊れた履歴を無関係として除外しない", async () => {
  const f = await fixture(), { input, done } = await f.first(), nextInput = f.options();
  await planIssueBranch(await prepareIssueWorkspace(nextInput), { ...nextInput, plan: async () => null });
  const statePath = join(f.harness, "runs", nextInput.runId, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(statePath, JSON.stringify({ ...state, managementIssue: identity(9) }));
  await expect(prepareIssueWorkspace(f.options())).rejects.toThrow("不一致");
  expect(await pathInfo(join(f.harness, "runs", input.runId, "state.json"))).not.toBeNull(); expect(await pathInfo(done.worktreePath)).not.toBeNull();
});
