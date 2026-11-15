import { describe, it, expect } from "bun:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitHubConfig, githubTokens, loadGitHubConfig } from "../src/github-config.js";
import { GitHubClient, GitHubError, githubRunRecorder, type GitHubRecord } from "../src/github.js";
import { RunStore, newRunId } from "../src/state.js";
import { isolatedGitHubEnvironment, githubProcess, checkRepositoryCredentials, runAuthenticatedGit, type GitHubProcess } from "../src/github-auth.js";
import { executionEnvironment } from "../src/verification.js";

const config = () => parseGitHubConfig({ schemaVersion: 2, github: {} }, "/tmp/settings/config.json");
const credentials = { HARNESS_GITHUB_WRITE_TOKEN: "write-fixture-secret", HARNESS_GITHUB_READ_TOKEN: "read-fixture-secret" };
const reply = (status: number, body: unknown, headers = "") => ({ code: status < 400 ? 0 : 1,
  stdout: `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n${headers}\r\n${JSON.stringify(body)}`, stderr: "" });

describe("GitHub新設定", () => {
  it("既定値・正規化・探索とwatchの分離・ファイル基準の相対パス", async () => {
    const c = parseGitHubConfig({ schemaVersion: 2, github: {}, watch: { repositories: ["Owner/Repo"] },
      repositories: { "Else/Other": { pushRemote: "upstream", requiredSources: [{ kind: "githubIssue", repository: "Docs/Spec", number: 1 }] } },
      repository: { searchRoots: ["../repos"], cloneRoot: "clones" } }, "/tmp/settings/config.json");
    expect(c.github.maxContextBytes).toBe(10485760);
    expect(c.watch.repositories).toEqual(["owner/repo"]);
    expect(c.repositories["else/other"]!.pushRemote).toBe("upstream");
    expect(c.repository).toEqual({ searchRoots: ["/tmp/repos"], cloneRoot: "/tmp/settings/clones" });
    expect(config().watch.repositories).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), "github-config-"));
    await writeFile(join(dir, "config.json"), JSON.stringify({ schemaVersion: 2, github: {} }));
    expect((await loadGitHubConfig(join(dir, "config.json"))).schemaVersion).toBe(2);
  });
  it("不正設定・未知キー・重複ラベル・不正値・パストラバーサルを拒否", () => {
    const invalid = [ {}, { unexpected: true }, { schemaVersion: 3, github: {} },
      { schemaVersion: 2, github: { token: "secret" } }, { schemaVersion: 2, github: { labels: { ready: "HARNESS:RUNNING" } } },
      { schemaVersion: 2, github: { maxContextBytes: 0 } }, { schemaVersion: 2, github: { maxContextBytes: 1.5 } },
      { schemaVersion: 2, github: { writeTokenEnv: "A", readTokenEnv: "A" } },
      { schemaVersion: 2, github: {}, watch: { repositories: ["A/B", "a/b"] } },
      { schemaVersion: 2, github: {}, repositories: { "a/b": { pushRemote: "-f" } } },
      { schemaVersion: 2, github: {}, repositories: { "a/b": { requiredSources: [{ kind: "file", path: "../secret" }] } } },
      { schemaVersion: 2, github: {}, repositories: { "a/b": {}, "A/B": {} } },
      { schemaVersion: 2, github: {}, execution: { surprise: true } } ];
    for (const value of invalid) expect(() => parseGitHubConfig(value, "/tmp/config.json")).toThrow("schemaVersion: 2");
  });
  it("空・改行・同値認証を拒否し、任意名の認証値をエラーに含めない", () => {
    for (const env of [{}, { ...credentials, HARNESS_GITHUB_READ_TOKEN: credentials.HARNESS_GITHUB_WRITE_TOKEN },
      { ...credentials, HARNESS_GITHUB_READ_TOKEN: "\nsecret" }]) expect(() => githubTokens(config(), env)).toThrow();
    expect(githubTokens(config(), credentials)).toEqual({ read: credentials.HARNESS_GITHUB_READ_TOKEN, write: credentials.HARNESS_GITHUB_WRITE_TOKEN });
  });
  it("push remoteの元文字列にある先頭・末尾の制御文字を拒否する", () => {
    for (const pushRemote of ["origin\n", "\torigin", "origin\r", "origin\v", "origin\0", "\x7forigin"]) {
      expect(() => parseGitHubConfig({ schemaVersion: 2, github: {}, repositories: { "a/b": { pushRemote } } }, "/tmp/config.json")).toThrow();
    }
    expect(parseGitHubConfig({ schemaVersion: 2, github: {}, repositories: { "a/b": { pushRemote: " origin " } } }, "/tmp/config.json").repositories["a/b"]!.pushRemote).toBe("origin");
  });
});

describe("GitHub通信", () => {
  it("GET /parentの404でmessageが厳密に親なしを示す場合だけ理由を保持し、生の本文は残さない", async () => {
    const endpoint = "/repos/a/b/issues/1/parent";
    const cases = [
      { status: 404, body: { message: "No parent issue found", secret: credentials }, reason: "no_parent_issue" },
      { status: 404, body: { message: "Not Found", detail: "No parent issue found" }, reason: null },
      { status: 404, body: { message: "No parent issue found " }, reason: null },
      { status: 404, body: { message: ["No parent issue found"] }, reason: null },
      { status: 404, body: null, reason: null },
      { status: 404, body: {}, reason: null },
      { status: 404, body: "No parent issue found", reason: null },
      { status: 403, body: { message: "No parent issue found" }, reason: null },
      { status: 404, body: { message: "No parent issue found" }, endpoint: "/repos/a/b/issues/1", reason: null },
      { status: 404, body: { message: "No parent issue found" }, method: "DELETE", reason: null },
    ];
    for (const test of cases) {
      let calls = 0;
      const events: GitHubRecord[] = [];
      const client = await GitHubClient.create(config(), { env: credentials,
        run: async () => { calls++; return reply(test.status, test.body); }, record: async event => { events.push(event); } });
      const request = test.method === "DELETE" ? client.update("DELETE", endpoint, {}) : client.get(test.endpoint ?? endpoint);
      await expect(request).rejects.toMatchObject({ kind: test.status === 403 ? "permission" : "request", reason: test.reason });
      expect(JSON.stringify(await request.catch(error => error))).not.toContain("fixture-secret");
      expect(calls).toBe(1);
      expect(JSON.stringify(events)).not.toContain("fixture-secret");
    }
    const invalid = await GitHubClient.create(config(), { env: credentials,
      run: async () => ({ ...reply(404, {}), stdout: 'HTTP/2 404 Missing\r\nContent-Type: application/json\r\n\r\n{"message":"No parent issue found"' }) });
    await expect(invalid.get(endpoint)).rejects.toMatchObject({ kind: "request", status: 404, reason: null });
  });
  it("全ページ取得・専用認証・hostname固定・stdinによるJSON更新", async () => {
    const calls: { args: string[]; env: Record<string, string>; input?: string }[] = [];
    const run: GitHubProcess = async (program, args, env, input) => {
      expect(program).toBe("gh"); calls.push({ args, env, ...(input ? { input } : {}) });
      if (args[0] === "--version") return { code: 0, stdout: "gh fixture", stderr: "" };
      if (input) return reply(201, { id: 3 });
      return calls.filter(c => c.args[0] !== "--version").length === 1
        ? reply(200, [{ id: 1 }], 'Link: <https://api.github.com/repos/a/b/issues?page=2>; rel="next"\r\n') : reply(200, [{ id: 2 }]);
    };
    const client = await GitHubClient.create(config(), { env: { ...credentials, GH_TOKEN: "ambient", SSH_AUTH_SOCK: "agent", GIT_CONFIG_COUNT: "99" }, run });
    await client.checkExecutable();
    expect(await client.getPages("/repos/a/b/issues")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await client.update("POST", "/repos/a/b/issues/1/comments", { body: "multiline\ntext" })).toEqual({ id: 3 });
    for (const call of calls) {
      expect(call.env.GH_TOKEN).toBe(credentials.HARNESS_GITHUB_WRITE_TOKEN);
      expect(call.env.SSH_AUTH_SOCK).toBeUndefined(); expect(call.env.GITHUB_TOKEN).toBeUndefined();
      expect(JSON.stringify(call.args)).not.toContain("fixture-secret");
    }
    expect(calls.at(-1)!.input).toBe(JSON.stringify({ body: "multiline\ntext" }));
  });
  it("読み取り一時障害だけを初回＋2回、待ち時間を挟んで再試行", async () => {
    let count = 0; const sleeps: number[] = [], events: GitHubRecord[] = [];
    const client = await GitHubClient.create(config(), { env: credentials, run: async () => { count++; return reply(503, {}); },
      sleep: async ms => { sleeps.push(ms); }, record: async e => { events.push(e); } });
    await expect(client.get("/repos/a/b")).rejects.toMatchObject({ kind: "transport" });
    expect(count).toBe(3); expect(sleeps).toEqual([1000, 2000]); expect(events.length).toBe(3);
  });
  it("認証/不正リクエスト/設定は即時停止、エラー・記録に生出力を残さない", async () => {
    for (const status of [401, 403, 404, 422]) {
      let count = 0;
      const client = await GitHubClient.create(config(), { env: credentials, run: async () => { count++; return reply(status, credentials); } });
      try { await client.get("/repos/a/b"); throw new Error("expected"); }
      catch (e) { expect(e).toBeInstanceOf(GitHubError); expect(JSON.stringify(e)).not.toContain("fixture-secret"); }
      expect(count).toBe(1);
    }
    const client = await GitHubClient.create(config(), { env: credentials, run: async () => { throw new Error(credentials.HARNESS_GITHUB_WRITE_TOKEN); } });
    await expect(client.checkExecutable()).rejects.toMatchObject({ kind: "configuration" });
    await expect(client.get("https://evil.example/repos/a/b")).rejects.toThrow();
    for (const code of [2, 4]) {
      let calls = 0;
      const invalid = await GitHubClient.create(config(), { env: credentials, run: async () => { calls++; return { code, stdout: "", stderr: "secret" }; } });
      await expect(invalid.get("/repos/a/b")).rejects.toMatchObject({ kind: code === 4 ? "permission" : "cancelled" });
      expect(calls).toBe(1);
    }
  });
  it("レート制限の再アクセス時刻を保存し即時停止する", async () => {
    for (const headers of ['Retry-After: 60\r\n', 'X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 120\r\n']) {
      const events: GitHubRecord[] = []; let calls = 0;
      const client = await GitHubClient.create(config(), { env: credentials, now: () => 60000,
        run: async () => { calls++; return reply(403, {}, headers); }, record: async e => { events.push(e); } });
      await expect(client.get("/repos/a/b")).rejects.toMatchObject({ kind: "rate_limit", retryAt: "1970-01-01T00:02:00.000Z" });
      expect(calls).toBe(1); expect(events[0]!.retryAt).toBe("1970-01-01T00:02:00.000Z");
    }
  });
  it("更新の応答不明は一度だけ送信し操作固有の照合へ渡す", async () => {
    for (const confirmed of [true, false]) {
      let calls = 0, checks = 0;
      const client = await GitHubClient.create(config(), { env: credentials, run: async () => { calls++; return { code: 1, stdout: "", stderr: credentials.HARNESS_GITHUB_WRITE_TOKEN }; } });
      const update = client.update("POST", "/repos/a/b/issues/1/comments", { body: "report" }, async () => {
        checks++; return confirmed ? { confirmed: true, value: { id: 42 } } : { confirmed: false };
      });
      if (confirmed) expect(await update).toEqual({ id: 42 });
      else await expect(update).rejects.toMatchObject({ kind: "unknown" });
      expect(calls).toBe(1); expect(checks).toBe(1);
    }
  });
  it("成功ヘッダー後の切断・ヘッダー不正・キャンセルも更新を再送せず照合する", async () => {
    const successful = reply(201, { id: 42 });
    const cases = [
      { ...successful, code: 1 }, { ...successful, code: -1 }, { ...successful, code: 4 },
      { code: 0, stdout: "incomplete HTTP headers", stderr: "" },
      { code: 2, stdout: "", stderr: "cancelled" }, { ...successful, code: 2 },
    ];
    for (const result of cases) {
      for (const confirmed of [true, false]) {
        let sent = 0, checked = 0;
        const events: GitHubRecord[] = [];
        const client = await GitHubClient.create(config(), { env: credentials, run: async () => { sent++; return result; },
          record: async event => { events.push(event); } });
        const update = client.update("POST", "/repos/a/b/issues/1/comments", { body: "report" }, async () => {
          checked++; return confirmed ? { confirmed: true, value: { id: 42 } } : { confirmed: false };
        });
        if (confirmed) expect(await update).toEqual({ id: 42 });
        else await expect(update).rejects.toMatchObject({ kind: "unknown" });
        expect(sent).toBe(1); expect(checked).toBe(1);
        expect(events).toEqual([{ kind: "unknown", attempt: 1, retryAt: null }]);
      }
    }
  });
  it("制限時刻をrunイベントへ永続化し、保存不能では追加通信しない", async () => {
    const root = await mkdtemp(join(tmpdir(), "github-record-"));
    const store = new RunStore(newRunId(), root, Object.values(credentials));
    await mkdir(store.runPath, { recursive: true });
    let calls = 0;
    const run: GitHubProcess = async () => { calls++; return reply(429, credentials, "Retry-After: 60\r\n"); };
    const client = await GitHubClient.create(config(), { env: credentials, now: () => 60000, run, record: githubRunRecorder(store) });
    await expect(client.get("/repos/a/b")).rejects.toMatchObject({ kind: "rate_limit" });
    expect((await store.loadEvents())[0]!.data).toEqual({ kind: "rate_limit", attempt: 1, retryAt: "1970-01-01T00:02:00.000Z" });
    const broken = await GitHubClient.create(config(), { env: credentials, run,
      record: githubRunRecorder({ appendEvent: async () => { throw new Error("disk failure"); } }) });
    await expect(broken.get("/repos/a/b")).rejects.toThrow("disk failure");
    expect(calls).toBe(2);
  });
  it("ページ循環・外部ホスト・不正JSON・一覧欠落では停止", async () => {
    for (const link of ['<https://evil.example/repos/a/b>; rel="next"', '<https://api.github.com/repos/a/b>; rel="next"']) {
      const client = await GitHubClient.create(config(), { env: credentials, run: async () => reply(200, [], `Link: ${link}\r\n`) });
      await expect(client.getPages("/repos/a/b")).rejects.toMatchObject({ kind: "response" });
    }
    const client = await GitHubClient.create(config(), { env: credentials, run: async () => reply(200, {}) });
    await expect(client.getPages("/repos/a/b")).rejects.toMatchObject({ kind: "response" });
  });
  it("成功応答に認証値が含まれても成果へ渡さず、時刻不明の二次制限は推測しない", async () => {
    const client = await GitHubClient.create(config(), { env: credentials, run: async () => reply(200, credentials) });
    expect(JSON.stringify(await client.get("/repos/a/b"))).not.toContain("fixture-secret");
    const limited = await GitHubClient.create(config(), { env: credentials, run: async () => reply(403, { message: "secondary rate limit" }) });
    await expect(limited.get("/repos/a/b")).rejects.toMatchObject({ kind: "rate_limit", retryAt: null });
  });
  it("実gh代役プロセスに専用環境だけを渡し、標準エラーやargvに秘密を載せない", async () => {
    const dir = await mkdtemp(join(tmpdir(), "github-cli-"));
    await writeFile(join(dir, "gh"), `#!/bin/sh\nif test -z "$GH_TOKEN" || test -n "$GITHUB_TOKEN$SSH_AUTH_SOCK$HARNESS_GITHUB_WRITE_TOKEN"; then exit 9; fi\nprintf 'HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n{"ok":true}'\n`, { mode: 0o700 });
    const client = await GitHubClient.create(config(), { env: { ...credentials, PATH: dir + ":" + process.env.PATH, GITHUB_TOKEN: "ambient" } });
    expect(await client.get("/repos/a/b")).toEqual({ ok: true });
  });
});

describe("認証環境とGit通信", () => {
  it("既存認証・SSH・Git設定・任意名のsecretを引き継がず、認証ファイルを作らない", async () => {
    const env = await isolatedGitHubEnvironment({ PATH: process.env.PATH, GH_TOKEN: "ambient", GITHUB_TOKEN: "ambient", HOME: "/danger", SSH_AUTH_SOCK: "/danger", CUSTOM: "write-secret" });
    expect(env.HOME).not.toBe("/danger"); expect(env.GH_TOKEN).toBeUndefined(); expect(env.CUSTOM).toBeUndefined();
    expect(await readdir(env.GH_CONFIG_DIR!)).toEqual([]);
    const verify = await executionEnvironment();
    expect(verify.GH_TOKEN).toBeUndefined(); expect(verify.GIT_CONFIG_GLOBAL).toBe("/dev/null"); expect(verify.GIT_TERMINAL_PROMPT).toBe("0");
  });
  it("実Gitでrepo固有のhelper・認証header・書換えを拒否、通常repoは許可", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "github-git-"));
    const env = await isolatedGitHubEnvironment();
    expect((await githubProcess("git", ["init", cwd], env)).code).toBe(0);
    await checkRepositoryCredentials(cwd, env);
    for (const key of ["credential.helper", "http.https://github.com/.extraHeader", "url.https://evil/.insteadOf", "include.path"]) {
      await githubProcess("git", ["config", "--local", key, "/danger"], env, undefined, cwd);
      await expect(checkRepositoryCredentials(cwd, env)).rejects.toThrow();
      await githubProcess("git", ["config", "--local", "--unset-all", key], env, undefined, cwd);
    }
    await githubProcess("git", ["config", "extensions.worktreeConfig", "true"], env, undefined, cwd);
    await githubProcess("git", ["config", "--worktree", "credential.helper", "/danger"], env, undefined, cwd);
    await expect(checkRepositoryCredentials(cwd, env)).rejects.toThrow();
  });
  it("clone/fetch/pushはHTTPS・引数配列・専用token環境、失敗pushは応答不明", async () => {
    for (const operation of ["clone", "fetch", "push"] as const) {
      const calls: { args: string[]; env: Record<string, string> }[] = [];
      const result = await runAuthenticatedGit({ operation, repository: "Owner/Repo", token: "git-secret", cwd: "/tmp", destination: "clone",
        ...(operation === "push" ? { refs: ["HEAD:refs/heads/main"] } : {}), run: async (_p, args, env) => {
        calls.push({ args, env }); return { code: args[0] === "config" ? 1 : 0, stdout: "git-secret", stderr: "" };
      } });
      const call = calls.at(-1)!;
      expect(call.args).toContain("https://github.com/owner/repo.git"); expect(JSON.stringify(call.args)).not.toContain("git-secret");
      expect(call.env.HARNESS_GIT_TOKEN).toBe("git-secret"); expect(call.env.GH_TOKEN).toBeUndefined(); expect(result.stdout).toBe("[REDACTED]");
    }
    await expect(runAuthenticatedGit({ operation: "push", repository: "a/b", token: "secret", cwd: "/tmp", refs: ["HEAD:refs/heads/main"],
      run: async (_p, args) => ({ code: 1, stdout: "", stderr: args[0] === "config" ? "" : "secret" }) })).rejects.toMatchObject({ kind: "unknown" });
  });
  it("実credential helperはgetのみtokenを返しstoreに永続化しない", async () => {
    let helperEnv: Record<string, string> = {};
    await runAuthenticatedGit({ operation: "clone", repository: "a/b", token: "git-fixture-secret", cwd: "/tmp", destination: "unused",
      run: async (_p, _a, env) => { helperEnv = env; return { code: 0, stdout: "", stderr: "" }; } });
    const result = await githubProcess("git", ["credential", "fill"], helperEnv, "protocol=https\nhost=github.com\n\n", "/tmp");
    expect(result.code).toBe(0); expect(result.stdout).toContain("password=git-fixture-secret");
    const foreign = await githubProcess("git", ["credential", "fill"], helperEnv, "protocol=https\nhost=evil.example\n\n", "/tmp");
    expect(foreign.code).not.toBe(0); expect(foreign.stdout + foreign.stderr).not.toContain("git-fixture-secret");
    await githubProcess("git", ["credential", "approve"], helperEnv, result.stdout + "\n", "/tmp");
    expect(await readdir(helperEnv.HOME!)).toEqual(["gh"]);
  });
  it("fetch一時障害だけを最大2回再試行し、認証拒否・clone部分失敗・pushを再送しない", async () => {
    for (const operation of ["fetch", "clone", "push"] as const) {
      let calls = 0; const sleeps: number[] = [];
      await expect(runAuthenticatedGit({ operation, repository: "a/b", token: "secret", cwd: "/tmp", destination: "unused",
        ...(operation === "push" ? { refs: ["HEAD:refs/heads/main"] } : {}),
        sleep: async ms => { sleeps.push(ms); }, run: async (_p, args) => {
          if (args[0] === "config") return { code: 1, stdout: "", stderr: "" };
          calls++; return { code: 1, stdout: "", stderr: "Could not resolve host" };
        } })).rejects.toBeInstanceOf(GitHubError);
      expect(calls).toBe(operation === "fetch" ? 3 : 1);
      expect(sleeps.length).toBe(operation === "fetch" ? 2 : 0);
    }
    let calls = 0;
    await expect(runAuthenticatedGit({ operation: "fetch", repository: "a/b", token: "secret", cwd: "/tmp", run: async (_p, args) => {
      if (args[0] !== "config") calls++;
      return { code: 1, stdout: "", stderr: "Authentication failed secret" };
    } })).rejects.toMatchObject({ kind: "permission" });
    expect(calls).toBe(1);
  });
  it("URLと同名のremoteによる宛先上書きは、実Gitの通信前に拒否する", async () => {
    const root = await mkdtemp(join(tmpdir(), "github-url-remote-"));
    const env = await isolatedGitHubEnvironment();
    expect((await githubProcess("git", ["init", root], env)).code).toBe(0);
    for (const scope of ["--local", "--worktree"]) {
      if (scope === "--worktree") await githubProcess("git", ["config", "--local", "extensions.worktreeConfig", "true"], env, undefined, root);
      for (const property of ["url", "pushurl", "receivepack", "mirror"]) {
        const key = `remote.https://github.com/a/b.git.${property}`;
        expect((await githubProcess("git", ["config", scope, key, "/tmp/unrelated.git"], env, undefined, root)).code).toBe(0);
        await expect(checkRepositoryCredentials(root, env)).rejects.toThrow();
        let transfers = 0;
        const run: GitHubProcess = async (program, args, childEnv, input, cwd) => {
          if (args[0] !== "config") { transfers++; throw new Error("通信してはいけない"); }
          return githubProcess(program, args, childEnv, input, cwd);
        };
        for (const operation of ["fetch", "push"] as const) await expect(runAuthenticatedGit({
          operation, repository: "a/b", cwd: root, token: "fixture-secret", refs: ["HEAD:refs/heads/main"], run,
        })).rejects.toThrow();
        expect(transfers).toBe(0);
        await githubProcess("git", ["config", scope, "--unset-all", key], env, undefined, root);
      }
    }
  });
  it("pushは一つの明示ブランチを必須とし、暗黙ref・削除・wildcardを通信前に拒否する", async () => {
    for (const refs of [[], ["HEAD"], [":refs/heads/main"], ["refs/heads/*:refs/heads/*"],
      ["HEAD:refs/heads/main", "HEAD:refs/heads/other"], ["+HEAD:refs/heads/main"], ["HEAD:refs/tags/tag"]]) {
      let called = false;
      await expect(runAuthenticatedGit({ operation: "push", repository: "a/b", token: "fixture-secret", cwd: "/tmp", refs,
        run: async () => { called = true; throw new Error("呼び出してはいけない"); } })).rejects.toThrow();
      expect(called).toBe(false);
    }
  });
  it("実Git pushで再帰サブモジュール・followTags・matching設定からの追加更新を抑止する", async () => {
    const root = await mkdtemp(join(tmpdir(), "github-push-config-"));
    const env = { ...await isolatedGitHubEnvironment(), GIT_ALLOW_PROTOCOL: "file" };
    const parent = join(root, "parent"), parentRemote = join(root, "parent.git"), child = join(root, "child-source"), childRemote = join(root, "child.git");
    const git = async (cwd: string, args: string[]) => {
      const result = await githubProcess("git", args, env, undefined, cwd);
      expect(result.code, "ローカルGit準備・検査の失敗").toBe(0);
      return result.stdout.trim();
    };
    for (const repo of [parent, child]) {
      await git(root, ["init", "-b", "main", repo]);
      await git(repo, ["config", "user.name", "Test"]); await git(repo, ["config", "user.email", "test@example.invalid"]);
      await git(repo, ["commit", "--allow-empty", "-m", "initial"]);
    }
    await git(root, ["clone", "--bare", child, childRemote]);
    await git(parent, ["submodule", "add", childRemote, "child"]);
    await git(parent, ["commit", "-am", "add child"]);
    await git(root, ["clone", "--bare", parent, parentRemote]);
    await git(parent, ["remote", "add", "origin", parentRemote]);
    const childWorktree = join(parent, "child");
    await git(childWorktree, ["config", "user.name", "Test"]); await git(childWorktree, ["config", "user.email", "test@example.invalid"]);
    const originalChild = await git(childRemote, ["rev-parse", "refs/heads/main"]);
    await git(childWorktree, ["commit", "--allow-empty", "-m", "unpublished child"]);
    await git(parent, ["commit", "-am", "update child pointer"]);
    await git(parent, ["config", "push.recurseSubmodules", "on-demand"]);
    await git(parent, ["config", "push.followTags", "true"]);
    await git(parent, ["config", "push.default", "matching"]);
    await git(parent, ["tag", "-a", "unrequested-tag", "-m", "unrequested"]);
    await git(parent, ["branch", "unrequested-branch"]);
    // 実Gitを使うが、このテストだけ固定HTTPS URLをローカルbareへ差し替えて外部通信を防ぐ。
    const run: GitHubProcess = (program, args, childEnv, input, cwd) => {
      if (args[0] !== "push") return githubProcess(program, args, childEnv, input, cwd);
      expect(childEnv.GIT_ALLOW_PROTOCOL).toBe("https");
      return githubProcess(program, args.map(v => v === "https://github.com/a/b.git" ? parentRemote : v),
        { ...childEnv, GIT_ALLOW_PROTOCOL: "file" }, input, cwd);
    };
    await runAuthenticatedGit({ operation: "push", repository: "a/b", token: "fixture-secret", cwd: parent,
      refs: ["HEAD:refs/heads/main"], run });
    expect(await git(parentRemote, ["rev-parse", "refs/heads/main"])).toBe(await git(parent, ["rev-parse", "HEAD"]));
    expect(await git(childRemote, ["rev-parse", "refs/heads/main"])).toBe(originalChild);
    expect(await git(parentRemote, ["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/main");
  });
});
