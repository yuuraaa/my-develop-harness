import { issueState } from "./helpers/issue-state.js";
import { testStateSchema as stateSchema } from "./helpers/issue-state.js";
import { mkdtemp, readFile, writeFile, rm, mkdir, stat, readdir, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "bun:test";
import { RunStore, newRunId, StorageError, diffId, redact, planMarkdown, captureReviewDiff, boundedOutput, environmentSecrets } from "../src/state.js";
import { implementationSchema, planSchema, reviewSchema, verificationSchema } from "../src/schemas.js";
import type { Plan, RunState, Verification, Implementation, IssueInput } from "../src/schemas.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function temp() { const p = await mkdtemp(join(tmpdir(), "harness-test-")); roots.push(p); return p; }
const sha = "a".repeat(40);
const now = "2026-10-14T03:00:00.000Z";
const plan: Plan = { summary: "方針\n```", steps: ["実装", "確認"], validationPlan: [{ id: "test", kind: "test", command: "docker compose exec dev npm test", workingDirectory: ".", executionMethod: "対象worktreeをmount", evidence: "README", required: true }], undetectedValidation: ["ブラウザ検証なし"], blockers: [] };
const implementation: Implementation = { summary: "追加", validation: [{ command: "npm test", status: "passed", details: "参考結果" }], validationPlanUpdates: [{ operation: "remove", id: plan.validationPlan[0]!.id, reason: "履歴" }], remainingIssues: [], blockers: [] };
const context: IssueInput = { issue: { id: "56", description: "要件", acceptanceCriteria: "条件", comments: [] }, repositoryInstructions: ["コンテナ内実行"] };
function state(store: RunStore): RunState { return issueState({ schemaVersion: 2, runId: store.runId, issueId: "56", repositoryId: "owner/repo", repositoryPath: "/repo", branchName: "feature/test", worktreePath: store.worktreePath, baseCommit: sha, phase: "plan", status: "running", phaseStatus: "pending", fixCount: 0, retryCount: {}, verificationArtifact: null, codexThreadId: null, reviewThreadIds: [], resultCommits: [], reviewedTreeId: null, error: null, updatedAt: now }); }
function verification(diff: string, attempt = 1): Verification { return { source: "harness", attempt, worktreePath: "/worktree", baseCommit: sha, diffId: createHash("sha256").update(diff).digest("hex"), commands: [{ definition: plan.validationPlan[0]!, startedAt: now, endedAt: now, exitCode: 0, status: "passed", skippedReason: null, stdout: { text: "ok", truncated: false, omittedReason: null }, stderr: { text: "", truncated: false, omittedReason: null } }], validationPlan: plan.validationPlan, validationPlanUpdates: implementation.validationPlanUpdates, undetectedValidation: plan.undetectedValidation }; }
async function setup(secrets: string[] = []) { const store = new RunStore(newRunId(), await temp(), secrets); await store.createGitHub(state(store)); return store; }

describe("構造化スキーマ", () => {
  it("フェーズ出力を検証し、削除履歴と未検出事項を保持する", () => {
    expect(planSchema.parse(plan)).toEqual(plan);
    expect(implementationSchema.parse(implementation)).toEqual(implementation);
    expect(reviewSchema.parse({ summary: "指摘", findings: [{ severity: "major", description: "テスト漏れ", validationCommandIds: [], location: null }], unverifiedItems: ["未確認"], blockers: [] }).findings).toHaveLength(1);
    expect(() => planSchema.parse({ ...plan, status: "ok" })).toThrow();
    expect(() => reviewSchema.parse({ summary: "ok", findings: [{ severity: "unknown" }], unverifiedItems: [], blockers: [] })).toThrow();
  });
  it("検証の自己申告・終了コード矛盾・未実施理由欠落を拒否する", () => {
    const v = verification("");
    expect(() => verificationSchema.parse({ ...v, source: "codex" })).toThrow();
    expect(() => verificationSchema.parse({ ...v, commands: [{ ...v.commands[0], exitCode: 1 }] })).toThrow();
    expect(() => verificationSchema.parse({ ...v, commands: [{ ...v.commands[0], status: "skipped", exitCode: null }] })).toThrow();
    expect(verificationSchema.parse({ ...v, commands: [{ ...v.commands[0], status: "skipped", exitCode: null, skippedReason: "権限なし" }] }).commands[0]?.skippedReason).toBe("権限なし");
  });
  it("状態のバージョン・回数と報告の必須フィールドを検証する", async () => {
    const store = await setup();
    expect(() => stateSchema.parse({ ...state(store), schemaVersion: 99 })).toThrow();
    expect(() => stateSchema.parse({ ...state(store), fixCount: 4 })).toThrow();
  });
});
describe("実ファイルの保存", () => {
  it("更新再提出記録は秘密を除外して試行別に保存し、上書きと番号不整合を拒否", async () => {
    const store = await setup(["saved-secret"]);
    const submission = { phase: "fix" as const, attempt: 2, submission: 1, candidate: { validationPlanUpdates: [], summary: "saved-secret" }, error: "unknown ID", accepted: false };
    const saved = await store.saveValidationSubmission(submission);
    expect(JSON.stringify(saved)).not.toContain("saved-secret");
    expect(await store.loadValidationSubmissions()).toEqual([saved]);
    await expect(store.saveValidationSubmission(submission)).rejects.toMatchObject({ kind: "exists" });
    await writeFile(join(store.artifactsPath, "validation-submission-2-1.json"), JSON.stringify({ ...saved, attempt: 3 }));
    await expect(store.loadValidationSubmissions()).rejects.toMatchObject({ kind: "corrupt" });
  });
  it("構造化参照と自由記述locationをそのまま保存・読込する", async () => {
    const store = await setup();
    const review = { summary: "指摘", findings: [{ severity: "major" as const, description: "共通原因",
      validationCommandIds: ["node-tests", "bun-tests"], location: "tests/a.ts:54; src/cli.ts:119" }], unverifiedItems: [], blockers: [] };
    await store.saveArtifact("review", review, 1);
    expect(await store.loadArtifact("review", 1)).toEqual(review);
    expect(() => reviewSchema.parse({ ...review, findings: [{ ...review.findings[0], validationCommandIds: null }] })).toThrow();
  });
  it("run IDと配置・権限・状態の置換・イベントを確認する", async () => {
    const store = await setup();
    expect(newRunId()).not.toBe(store.runId);
    expect(() => new RunStore("../bad")).toThrow(StorageError);
    await expect(store.createGitHub(state(store))).rejects.toMatchObject({ kind: "exists" });
    const next = { ...state(store), phase: "review" as const, codexThreadId: "thread-1", reviewThreadIds: ["review-1"], fixCount: 1, retryCount: { mcp: 2 } };
    await store.saveGitHubState(next);
    expect(await store.loadGitHubState()).toEqual(next);
    expect((await stat(join(store.runPath, "state.json"))).mode & 0o777).toBe(0o600);
    expect((await readdir(store.runPath)).some(p => p.endsWith(".tmp"))).toBe(false);
    const event = { timestamp: now, type: "phase.started", phase: "review" as const, data: { attempt: 1 } };
    await store.appendEvent(event); await store.appendEvent({ ...event, type: "phase.finished" });
    expect(await store.loadEvents()).toEqual([event, { ...event, type: "phase.finished" }]);
  });
  it("状態・成果物の不正JSONとスキーマ不一致を検出する", async () => {
    const store = await setup();
    await writeFile(join(store.runPath, "state.json"), "{");
    await expect(store.loadGitHubState()).rejects.toMatchObject({ kind: "corrupt" });
    await writeFile(join(store.runPath, "state.json"), JSON.stringify({ ...state(store), schemaVersion: 99 }));
    await expect(store.loadGitHubState()).rejects.toMatchObject({ kind: "corrupt" });
    await expect(store.saveGitHubState({ ...state(store), fixCount: 8 })).rejects.toMatchObject({ kind: "schema" });
  });
  it("一時ファイルを確定成果と読まず、途中行に追記しない", async () => {
    const store = await setup();
    await writeFile(join(store.artifactsPath, "review-1.json.tmp"), "{}");
    await expect(store.loadArtifact("review", 1)).rejects.toMatchObject({ kind: "io" });
    await writeFile(join(store.runPath, "events.jsonl"), '{"timestamp":');
    await expect(store.loadEvents()).rejects.toMatchObject({ kind: "incomplete" });
    await expect(store.appendEvent({ timestamp: now, type: "test", phase: "plan", data: {} })).rejects.toMatchObject({ kind: "incomplete" });
    await writeFile(join(store.runPath, "events.jsonl"), "{}\n");
    await expect(store.loadEvents()).rejects.toMatchObject({ kind: "corrupt" });
  });
  it("保存失敗で既存状態を保持し、未確定bundleを異常扱いする", async () => {
    const store = await setup();
    await mkdir(join(store.artifactsPath, "plan.md"));
    await expect(store.savePlan(plan)).rejects.toMatchObject({ kind: "exists" });
    await expect(store.loadArtifact("plan")).rejects.toMatchObject({ kind: "incomplete" });
    const other = await setup();
    await rm(other.artifactsPath, { recursive: true });
    await expect(other.savePlan(plan)).rejects.toMatchObject({ kind: "io" });
    expect(JSON.parse(await readFile(join(other.runPath, "state.json"), "utf8"))).toEqual(state(other));
  });
  it("状態の置換失敗はIOエラーになり、以前の確定状態が残る", async () => {
    const store = await setup(); await chmod(store.runPath, 0o500);
    try {
      await expect(store.saveGitHubState({ ...state(store), phase: "review" })).rejects.toMatchObject({ kind: "io" });
      expect(await store.loadGitHubState()).toEqual(state(store));
    } finally { await chmod(store.runPath, 0o700); }
  });
  it("検証済みPlanだけからMarkdownを生成する", async () => {
    const store = await setup(); await store.savePlan(plan);
    const json = await store.loadArtifact("plan");
    expect(await readFile(join(store.artifactsPath, "plan.md"), "utf8")).toBe(planMarkdown(json));
    expect(planMarkdown(json)).toContain(JSON.stringify(plan.steps, null, 2));
    await expect(store.savePlan(plan)).rejects.toThrow();
    expect((await store.loadPlan()).plan).toEqual(plan);
    await writeFile(join(store.artifactsPath, "plan.md"), "different plan");
    await expect(store.loadPlan()).rejects.toMatchObject({ kind: "corrupt" });
  });
  it("Fix/Review履歴を上書きせず、1〜4回を別々に保存する", async () => {
    const store = await setup();
    for (let attempt = 1; attempt <= 4; attempt++) {
      await store.saveArtifact("implementation", { ...implementation, summary: `Fix ${attempt}` }, attempt);
      await store.saveArtifact("review", { summary: `Review ${attempt}`, findings: [], unverifiedItems: [], blockers: [] }, attempt);
    }
    await expect(store.saveArtifact("implementation", implementation, 1)).rejects.toMatchObject({ kind: "exists" });
    await expect(store.saveArtifact("review", { summary: "", findings: [], unverifiedItems: [], blockers: [] }, 5)).rejects.toMatchObject({ kind: "schema" });
    expect((await store.loadArtifact("implementation", 1)).summary).toBe("Fix 1");
    expect((await store.loadArtifact("review", 4)).summary).toBe("Review 4");
  });
  it.each(["https://user:credential@github.com/o/r", "ssh://git:credential@github.com/o/r",
    "SSH://credential@github.com/o/r", "https://credential@github.com/o/r"])("URLのuserinfoを保存しない: %s", url => {
    expect(redact(url)).not.toContain("credential");
    expect(redact(url)).toContain("[REDACTED]@github.com/o/r");
  });
  it("文脈・イベント・検証出力の秘密情報を記録しない", async () => {
    const secret = "opaque-sensitive-value";
    const store = await setup([secret]);
    await store.saveArtifact("issue-input", { ...context, issue: { token: "unknown-value", body: secret, authorization: "Bearer unknown-bearer" } });
    await store.appendEvent({ timestamp: now, type: "test", phase: "plan", data: { log: secret, password: "unknown" } });
    const v = verification(""); v.commands[0]!.stdout.text = `output ${secret} api_key=unknown-key`;
    await store.saveVerification(v);
    for (const file of await readdir(store.artifactsPath)) {
      const content = await readFile(join(store.artifactsPath, file), "utf8");
      expect(content).not.toContain(secret); expect(content).not.toContain("unknown-value"); expect(content).not.toContain("unknown-key");
    }
    expect((await store.loadEvents())[0]?.data.password).toBe("[REDACTED]");
    expect(redact("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).not.toContain("abc");
  });
  it("レビュー入力と差分・検証の一致を確認し、worktreeなしで読める", async () => {
    const store = await setup(); const diff = "diff --git a/file b/file\n+change\n";
    await store.saveVerification(verification(diff));
    const input = { attempt: 1, issueInput: context, plan, implementation, verification: verification(diff), baseCommit: sha, verificationArtifact: "verification-1.json" };
    const saved = await store.saveReviewInput(input, diff);
    expect(saved.input.diffId).toBe(createHash("sha256").update(diff).digest("hex"));
    expect(diffId(diff)).toBe(saved.input.diffId);
    expect(saved.diff).toBe(await readFile(join(store.artifactsPath, "review-1.diff"), "utf8"));
    expect(await store.loadReviewInput(1)).toEqual(saved);
    await mkdir(store.worktreePath, { recursive: true }); await rm(store.worktreePath, { recursive: true });
    expect((await store.loadReviewInput(1)).input.issueInput.issue.acceptanceCriteria).toBe("条件");
    await writeFile(join(store.artifactsPath, "review-1.diff"), "changed");
    await expect(store.loadReviewInput(1)).rejects.toMatchObject({ kind: "corrupt" });
  });
  it("違う差分・検証回のレビュー入力を保存しない", async () => {
    const store = await setup(); await store.saveVerification(verification("first"));
    const input = { attempt: 1, issueInput: context, plan, implementation, verification: verification("first"), baseCommit: sha, verificationArtifact: "verification-1.json" };
    await expect(store.saveReviewInput(input, "different")).rejects.toMatchObject({ kind: "schema" });
    await expect(store.saveReviewInput({ ...input, attempt: 2 }, "first")).rejects.toMatchObject({ kind: "schema" });
  });
  it("Reviewへ渡す秘密除外済みパッチと保存内容が一致する", async () => {
    const secret = "opaque-secret"; const store = await setup([secret]);
    const raw = `diff --git a/file b/file\n+${secret}\n`; const diff = redact(raw, [secret]);
    await store.saveVerification(verification(diff));
    const result = await store.saveReviewInput({ attempt: 1, issueInput: context, plan, implementation, verification: verification(diff), baseCommit: sha, verificationArtifact: "verification-1.json" }, raw);
    expect(result.diff).not.toContain(secret); expect(result.input.redactions[0]).toContain("未確認");
    expect(await store.loadReviewInput(1)).toEqual(result);
    // 検証JSONが有効な構造のまま書き換わっても対応関係を失わない。
    const changed = verification(diff); changed.commands[0]!.stdout.text = "tampered";
    await writeFile(join(store.artifactsPath, "verification-1.json"), JSON.stringify(changed));
    await expect(store.loadReviewInput(1)).rejects.toMatchObject({ kind: "corrupt" });
  });
  it("出力上限・省略理由・環境認証値の検出を確認する", async () => {
    expect(environmentSecrets({ PATH: "/bin", HARNESS_TEST_SECRET_TOKEN: "opaque-value", OPENAI_API_KEY: "api-value" })).toEqual(["opaque-value", "api-value"]);
    const output = boundedOutput("secret" + "x".repeat(70000), ["secret"]);
    expect(output.text.length).toBe(65536); expect(output.text).not.toContain("secret"); expect(output.truncated).toBe(true); expect(output.omittedReason).toContain("未確認");
    const store = await setup();
    await expect(store.appendEvent({ timestamp: now, type: "huge", phase: "plan", data: { log: "x".repeat(300000) } })).rejects.toMatchObject({ kind: "schema" });
    await expect(store.saveArtifact("verification", verification("", 2), 1)).rejects.toMatchObject({ kind: "schema" });
  });
});
describe("Git累積パッチ", () => {
  it("コミット・index・未ステージ・新規・削除を含み、認証ファイルと実indexを保護する", async () => {
    const repo = await temp(); const run = promisify(execFile);
    const git = async (...args: string[]) => (await run("git", args, { cwd: repo })).stdout;
    await git("init"); await git("config", "user.email", "test@example.invalid"); await git("config", "user.name", "Test");
    await writeFile(join(repo, "file.txt"), "base\n"); await writeFile(join(repo, "deleted.txt"), "delete\n");
    await git("add", "."); await git("commit", "-m", "base"); const base = (await git("rev-parse", "HEAD")).trim();
    await writeFile(join(repo, "file.txt"), "committed\n"); await git("add", "."); await git("commit", "-m", "change");
    await writeFile(join(repo, "file.txt"), "staged\n"); await git("add", "file.txt"); await writeFile(join(repo, "file.txt"), "unstaged\n");
    await writeFile(join(repo, "new file.txt"), "new\n"); await writeFile(join(repo, ".env"), "TOKEN=opaque-secret"); await rm(join(repo, "deleted.txt"));
    const before = await git("diff", "--cached");
    const result = await captureReviewDiff(repo, base, ["opaque-secret"]);
    expect(result.diff).toContain("-base"); expect(result.diff).toContain("+unstaged"); expect(result.diff).toContain("+new"); expect(result.diff).toContain("deleted file mode");
    expect(result.diff).not.toContain("opaque-secret"); expect(result.diff).not.toContain("diff --git a/.env"); expect(result.redactions).toHaveLength(1);
    expect(await git("diff", "--cached")).toBe(before);
    // 新規リポジトリへ保存パッチを適用し、最終内容を再現できる。
    const target = await temp(); await run("git", ["clone", repo, target]); await run("git", ["checkout", base], { cwd: target });
    const patch = join(await temp(), "review.diff"); await writeFile(patch, result.diff); await run("git", ["apply", patch], { cwd: target });
    expect(await readFile(join(target, "file.txt"), "utf8")).toBe("unstaged\n"); expect(await readFile(join(target, "new file.txt"), "utf8")).toBe("new\n");
    // baseにあったファイルをcommitで削除しても累積パッチに含む。
    await git("add", "deleted.txt"); await git("commit", "-m", "delete");
    await writeFile(join(repo, "binary.bin"), Buffer.from("\0opaque-secret"));
    const next = await captureReviewDiff(repo, base, ["opaque-secret"]);
    expect(next.diff).toContain("deleted file mode"); expect(next.diff).not.toContain("binary.bin");
    expect(next.redactions.some(v => v.includes("binary.bin"))).toBe(true);
  });
});
