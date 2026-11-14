import { testStateSchema as stateSchema } from "./helpers/issue-state.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { z } from "zod";
import { afterEach, describe, expect, it } from "bun:test";
import { runStructured } from "../src/codex.js";
import { RunStore, newRunId } from "../src/state.js";
import { mkdir, readdir } from "node:fs/promises";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("実SDKと外部CLIの終了処理（Node.js製のテスト用CLI）", () => {
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
