import { testStateSchema as stateSchema } from "./helpers/issue-state.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { z } from "zod";
import { afterEach, describe, expect, it } from "bun:test";
import { createCodexConnection, runStructured } from "../src/codex.js";
import { parseGitHubConfig } from "../src/github-config.js";
import { githubProcess, isolatedGitHubEnvironment } from "../src/github-auth.js";
import { RunStore, newRunId } from "../src/state.js";
import { mkdir, readdir } from "node:fs/promises";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("実SDKと外部CLIの終了処理（Node.js製のテスト用CLI）", () => {
  it("gitIdentityを実SDKからCLI・許可されたシェル環境へ渡し、Git設定を変更せずコミットに使う", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-identity-")); roots.push(root);
    await mkdir(join(root, ".codex")); await writeFile(join(root, ".codex/auth.json"), '{"fixture":true}');
    const gitEnv = await isolatedGitHubEnvironment(process.env, root);
    expect((await githubProcess("git", ["init", root], gitEnv)).code).toBe(0);
    const before = await readFile(join(root, ".git/config"), "utf8");
    const cli = join(root, "fake-codex"), observed = join(root, "observed.json");
    // 実モデルの代わりにCLIを置き換え、SDKが渡したpolicyに従ってシェルを起動する。
    await writeFile(cli, `#!/usr/bin/env bun
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
process.stdin.resume();
process.stdin.on('end', () => {
  const policy = process.argv.find(a => a.startsWith('shell_environment_policy='));
  const keys = JSON.parse(policy.match(/include_only=(\\[[^\\]]*\\])/)[1]);
  const env = Object.fromEntries(keys.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  const shell = spawnSync('/bin/sh', ['-ec', 'git -c user.useConfigOnly=true commit --allow-empty -m identity-probe && git log -1 --format="%an|%ae|%cn|%ce"'], { cwd: ${JSON.stringify(root)}, env, encoding: 'utf8' });
  fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ env: process.env, shellEnv: env, status: shell.status, stdout: shell.stdout, stderr: shell.stderr }));
  console.log(JSON.stringify({type:'thread.started', thread_id:'identity-test'}));
  console.log(JSON.stringify({type:'item.completed', item:{id:'answer', type:'agent_message', text:'{"summary":"identity"}'}}));
  console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:1, cached_input_tokens:0, output_tokens:1}}));
});
`, { mode: 0o700 });
    const github = parseGitHubConfig({ schemaVersion: 2, github: {}, execution: {
      gitIdentity: { name: "共通 Bot", email: "bot@example.com" },
    } }, join(root, "config.json"));
    const connection = await createCodexConnection({ worktreePath: root, github, env: {
      HOME: root, PATH: process.env.PATH!, HARNESS_CODEX_PATH: cli,
      HARNESS_GITHUB_READ_TOKEN: "read-fixture", HARNESS_GITHUB_WRITE_TOKEN: "write-fixture",
      GIT_AUTHOR_NAME: "ambient-author", GIT_AUTHOR_EMAIL: "ambient@example.com",
      GIT_COMMITTER_NAME: "ambient-committer", GIT_COMMITTER_EMAIL: "ambient@example.com",
      GH_TOKEN: "ambient-token", SSH_AUTH_SOCK: "/agent", OPENAI_API_KEY: "openai-fixture",
    } });
    for (const phase of ["plan", "implementation", "fix", "review", "commit", "report"] as const) {
      const next = await connection.prepare!(phase);
      await runStructured(next.start(), "identity-probe", z.object({ summary: z.string() }));
      const result = JSON.parse(await readFile(observed, "utf8"));
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("共通 Bot|bot@example.com|共通 Bot|bot@example.com");
      for (const env of [result.env, result.shellEnv]) {
        expect(env).toMatchObject({ GIT_AUTHOR_NAME: "共通 Bot", GIT_AUTHOR_EMAIL: "bot@example.com",
          GIT_COMMITTER_NAME: "共通 Bot", GIT_COMMITTER_EMAIL: "bot@example.com",
          GH_TOKEN: "read-fixture", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
        expect(env.SSH_AUTH_SOCK).toBeUndefined();
        expect(JSON.stringify(env)).not.toContain("write-fixture");
        expect(JSON.stringify(env)).not.toContain("ambient-");
      }
      expect(result.shellEnv.OPENAI_API_KEY).toBeUndefined();
      expect(await readFile(join(root, ".git/config"), "utf8")).toBe(before);
    }
  });
  it.each(["nonzero", "incomplete"])("%s終了を成功扱いせず、stdin・プロセス終了を確認する", async mode => {
    const root = await mkdtemp(join(tmpdir(), "codex-process-")); roots.push(root);
    const cli = join(root, "fake-codex"), observed = join(root, "observed.json");
    await writeFile(cli, `#!/usr/bin/env bun
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.on('exit', code => fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({input, code})));
process.stdin.on('end', () => {
  console.log(JSON.stringify({type:'thread.started', thread_id:'process-test'}));
  console.log(JSON.stringify({type:'item.completed', item:{id:'answer', type:'agent_message', text:'{"summary":"response"}'}}));
  if (${JSON.stringify(mode)} === 'nonzero') {
    console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:1, cached_input_tokens:0, output_tokens:1}}));
    console.error('private-stderr');
    process.exitCode = 7;
  }
});
`, { mode: 0o700 });
    const thread = new Codex({ codexPathOverride: cli }).startThread();
    const store = new RunStore(newRunId(), root, ["private-stderr"]);
    await mkdir(store.artifactsPath, { recursive: true });
    await store.appendEvent({ timestamp: new Date().toISOString(), type: "operation.started", phase: "plan", data: { operation: "codex.plan.1", retryCount: 0 } });
    await expect(runStructured(thread, "process-probe", z.object({ summary: z.string() }), async event => {
      if (event.diagnostic) await store.saveCodexDiagnostic({ ...event.diagnostic, runId: store.runId,
        phase: "plan", attempt: 1, retryCount: 0, operation: "codex.plan.1", threadId: thread.id, timestamp: new Date().toISOString() });
    }))
      .rejects.toMatchObject({ kind: "execution", safeToRetry: false, message: "Codex SDK: execution" });
    const names = await readdir(store.artifactsPath);
    expect(names).toHaveLength(1);
    const raw = await readFile(join(store.artifactsPath, names[0]!), "utf8");
    expect(raw).not.toContain("private-stderr");
    const diagnostic = JSON.parse(raw);
    expect(diagnostic).toMatchObject({ threadId: "process-test", source: mode === "nonzero" ? "exception" : "incomplete" });
    if (mode === "nonzero") expect(diagnostic.details[0].message).toContain("Codex Exec exited with code 7: [REDACTED]");
    const message = await store.stoppedCodexMessage(stateSchema.parse({ schemaVersion: 2, runId: store.runId, issueId: "132",
      repositoryId: "owner/repo", repositoryPath: root, branchName: "fix/test", worktreePath: store.worktreePath, baseCommit: "a".repeat(40),
      phase: "plan", phaseStatus: "failed", status: "stopped", fixCount: 0, retryCount: {}, verificationArtifact: null,
      codexThreadId: "process-test", reviewThreadIds: [], resultCommits: [], reviewedTreeId: null,
      error: { classification: "fatal", message: "Codex SDK: execution", operation: "codex.plan.1" }, updatedAt: new Date().toISOString() }));
    if (mode === "nonzero") expect(message).toContain("Codex Exec exited with code 7: [REDACTED]");
    else expect(message).toContain("turn.completed または thread ID が取得できませんでした");
    expect(message).not.toContain("private-stderr");
    const result = JSON.parse(await readFile(observed, "utf8"));
    expect(result.input.trim()).toBe("process-probe");
    expect(result.code).toBe(mode === "nonzero" ? 7 : 0);
  });
});
