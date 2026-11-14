import { testStateSchema as stateSchema } from "./helpers/issue-state.js";
import { WorkflowControl } from "./helpers/control.js";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, jest } from "bun:test";
import { runGit } from "../src/git.js";
import { RunStore, StorageError, newRunId, OutputCapture } from "../src/state.js";
import { WorkflowError, WorkflowStopped } from "../src/workflow.js";
import { type Implementation, type Plan } from "../src/schemas.js";
import { applyValidationUpdates, verifyImplementation } from "../src/verification.js";
import { CodexPhases, type PhaseConnection } from "../src/codex.js";
import { executeCli } from "../src/cli.js";

const originalEnv = { ...process.env };
const dirs: string[] = [];
afterEach(async () => { jest.restoreAllMocks(); process.env = { ...originalEnv }; await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const definition = { id: "test", kind: "test" as const, command: "bun check.cjs", workingDirectory: ".", executionMethod: "現在の開発コンテナで専用worktree内のコードを実行", evidence: "check.cjs", required: true };
const plan: Plan = { summary: "計画", steps: [], validationPlan: [definition], undetectedValidation: ["型チェックのコマンド未検出"], blockers: [] };
const implementation: Implementation = { summary: "実装", validation: [{ command: definition.command, status: "passed", details: "自己申告" }], validationPlanUpdates: [], remainingIssues: [], blockers: [] };
const issue = { id: "65", title: "検証用Issue", body: "要件と完了条件" };
const context = { issue: issue, repositoryInstructions: ["検証はコンテナ内"] };

async function setup(customPlan = plan, customImplementation = implementation) {
  const dir = await mkdtemp(join(tmpdir(), "harness-verification-")); dirs.push(dir);
  const store = new RunStore(newRunId(), dir, ["saved-secret"]);
  const source = join(dir, "source"); await mkdir(source);
  await runGit(source, ["init", "-b", "main"]);
  await writeFile(join(source, "check.cjs"), 'console.log(require("fs").readFileSync("value.txt", "utf8")); console.error("saved-secret"); process.exit(7);');
  await writeFile(join(source, "value.txt"), "base");
  await runGit(source, ["add", "."]);
  await runGit(source, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  const baseCommit = (await runGit(source, ["rev-parse", "HEAD"])).trim();
  await mkdir(join(dir, "worktrees"));
  await runGit(source, ["worktree", "add", "-b", "feature/test", store.worktreePath]);
  await writeFile(join(store.worktreePath, "value.txt"), "worktree saved-secret");
  const state = stateSchema.parse({ schemaVersion: 2, runId: store.runId, issueId: issue.id,
    repositoryId: "github.com/test/repo", repositoryPath: source, branchName: "feature/test", worktreePath: store.worktreePath,
    baseCommit, phase: "implementation", status: "running", phaseStatus: "succeeded", fixCount: 0, retryCount: {}, verificationArtifact: null,
    codexThreadId: "implementation-thread", reviewThreadIds: [], resultCommits: [], reviewedTreeId: null, error: null, updatedAt: new Date().toISOString() });
  await store.createGitHub(state); await store.savePlan(customPlan); await store.saveArtifact("issue-input", context);
  await store.saveArtifact("implementation", customImplementation, 1);
  return { store, control: new WorkflowControl(store, state), source };
}

describe("検証コマンド更新", () => {
  it("追加・更新・削除の順序と根拠を保持、必須確認の削除もReview用履歴に残す", () => {
    const changed = { ...definition, command: "bun check.cjs --new", required: false };
    const added = { ...definition, id: "build", kind: "build" as const };
    const first = { ...implementation, validationPlanUpdates: [{ operation: "update" as const, definition: changed, reason: "オプション変更" }, { operation: "add" as const, definition: added, reason: "検出漏れ" }] };
    const fix = { ...implementation, validationPlanUpdates: [{ operation: "remove" as const, id: changed.id, reason: "削除理由" }] };
    expect(applyValidationUpdates(plan, [first, fix])).toMatchObject({ validationPlan: [added], validationPlanUpdates: [...first.validationPlanUpdates, ...fix.validationPlanUpdates], undetectedValidation: plan.undetectedValidation });
  });
  it("prepare-imageをIDで削除・再登録し、仮の定義なしで実際の削除前定義を保存", () => {
    const original = { ...definition, id: "prepare-image", kind: "prepare" as const, command: "docker compose build", workingDirectory: "/old/worktree" };
    const replacement = { ...original, workingDirectory: "." };
    const result = applyValidationUpdates({ ...plan, validationPlan: [original, definition] }, [{ ...implementation, validationPlanUpdates: [
      { operation: "remove", id: original.id, reason: "実行順とcwd変更" },
      { operation: "add", definition: replacement, reason: "必須準備を再登録" },
    ] }]);
    expect(result.validationPlan).toEqual([definition, replacement]);
    expect(result.validationHistory).toEqual([
      { operation: "remove", id: original.id, reason: "実行順とcwd変更", before: original, after: null },
      { operation: "add", id: original.id, reason: "必須準備を再登録", before: null, after: replacement },
    ]);
  });
  it("未知IDは位置と対象を診断し、途中の成功を元計画へ反映しない", () => {
    const original = structuredClone(plan);
    expect(() => applyValidationUpdates(plan, [{ ...implementation, validationPlanUpdates: [
      { operation: "remove", id: definition.id, reason: "削除" },
      { operation: "update", definition: { ...definition, id: "unknown" }, reason: "誤更新" },
    ] }])).toThrow("validationPlanUpdates[1] update ID=unknown: 対象IDが登録されていない");
    expect(plan).toEqual(original);
    expect(applyValidationUpdates(plan, []).validationPlan).toEqual([definition]);
  });
  it("弱体化したupdateの前後を履歴に残す", () => {
    const changed = { ...definition, required: false };
    expect(applyValidationUpdates(plan, [{ ...implementation, validationPlanUpdates: [
      { operation: "update", definition: changed, reason: "Reviewで確認" },
    ] }]).validationHistory[0]).toMatchObject({ before: definition, after: changed, reason: "Reviewで確認" });
  });
  it.each(["add", "update", "remove"] as const)("%sの対象不整合を拒否", operation => {
    const d = operation === "add" ? definition : { ...definition, id: "unknown" };
    const update = operation === "remove"
      ? { operation, id: d.id, reason: "理由" }
      : { operation, definition: d, reason: "理由" };
    expect(() => applyValidationUpdates(plan, [{ ...implementation, validationPlanUpdates: [update] }])).toThrow();
  });
  it("重複IDを拒否", () => {
    expect(() => applyValidationUpdates({ ...plan, validationPlan: [definition, definition] }, [])).toThrow();
  });
});

describe("コンテナ内の実Git worktree・実コマンド・実保存", () => {
  jest.setTimeout(15_000);
  it("自己申告を使わず対象worktreeを実行し、非ゼロ・stderr・秘密除外・差分を保存", async () => {
    const f = await setup(); const saved = await verifyImplementation(f.control);
    expect(saved.input.verification.commands[0]).toMatchObject({ status: "failed", exitCode: 7, stdout: { text: "worktree [REDACTED]\n" }, stderr: { text: "[REDACTED]\n" } });
    expect(saved.diff).toContain("+worktree [REDACTED]");
    expect(saved.input.verification.commands[0]!.startedAt).not.toBeNull();
    expect(await f.store.loadReviewInput(1)).toEqual(saved);
    expect(await f.store.loadGitHubState()).toMatchObject({ phase: "verification", phaseStatus: "succeeded", verificationArtifact: "verification-1.json", retryCount: {} });
    expect(await readFile(join(f.store.artifactsPath, "verification-1.command-0.json"), "utf8")).not.toContain("saved-secret");
    expect(await readFile(join(f.source, "value.txt"), "utf8")).toBe("base");
  });
  it("大量出力・分割UTF-8・分割秘密値をマスキングし、省略をReviewへ渡す", async () => {
    const f = await setup();
    await writeFile(join(f.store.worktreePath, "check.cjs"), 'process.stdout.write(Buffer.from([0xe3])); process.stdout.write(Buffer.from([0x81,0x82])); process.stdout.write("saved-"); process.stdout.write("secret"); process.stdout.write("x".repeat(2000000)); process.stderr.write("Bearer fake-token");');
    const { input } = await verifyImplementation(f.control);
    expect(input.verification.commands[0]).toMatchObject({ status: "passed", exitCode: 0, stdout: { truncated: true }, stderr: { text: "Bearer [REDACTED]" } });
    expect(input.verification.commands[0]!.stdout.text).toHaveLength(65536);
    expect(input.verification.commands[0]!.stdout.text).toMatch(/^あ\[REDACTED\]/);
    expect(input.verification.commands[0]!.stdout.omittedReason).toContain("未確認");
    expect(await readFile(join(f.store.artifactsPath, "verification-1.stdout.log"), "utf8")).toContain("[出力省略]");
  });
  it("パス脱出・symlink脱出・存在しない実行場所を未実施として渡す", async () => {
    const definitions = ["../source", "/tmp", "escape", "missing"].map((workingDirectory, index) => ({ ...definition, id: `skip-${index}`, workingDirectory }));
    const f = await setup({ ...plan, validationPlan: definitions });
    await symlink(f.source, join(f.store.worktreePath, "escape"));
    const result = await verifyImplementation(f.control);
    expect(result.input.verification.commands.every(c => c.status === "skipped" && !!c.skippedReason && c.exitCode === null)).toBe(true);
    expect(result.input.verification.undetectedValidation).toEqual(plan.undetectedValidation);
    expect(f.control.snapshot().phaseStatus).toBe("succeeded");
  });
  it("検出コマンドなしでも未検出事項をReviewへ渡す", async () => {
    const f = await setup({ ...plan, validationPlan: [] });
    expect((await verifyImplementation(f.control)).input.verification).toMatchObject({ commands: [], undetectedValidation: plan.undetectedValidation });
  });
  it("コマンドがコードを書き換えたら結果確定せず安全停止し、途中結果・変更を保持", async () => {
    const f = await setup(); await writeFile(join(f.store.worktreePath, "check.cjs"), 'require("fs").writeFileSync("value.txt", "changed");');
    await expect(verifyImplementation(f.control)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.control.snapshot()).toMatchObject({ status: "stopped", retryCount: {} });
    expect(await readFile(join(f.store.worktreePath, "value.txt"), "utf8")).toBe("changed");
    expect(await readFile(join(f.store.artifactsPath, "verification-1.command-0.json"), "utf8")).toContain('"passed"');
    await expect(f.store.loadReviewInput(1)).rejects.toBeInstanceOf(StorageError);
  });
  it.each(["saveVerification", "saveReviewInput", "saveVerificationCommand"] as const)("%sの保存失敗で安全停止し、再実行しない", async method => {
    const f = await setup(); const spy = jest.spyOn(f.store, method).mockRejectedValue(new StorageError("io"));
    await expect(verifyImplementation(f.control)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(spy).toHaveBeenCalledTimes(1); expect(f.control.snapshot()).toMatchObject({ status: "stopped", retryCount: {} });
  });
  it("signal終了は不確実な技術障害として停止", async () => {
    const f = await setup(); await writeFile(join(f.store.worktreePath, "check.cjs"), 'process.kill(process.ppid, "SIGTERM");');
    await expect(verifyImplementation(f.control)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(f.control.snapshot()).toMatchObject({ status: "stopped", error: { classification: "uncertain" }, retryCount: {} });
  });
  it("worktree履歴不整合とフェーズ再実行を拒否", async () => {
    const f = await setup(); await runGit(f.store.worktreePath, ["switch", "-c", "other"]);
    await expect(verifyImplementation(f.control)).rejects.toBeInstanceOf(WorkflowStopped);
    const g = await setup(); await verifyImplementation(g.control);
    await expect(verifyImplementation(g.control)).rejects.toBeInstanceOf(WorkflowStopped);
  });
  it("T3/T20: 失敗・未実施・未検出を独立Review、指摘後のみFix、更新コマンドで再検証し新規Review", async () => {
    const skip = { ...definition, id: "restricted", workingDirectory: "missing" };
    const f = await setup({ ...plan, validationPlan: [definition, skip] });
    const prompts: string[] = []; let threads = 0;
    const responses = [
      { summary: "レビュー", findings: [{ severity: "major", description: "test失敗と必須確認未実施を修正", validationCommandIds: ["test"], location: "check.cjs:1" }], unverifiedItems: [], blockers: [] },
      { ...implementation, validationPlanUpdates: [{ operation: "remove", id: skip.id, reason: "重複確認を削除" }, { operation: "update", definition: { ...definition, command: "bun check.cjs --fixed" }, reason: "Fix後の検証" }] },
      { summary: "再レビュー", findings: [], unverifiedItems: [], blockers: [] },
    ];
    const thread = (id: string, initial: string | null) => {
      const result = { id: initial, runStreamed: async (prompt: string) => {
      prompts.push(prompt); const response = responses.shift();
      return { events: (async function* () {
        result.id = id;
        yield { type: "thread.started" as const, thread_id: id };
        if (prompts.length === 2) await writeFile(join(f.store.worktreePath, "check.cjs"), 'console.log("fixed-worktree");');
        yield { type: "item.completed" as const, item: { id: "answer", type: "agent_message" as const, text: JSON.stringify(response) } };
        yield { type: "turn.completed" as const, usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
      })() };
      } };
      return result;
    };
    const connection: PhaseConnection = { start: jest.fn(() => thread(`review-${++threads}`, null)), resume: jest.fn(id => thread(id, id)) };
    const mcp = { callJson: jest.fn() };
    const phases = new CodexPhases({ control: f.control, connection });
    await verifyImplementation(f.control);
    expect(connection.resume).not.toHaveBeenCalled();
    await phases.review(1);
    expect(prompts[0]).toContain('"exitCode":7'); expect(prompts[0]).toContain('"status":"skipped"'); expect(prompts[0]).toContain("型チェックのコマンド未検出");
    await phases.fix(1);
    expect(connection.resume).toHaveBeenCalledWith("implementation-thread");
    const fixed = await verifyImplementation(f.control);
    expect(fixed.input.verification.commands[0]).toMatchObject({ status: "passed", stdout: { text: "fixed-worktree\n" } });
    await phases.review(2);
    expect(prompts[2]).toContain("fixed-worktree"); expect(prompts[2]).toContain("重複確認を削除");
    expect(f.control.snapshot()).toMatchObject({ reviewThreadIds: ["review-1", "review-2"], fixCount: 1, retryCount: {}, verificationArtifact: "verification-2.json" });
    expect((await f.store.loadArtifact("verification", 1)).commands[0]!.status).toBe("failed");
    expect(mcp.callJson).not.toHaveBeenCalled();
  });
  it("コマンド単位の途中成果もstatusで破損を検出", async () => {
    const f = await setup(); await verifyImplementation(f.control);
    expect((await f.store.loadVerificationCommand(1, 0)).exitCode).toBe(7);
    await writeFile(join(f.store.artifactsPath, "verification-1.command-0.json"), "broken");
    let output = "";
    expect(await executeCli(["status", f.store.runId], { root: f.store.root, stdout: text => { output += text; } })).toBe(0);
    expect(output).toContain("成果物が破損・未確定: verification-1.command-0.json");
  });
  it("検証後のコード変更はSDK呼び出し前に停止", async () => {
    const f = await setup(); await verifyImplementation(f.control);
    await writeFile(join(f.store.worktreePath, "value.txt"), "検証後の変更");
    const connection = { start: jest.fn(), resume: jest.fn() };
    const phases = new CodexPhases({ control: f.control, connection });
    await expect(phases.review(1)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(connection.start).not.toHaveBeenCalled();
    expect(f.control.snapshot().error?.classification).toBe("uncertain");
  });
  it("検証実行中のCodex開始と検証の並行再実行を拒否", async () => {
    const f = await setup(); await f.control.recordPhase("verification", "running");
    const connection = { start: jest.fn(), resume: jest.fn() };
    const phases = new CodexPhases({ control: f.control, connection });
    await expect(phases.implementation(context)).rejects.toBeInstanceOf(WorkflowStopped);
    expect(connection.resume).not.toHaveBeenCalled();
    const g = await setup(); await g.control.recordPhase("verification", "running");
    await expect(verifyImplementation(g.control)).rejects.toBeInstanceOf(WorkflowStopped);
  });
  it("同時に呼び出された検証も、成果物読み取りの前に重複開始を拒否", async () => {
    const f = await setup();
    const results = await Promise.allSettled([verifyImplementation(f.control), verifyImplementation(f.control)]);
    expect(results.every(result => result.status === "rejected" && result.reason instanceof WorkflowStopped)).toBe(true);
    expect(f.control.snapshot()).toMatchObject({ status: "stopped", retryCount: {} });
    await expect(f.store.loadVerificationCommand(1, 0)).rejects.toBeInstanceOf(StorageError);
  });
  it("準備成功後に検証を実行し、環境変数に秘密を継承しない", async () => {
    const preparation = { ...definition, id: "install", kind: "prepare" as const, command: "mkdir -p node_modules && printf ready > node_modules/ready" };
    const check = { ...definition, command: "test -f node_modules/ready && test -z \"$HARNESS_TEST_SECRET_TOKEN\" && pwd" };
    const f = await setup({ ...plan, validationPlan: [preparation, check] });
    await writeFile(join(f.store.worktreePath, ".gitignore"), "node_modules/\n");
    process.env.HARNESS_TEST_SECRET_TOKEN = "do-not-inherit";
    const { input } = await verifyImplementation(f.control);
    expect(input.verification.commands.map(c => [c.definition.kind, c.outcome])).toEqual([["prepare", "passed"], ["test", "passed"]]);
    expect(input.verification.commands[1]!.stdout.text.trim()).toBe(f.store.worktreePath);
  });
  it("準備失敗は検証失敗と区別し、後続未実施をReview入力へ保存する", async () => {
    const preparation = { ...definition, id: "install", kind: "prepare" as const, command: "echo preparation-error >&2; exit 9" };
    const f = await setup({ ...plan, validationPlan: [preparation, definition] });
    const { input } = await verifyImplementation(f.control);
    expect(input.verification.commands[0]).toMatchObject({ status: "failed", outcome: "preparation_failed", exitCode: 9 });
    expect(input.verification.commands[1]).toMatchObject({ status: "skipped", outcome: "not_run", exitCode: null });
    expect(input.verification.commands[1]!.skippedReason).toContain("install");
    expect(await f.store.loadReviewInput(1)).toMatchObject({ input });
  });
  it("複合コマンドの途中失敗を後続成功で隠さず、実際のshオプションと終了コードを保存", async () => {
    const preparation = { ...definition, id: "environment", kind: "prepare" as const,
      command: "sh -c 'echo environment-error >&2; exit 9'; printf hidden-success" };
    const f = await setup({ ...plan, validationPlan: [preparation, definition] });
    const { input } = await verifyImplementation(f.control);
    expect(input.verification.commands[0]).toMatchObject({ status: "failed", outcome: "preparation_failed", exitCode: 9,
      stdout: { text: "" }, stderr: { text: "environment-error\n" }, execution: { program: "/bin/sh", args: ["-ec", preparation.command] } });
    expect(input.verification.commands[1]).toMatchObject({ status: "skipped", outcome: "not_run" });
  });
  it("準備の不正cwdでも後続を起動せず、未実施理由を保存する", async () => {
    const preparation = { ...definition, id: "install", kind: "prepare" as const, workingDirectory: "missing" };
    const f = await setup({ ...plan, validationPlan: [preparation, definition] });
    const { input } = await verifyImplementation(f.control);
    expect(input.verification.commands.map(c => c.status)).toEqual(["skipped", "skipped"]);
    expect(input.verification.commands[1]!.execution).toBeNull();
    expect(input.verification.commands[1]!.skippedReason).toContain("準備未実施: 手順 install");
  });
  it("権限不足を記録し後続を実行せず、昇格・再試行せず安全停止", async () => {
    const denied = { ...definition, id: "docker-start", kind: "prepare" as const, command: "echo 'permission denied: /var/run/docker.sock' >&2; exit 1" };
    const f = await setup({ ...plan, validationPlan: [denied, definition] });
    await expect(verifyImplementation(f.control)).rejects.toBeInstanceOf(WorkflowStopped);
    const { input } = await f.store.loadReviewInput(1);
    expect(input.verification.commands[0]).toMatchObject({ outcome: "permission_denied", exitCode: 1, stderr: { text: "permission denied: /var/run/docker.sock\n" } });
    expect(input.verification.commands[1]).toMatchObject({ status: "skipped", exitCode: null });
    expect(f.control.snapshot()).toMatchObject({ status: "stopped", retryCount: {}, error: { message: expect.stringContaining("docker-start") } });
  });
  it.each([false, true])("発見したコンテナ手順とworktree確認ガードを実行（不一致=%s、Docker代役）", async mismatch => {
    const detected = { ...definition, command: 'test "$(docker inspect run-container)" = "$PWD" && docker exec run-container bun check.cjs',
      executionMethod: "inspectで対象runのworktreeを確認してからexecする" };
    const changed = { ...implementation, validationPlanUpdates: [{ operation: "update" as const, definition: detected, reason: "対象runのマウント確認付きコンテナ手順" }] };
    const f = await setup(plan, changed);
    const bin = join(f.store.root, "bin"); await mkdir(bin);
    // Dockerを事前設定せずPlanの手順をそのまま実行。CLIのみ代役で実sh・実Bunを使用する。
    await writeFile(join(bin, "docker"), `#!${process.execPath}\nconst {spawnSync}=require("node:child_process");
      if(process.argv[2]==="inspect") console.log(${JSON.stringify(mismatch ? f.source : f.store.worktreePath)});
      else { const r=spawnSync("bun",["check.cjs"],{cwd:process.cwd(),stdio:"inherit"}); process.exit(r.status ?? 1); }
    `);
    await chmod(join(bin, "docker"), 0o700);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const { input } = await verifyImplementation(f.control);
    expect(input.verification.commands[0]).toMatchObject({ status: "failed", outcome: "verification_failed", exitCode: mismatch ? 1 : 7 });
    expect(input.verification.commands[0]!.stdout.text).toBe(mismatch ? "" : "worktree [REDACTED]\n");
    expect(input.verification.validationPlanUpdates[0]).toMatchObject({ definition: { command: detected.command } });
  });
});

it("上限をまたぐ秘密値と未完の秘密鍵を保存しない", () => {
  const capture = new OutputCapture(["secret".repeat(2000)]);
  capture.append("x".repeat(65530)); capture.append("secret".repeat(2000)); capture.append("z".repeat(100000));
  expect(capture.finish().text.slice(65530)).toBe("[REDAC");
  expect(capture.finish().truncated).toBe(true);
  const key = new OutputCapture([]); key.append("-----BEGIN RSA PRIVATE KEY-----" + "s".repeat(200000));
  expect(key.finish()).toMatchObject({ text: "[REDACTED PRIVATE KEY]", truncated: true });
});
