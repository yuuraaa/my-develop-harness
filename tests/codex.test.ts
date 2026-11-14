import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex, type ThreadEvent } from "@openai/codex-sdk";
import * as sdk from "@openai/codex-sdk";
import { beforeEach, afterEach, describe, expect, it, jest } from "bun:test";
import { z } from "zod";
import { createCodexConnection, planSchema, runStructured } from "../src/codex.js";
import { reviewSchema } from "../src/schemas.js";


import { parseGitHubConfig } from "../src/github-config.js";
import { githubProcess, isolatedGitHubEnvironment } from "../src/github-auth.js";

// 名前空間のspyを各テスト後に復元し、他ファイルへモジュールモックを漏らさない。
const ActualCodex = Codex;
let constructorSpy: ReturnType<typeof observeConstructor>;
function observeConstructor() {
  // BunのspyOn型はクラスコンストラクターを関数として推論しないため、同じ引数のfactory型で観測する。
  const constructors = sdk as unknown as { Codex: (options?: ConstructorParameters<typeof Codex>[0]) => Codex };
  return jest.spyOn(constructors, "Codex").mockImplementation(function(options) { return new ActualCodex(options); });
}
beforeEach(() => { constructorSpy = observeConstructor(); });
afterEach(() => { jest.restoreAllMocks(); });

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "harness-sdk-"));
  temporary.push(path);
  return path;
}
const usage = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 };
const plan = { summary: "調査", steps: [], validationPlan: [], undetectedValidation: ["lint定義なし"], blockers: [] };
function stream(events: ThreadEvent[], id: string | null = "thread-test") {
  return { id, runStreamed: jest.fn(async () => ({ events: (async function* () { yield* events; })() })) };
}
function success(text: string): ThreadEvent[] {
  return [
    { type: "thread.started", thread_id: "thread-test" },
    { type: "item.completed", item: { id: "answer", type: "agent_message", text } },
    { type: "turn.completed", usage },
  ];
}

describe("Codex接続の境界", () => {
  it("GitHub書き込み認証と継承候補の名前・値の衝突をSDK/ホーム初期化前に拒否する", async () => {
    const writer = "writer-collision-fixture";
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "PATH", "HOME", "TMPDIR", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR", "HARNESS_CODEX_PATH"]) {
      for (const useSameName of [true, false]) {
        const path = await directory();
        const writeTokenEnv = useSameName ? key : "CUSTOM_WRITE";
        const github = parseGitHubConfig({ schemaVersion: 2, github: { readTokenEnv: "CUSTOM_READ", writeTokenEnv } }, "/tmp/config.json");
        const source = { HOME: path, PATH: process.env.PATH!, CUSTOM_READ: "reader-fixture", [writeTokenEnv]: writer, [key]: writer };
        const before = constructorSpy.mock.calls.length;
        try {
          await createCodexConnection({ worktreePath: path, github, env: source });
          throw new Error("衝突した認証を受け入れた");
        } catch (error) {
          expect(error).toMatchObject({ message: "Codex SDK: configuration" });
          expect(String(error) + JSON.stringify(error)).not.toContain(writer);
        }
        expect(constructorSpy.mock.calls.length).toBe(before);
        expect(await readdir(path)).toEqual([]);
      }
    }
    const path = await directory();
    const github = parseGitHubConfig({ schemaVersion: 2, github: {} }, "/tmp/config.json");
    await expect(createCodexConnection({ worktreePath: path, github, env: { HOME: path,
      HARNESS_GITHUB_READ_TOKEN: "reader-fixture", HARNESS_GITHUB_WRITE_TOKEN: writer,
      TMPDIR: `/tmp/${writer}/artifacts` } })).rejects.toThrow("configuration");
    expect(await readdir(path)).toEqual([]);
  });
  it("GitHub接続は全フェーズで読み取りghだけを渡し、既存ログイン・MCP・SSHを分離する", async () => {
    const path = await directory();
    await mkdir(join(path, ".codex")); await writeFile(join(path, ".codex", "auth.json"), '{"fixture":true}');
    await githubProcess("git", ["init", path], await isolatedGitHubEnvironment());
    const github = parseGitHubConfig({ schemaVersion: 2, github: { readTokenEnv: "R", writeTokenEnv: "W" } }, "/tmp/config.json");
    const connection = await createCodexConnection({ worktreePath: path, github, env: {
      HOME: path, PATH: process.env.PATH!, R: "read-gh-fixture", W: "write-gh-fixture", GH_TOKEN: "ambient-write",
      GITHUB_TOKEN: "ambient-write", SSH_AUTH_SOCK: "/agent", HARNESS_TEST_SECRET_TOKEN: "old-write",
      OPENAI_API_KEY: "openai-key-fixture",
    } });
    const startSpy = jest.spyOn(ActualCodex.prototype, "startThread");
    for (const phase of ["plan", "implementation", "fix", "review", "commit", "report"] as const) {
      const next = await connection.prepare!(phase);
      next.start();
      const opts = constructorSpy.mock.calls.at(-1)![0]!;
      expect(opts.env!.GH_TOKEN).toBe("read-gh-fixture");
      expect(opts.env!.OPENAI_API_KEY).toBe("openai-key-fixture"); expect(opts.apiKey).toBe("openai-key-fixture");
      expect(opts.env!.HOME).not.toBe(path);
      expect(opts.env!.GH_CONFIG_DIR).toContain("harness-auth-");
      expect(JSON.stringify(opts)).not.toContain("write-gh-fixture");
      expect(JSON.stringify(opts)).not.toContain("ambient-write");
      expect(opts.env!.SSH_AUTH_SOCK).toBeUndefined(); expect(opts.env!.HARNESS_TEST_READ_TOKEN).toBeUndefined();
      expect(opts.configOverrides![0]).toBe("mcp_servers={}");
      const policy = opts.configOverrides!.find(v => v.startsWith("shell_environment_policy="))!;
      expect(policy).toContain('"GH_TOKEN"'); expect(policy).toContain('ignore_default_excludes=true');
      expect(policy).not.toContain('"OPENAI_API_KEY"'); expect(policy).not.toContain("gh-fixture");
      expect(startSpy).toHaveBeenLastCalledWith(expect.objectContaining({ networkAccessEnabled: true, approvalPolicy: "never" }));
    }
    const runtime = constructorSpy.mock.calls.at(-1)![0]!.env!.CODEX_HOME!;
    for (const file of ["config.toml", "rules/active.rules"]) {
      expect(await readFile(join(runtime, file), "utf8")).not.toContain("gh-fixture");
    }
  });
  it("SDK初期化例外も安全な表示と元のcauseを分けて保持する", async () => {
    const path = await directory();
    await mkdir(join(path, ".codex")); await writeFile(join(path, ".codex", "auth.json"), '{"fixture":true}');
    await githubProcess("git", ["init", path], await isolatedGitHubEnvironment());
    constructorSpy.mockImplementationOnce(() => { throw new Error("SDK executable resolution failed"); });
    await expect(createCodexConnection({ worktreePath: path, codexHome: path,
      github: parseGitHubConfig({ schemaVersion: 2, github: {} }, "/tmp/config.json"), env: { HOME: path, HARNESS_GITHUB_READ_TOKEN: "read-secret", HARNESS_GITHUB_WRITE_TOKEN: "write-secret" } }))
      .rejects.toMatchObject({ message: "Codex SDK: configuration", cause: { message: "SDK executable resolution failed" } });
  });
  it("不正な設定・読み取り認証不足はSDKを呼ぶ前に拒否する", async () => {
    const path = await directory();
    const options = { worktreePath: path, codexHome: path, github: parseGitHubConfig({ schemaVersion: 2, github: {} }, "/tmp/config.json"), env: {} };
    await expect(createCodexConnection(options)).rejects.toThrow("configuration");
    await expect(createCodexConnection({ ...options, worktreePath: "relative" })).rejects.toThrow("configuration");
  });

  it("継続IDを保ちフェーズごとに1ルールだけを再読し、ユーザー編集と固定制約を反映する", async () => {
    const path = await directory();
    await mkdir(join(path, ".codex")); await writeFile(join(path, ".codex", "auth.json"), '{"fixture":true}');
    await githubProcess("git", ["init", path], await isolatedGitHubEnvironment());
    const home = join(path, ".harness");
    const connection = await createCodexConnection({ worktreePath: path,
      github: parseGitHubConfig({ schemaVersion: 2, github: {} }, "/tmp/config.json"),
      env: { HOME: path, PATH: process.env.PATH!, HARNESS_GITHUB_READ_TOKEN: "read-fixture", HARNESS_GITHUB_WRITE_TOKEN: "write-fixture" } });
    const resumeSpy = jest.spyOn(ActualCodex.prototype, "resumeThread");
    for (const phase of ["plan", "implementation", "fix", "review", "commit", "report"] as const) {
      await writeFile(join(home, "rules", `${phase}.rules`), `# ${phase}編集\n`);
      await writeFile(join(home, "config.toml"), `model = "${phase}-choice"\ncli_auth_credentials_store = "keyring"\n[mcp_servers.unwanted]\nurl = "http://unwanted/mcp"\n`);
      const next = await connection.prepare!(phase);
      const opts = constructorSpy.mock.calls.at(-1)![0]!;
      const runtime = opts.env!.CODEX_HOME!;
      expect(await readdir(join(runtime, "rules"))).toEqual(["active.rules"]);
      expect(await readFile(join(runtime, "rules", "active.rules"), "utf8")).toBe(`# ${phase}編集\n`);
      expect(await readFile(join(runtime, "config.toml"), "utf8")).toContain(`model = "${phase}-choice"`);
      expect(opts.configOverrides).toContain('cli_auth_credentials_store="file"');
      expect(opts.configOverrides?.[0]).not.toContain("unwanted");
      expect(opts.configOverrides).toContain(`projects.${JSON.stringify(path)}.trust_level="untrusted"`);
      expect(next.resume("same-thread").id).toBe("same-thread");
      expect(resumeSpy).toHaveBeenLastCalledWith("same-thread", expect.objectContaining({
        sandboxMode: phase === "implementation" || phase === "fix" ? "workspace-write" : "read-only",
        approvalPolicy: "never", networkAccessEnabled: true,
      }));
      expect(next.resume("same-thread", true).id).toBe("same-thread");
      expect(resumeSpy).toHaveBeenLastCalledWith("same-thread", expect.objectContaining({ sandboxMode: "read-only", approvalPolicy: "never" }));
    }
    resumeSpy.mockRestore();
  });
});

describe("構造化ストリーム", () => {
  it("ReviewのSDK出力SchemaでもvalidationCommandIdsを必須の文字列配列にする", async () => {
    const review = { summary: "指摘", findings: [{ severity: "major" as const, description: "共通原因を修正",
      validationCommandIds: ["node-tests", "bun-tests"], location: "tests/a.ts:54" }], unverifiedItems: [], blockers: [] };
    const thread = stream(success(JSON.stringify(review)));
    expect((await runStructured(thread, "レビュー", reviewSchema)).output).toEqual(review);
    expect(thread.runStreamed).toHaveBeenCalledWith("レビュー", { outputSchema: expect.objectContaining({
      properties: expect.objectContaining({ findings: expect.objectContaining({ items: expect.objectContaining({
        required: expect.arrayContaining(["severity", "description", "validationCommandIds", "location"]),
        properties: expect.objectContaining({ validationCommandIds: { type: "array", items: { type: "string", minLength: 1 } } }),
      }) }) }),
    }) });
    const { validationCommandIds: _ids, ...missingRequiredField } = review.findings[0]!;
    await expect(runStructured(stream(success(JSON.stringify({ ...review, findings: [missingRequiredField] }))), "", reviewSchema)).rejects.toThrow("response");
  });
  it("PlanをJSON Schemaで要求し、Zodで検証して参考情報として返す", async () => {
    const thread = stream(success(JSON.stringify(plan)));
    const events: unknown[] = [];
    const result = await runStructured(thread, "計画", planSchema, event => { events.push(event); });
    expect(result).toEqual({ threadId: "thread-test", output: plan, source: "codex" });
    expect(thread.runStreamed).toHaveBeenCalledWith("計画", { outputSchema: expect.objectContaining({ type: "object", additionalProperties: false }) });
    expect(events).toContainEqual({ type: "thread.started", threadId: "thread-test" });
    expect(JSON.stringify(events)).not.toContain("lint定義なし");
  });

  it.each(["not-json", JSON.stringify({ ...plan, blockers: 123 }), JSON.stringify({ ...plan, status: "passed" })])("不正な応答を拒否する: %s", async text => {
    await expect(runStructured(stream(success(text)), "", planSchema)).rejects.toThrow("response");
  });

  it.each([
    [{ type: "turn.failed", error: { message: "secret" } }],
    [{ type: "error", message: "secret" }],
    success(JSON.stringify(plan)).slice(0, -1),
  ].map(events => ({ events: events as ThreadEvent[] })))("失敗・途中終了を成功とせず秘密値も返さない", async ({ events }) => {
    await expect(runStructured(stream(events), "", planSchema)).rejects.toThrow(/^Codex SDK: execution$/);
  });

  it("SDK例外と欠けたthread IDも失敗にする", async () => {
    const thread = stream([]);
    thread.runStreamed.mockRejectedValue(new Error("secret-token"));
    await expect(runStructured(thread, "", planSchema)).rejects.toThrow(/^Codex SDK: execution$/);
    await expect(runStructured(stream(success(JSON.stringify(plan)), null), "", planSchema)).rejects.toThrow("execution");
  });

  it("MCP観測にはツール名と状態だけを渡す", async () => {
    const events = success(JSON.stringify(plan));
    events.splice(1, 0, { type: "item.completed", item: {
      id: "mcp", type: "mcp_tool_call", server: "external", tool: "read_data", status: "completed",
      arguments: { token: "secret-argument" },
      result: { content: [{ type: "text", text: "secret-result" }], structured_content: null },
    } });
    const observations: unknown[] = [];
    await runStructured(stream(events), "", planSchema, event => { observations.push(event); });
    expect(observations).toContainEqual({ type: "item.completed", itemType: "mcp_tool_call", mcp: { server: "external", tool: "read_data", status: "completed" } });
    expect(JSON.stringify(observations)).not.toContain("secret");
  });

  it("検出コマンドの根拠と実行場所・未検出を保持する", () => {
    const definition = { id: "test", kind: "test" as const, command: "docker compose exec dev npm test", workingDirectory: ".", executionMethod: "/workspaceへのworktree bind mount", evidence: "README.md 開発環境 / package.json scripts.test", required: true };
    expect(planSchema.parse({ ...plan, validationPlan: [definition] }).validationPlan).toEqual([definition]);
    expect(planSchema.safeParse({ ...plan, validationPlan: [{ ...definition, evidence: "" }] }).success).toBe(false);
  });

  it("実SDKで新規・継続・別スレッドとschemaファイル受渡しを確認する（CLIはテスト用）", async () => {
    const path = await directory();
    const cli = join(path, "fake-codex");
    await mkdir(join(path, "home"));
    await writeFile(cli, `#!/usr/bin/env bun
const fs = require('node:fs');
const args = process.argv.slice(2);
const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
if (schema.type !== 'object') process.exit(2);
const resumed = args.indexOf('resume');
const id = resumed < 0 ? require('node:crypto').randomUUID() : args[resumed + 1];
process.stdin.resume();
process.stdin.on('end', () => {
console.log(JSON.stringify({type:'thread.started',thread_id:id}));
console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify({summary:resumed < 0 ? 'new' : 'continued'})}}));
console.log(JSON.stringify({type:'turn.completed',usage:${JSON.stringify(usage)}}));
});
`, { mode: 0o700 });
    const codex = new Codex({ codexPathOverride: cli });
    const schema = z.object({ summary: z.string() }).strict();
    const first = codex.startThread();
    expect(first.id).toBeNull();
    const result = await runStructured(first, "first", schema);
    expect((await runStructured(first, "again", schema)).threadId).toBe(result.threadId);
    expect((await runStructured(codex.resumeThread(result.threadId), "resume", schema)).output.summary).toBe("continued");
    expect((await runStructured(codex.startThread(), "independent", schema)).threadId).not.toBe(result.threadId);
  });
});
