import { afterEach, describe, expect, it, jest } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { retrospective, pageRetrospective, showLimits } from "../src/retrospective.js";
import { executeCli } from "../src/cli.js";
import { GitHubClient } from "../src/github.js";

const id = "00000000-0000-4000-8000-000000000001";
const roots: string[] = [];
afterEach(async () => { jest.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "retrospective-")); roots.push(root);
  const run = join(root, "runs", id), artifacts = join(run, "artifacts");
  await mkdir(artifacts, { recursive: true });
  const save = (name: string, value: unknown) => writeFile(join(artifacts, name), JSON.stringify(value));
  await writeFile(join(run, "state.json"), JSON.stringify({ runId: id, issueId: "94", status: "running", worktreePath: "/deleted" }));
  const event = (second: number, type: string, phase: string, data: Record<string, unknown> = {}) => ({ timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(), type, phase, data });
  const events = (items: unknown[]) => writeFile(join(run, "events.jsonl"), items.map(v => JSON.stringify(v)).join("\n") + "\n");
  return { root, run, artifacts, save, event, events };
}
const command = (id = "test", status = "passed") => ({ definition: { id, command: "bun test", kind: "test", required: true, workingDirectory: ".", executionMethod: "container", evidence: "docs" }, status, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:02.000Z", exitCode: status === "passed" ? 0 : 1, skippedReason: null, stdout: { text: "saved stdout", truncated: true, omittedReason: "保存上限" }, stderr: { text: "[REDACTED]", truncated: false, omittedReason: null }, execution: { program: "sh", args: ["-ec", "bun test"], workingDirectory: "/workspace" } });

describe("保存記録の振り返り", () => {
  it("停止時の再提出候補とコマンド開始前の削除履歴を読み取りだけで表示", async () => {
    const f = await fixture();
    const submission = { phase: "fix", attempt: 2, submission: 3, candidate: { validationPlanUpdates: [{ operation: "remove", id: "unknown", reason: "誤り" }] }, error: "ID=unknown: 対象IDが登録されていない", accepted: false };
    await f.save("validation-submission-2-3.json", submission);
    const history = { validationPlan: [], validationPlanUpdates: [], validationHistory: [{ operation: "remove", id: "prepare-image", reason: "実行順変更", before: command("prepare-image").definition, after: null }], undetectedValidation: [] };
    await f.save("validation-plan-2.json", history);
    const before = await readFile(join(f.artifacts, "validation-submission-2-3.json"), "utf8");
    const fix = await retrospective(f.root, id, { phase: "fix:1" });
    expect(fix).toContain("validation-submission-2-3.json");
    expect(fix).toContain("ID=unknown");
    expect(fix).toContain('"accepted": false');
    const verification = await retrospective(f.root, id, { phase: "verification:2" });
    expect(verification).toContain("コマンド開始前に確定した計画");
    expect(verification).toContain("prepare-image");
    expect(verification).toContain('"before"');
    expect(await readFile(join(f.artifacts, "validation-submission-2-3.json"), "utf8")).toBe(before);
  });
  it("検証進捗・通信再試行で工程開始を上書きせずReview/Fixを実行順に示す", async () => {
    const f = await fixture();
    await f.save("verification-1.json", { source: "harness", commands: [command(), command("typecheck", "failed"), command("build", "skipped")] });
    await f.save("review-1.json", { summary: "review", findings: [{ severity: "major", description: "問題A", location: "a.ts:1", validationCommandIds: ["test"] }] });
    await f.save("implementation-2.json", { summary: "修正B", validation: [{ status: "passed", command: "self", details: "自主" }] });
    await f.save("review-2.json", { findings: [], summary: "次のレビュー" });
    await f.events([
      f.event(0, "phase.running", "verification", { attempt: 1 }),
      f.event(2, "phase.running", "verification", { attempt: 1, commandIndex: 0, commandStatus: "started" }),
      f.event(3, "operation.retry", "verification", { operation: "transport", retryCount: 1 }),
      f.event(5, "phase.running", "verification", { attempt: 1, commandIndex: 0, commandStatus: "failed", commandId: "test" }),
      f.event(10, "phase.succeeded", "verification", { attempt: 1 }),
      f.event(11, "phase.running", "review", { attempt: 1 }), f.event(12, "phase.succeeded", "review", { attempt: 1 }),
      f.event(12, "review.assessed", "review", { attempt: 1, decision: "fix" }),
      f.event(13, "phase.running", "fix", { attempt: 1 }), f.event(14, "phase.succeeded", "fix", { attempt: 1 }),
      f.event(15, "phase.running", "review", { attempt: 2 }), f.event(16, "phase.succeeded", "review", { attempt: 2 }),
    ]);
    const text = await retrospective(f.root, id);
    expect(text).toContain("verification:1 succeeded 10.0秒");
    expect(text.match(/verification:1 succeeded/g)?.length).toBe(1);
    expect(text).toContain("成功=1 失敗=1 未実施=1");
    expect(text).toContain("保存判定: fix critical=0 major=1 minor=0");
    expect(text.indexOf("問題A")).toBeLessThan(text.indexOf("修正B"));
    expect(text.indexOf("修正B")).toBeLessThan(text.indexOf("review:2"));
    expect(text).toContain("再試行: transport"); expect(text).toContain("検証失敗: test");
    expect(text).toContain("runningは現在の稼働を保証しません");
  });
  it("Planの再生成回とSDK再試行を区別する", async () => {
    const f = await fixture();
    await f.events([
      f.event(0, "phase.running", "plan", { attempt: 1 }),
      f.event(1, "operation.retry", "plan", { operation: "codex.plan", retryCount: 1 }),
      f.event(2, "phase.running", "plan", { attempt: 1 }), f.event(3, "phase.succeeded", "plan", { attempt: 1 }),
      f.event(4, "phase.pending", "plan", { namingAttempt: 2 }), f.event(5, "phase.running", "plan", { attempt: 2 }), f.event(6, "phase.succeeded", "plan", { attempt: 2 }),
      f.event(10, "workflow.stopped", "report", { status: "stopped", message: "提出失敗" }),
    ]);
    const text = await retrospective(f.root, id);
    expect(text).toContain("plan:1 succeeded 3.0秒"); expect(text).toContain("plan:2 succeeded 1.0秒");
  });
  it("終了欠落・不正時刻を推測せず、JSONL破損後の読めるイベントと未確定成果物も示す", async () => {
    const f = await fixture();
    await writeFile(join(f.run, "events.jsonl"), JSON.stringify(f.event(2, "phase.running", "implementation")) + "\n{broken}\n" + JSON.stringify(f.event(3, "blocked.requested", "implementation", { blockedReason: "判断が必要" })));
    await writeFile(join(f.artifacts, "review-1.json"), "{broken"); await writeFile(join(f.artifacts, "plan.pending"), "pending");
    const text = await retrospective(f.root, id);
    expect(text).toContain("終了記録なし 所要時間不明"); expect(text).toContain("JSON破損"); expect(text).toContain("末尾未確定"); expect(text).toContain("判断が必要"); expect(text).toContain("plan.pending: 未確定");
  });
  it("不完全な形式の未知項目も全て表示し自主検証と正式検証を区別する", async () => {
    const f = await fixture(); await f.events([]);
    const plan = { summary: "方針", steps: ["手順"], validationPlan: [], undetectedValidation: ["未検出"], blockers: [], future: { full: "未知の保存値" } };
    await f.save("plan.json", plan); await f.save("plan-output-1.json", { plan, branchName: "feature/example" });
    const text = await retrospective(f.root, id, { phase: "plan" });
    for (const key of Object.keys(plan)) expect(text).toContain(`"${key}"`);
    expect(text).toContain("未知の保存値"); expect(text).toContain("plan-output-1.json");
    await f.save("implementation-2.json", { summary: "Fix全文", validation: [{ command: "self", status: "passed" }], validationPlanUpdates: [], remainingIssues: [], blockers: [], extra: "保持" });
    expect(await retrospective(f.root, id, { phase: "fix:1" })).toContain("エージェント自主検証");
    expect(await retrospective(f.root, id, { phase: "fix:1" })).toContain("Fix全文");
  });
  it("命名再試行後の正式Planを試行1に流用せず、各出力と採用判断を対応付ける", async () => {
    const f = await fixture();
    const first = { summary: "初回だけの方針", steps: ["初回手順"], blockers: [] };
    const second = { summary: "二回目だけの方針", steps: ["二回目手順"], blockers: [] };
    await f.save("plan-output-1.json", { plan: first, branchName: "INVALID" });
    await f.save("plan-decision-1.json", { accepted: false, reason: "命名不正", branchName: null });
    await f.save("plan-output-2.json", { plan: second, branchName: "feature/retry" });
    await f.save("plan-decision-2.json", { accepted: true, reason: null, branchName: "feature/retry" });
    await f.save("plan.json", second);
    await f.events([
      f.event(0, "phase.running", "plan", { attempt: 1 }), f.event(2, "phase.succeeded", "plan", { attempt: 1 }),
      f.event(3, "phase.pending", "plan", { namingAttempt: 2 }),
      f.event(4, "phase.running", "plan", { attempt: 2 }), f.event(7, "phase.succeeded", "plan", { attempt: 2 }),
    ]);
    const text = await retrospective(f.root, id);
    expect(text).toContain("正式採用Plan: plan:2（保存済み採用判断）");
    expect(text).toContain("不採用 / 出力: plan-output-1.json");
    expect(text).toContain("採用 / 出力: plan-output-2.json");
    const one = await retrospective(f.root, id, { phase: "plan:1" });
    expect(one).toContain("初回だけの方針"); expect(one).not.toContain("二回目だけの方針");
    expect(one).toContain("命名不正"); expect(one).toContain('"artifact": "plan-output-1.json"');
    const two = await retrospective(f.root, id, { phase: "plan:2" });
    expect(two).toContain("二回目だけの方針"); expect(two).not.toContain("初回だけの方針");
    expect(two).toContain('"accepted": true'); expect(two).toContain('"artifact": "plan-output-2.json"');
    const all = await retrospective(f.root, id, { phase: "plan" });
    expect(all).toContain("Plan全体（正式採用内容と各試行）"); expect(all).toContain("初回だけの方針"); expect(all).toContain("二回目だけの方針");
  });
  it("採用判断のない旧plan.jsonを試行1へ関連付けない", async () => {
    const f = await fixture(); await f.save("plan.json", { summary: "正式内容のみ" });
    await f.events([f.event(0, "phase.running", "plan", { attempt: 1 })]);
    expect(await retrospective(f.root, id)).toContain("正式採用Plan: 回数不明");
    const one = await retrospective(f.root, id, { phase: "plan:1" });
    expect(one).toContain("plan-output-1.json: 欠落・取得不能"); expect(one).not.toContain("正式内容のみ");
    expect(await retrospective(f.root, id, { phase: "plan" })).toContain("正式内容のみ");
  });
  it("検証詳細から本文を分離しIDでログと保存時の省略・マスキングを表示する", async () => {
    const f = await fixture(); await f.events([]); await f.save("verification-1.json", { source: "harness", commands: [command()] });
    const detail = await retrospective(f.root, id, { phase: "verification:1" });
    expect(detail).not.toContain("saved stdout"); expect(detail).toContain("2.0秒"); expect(detail).toContain("--log test"); expect(detail).toContain("ハーネスの正式検証");
    const log = await retrospective(f.root, id, { phase: "verification:1", log: "test" });
    expect(log).toContain("saved stdout"); expect(log).toContain("保存上限"); expect(log).toContain("[REDACTED]"); expect(log).toContain('"stderr"');
    await expect(retrospective(f.root, id, { log: "test" })).rejects.toThrow("--log");
    await expect(retrospective(f.root, id, { phase: "verification:1", log: "missing" })).rejects.toThrow("未保存");
  });
  it("最終結果欠落でもコマンド個別保存から部分結果を表示し最終結果と重複させない", async () => {
    const f = await fixture(); await f.events([]); await f.save("verification-1.command-0.json", command());
    expect(await retrospective(f.root, id)).toContain("成功=1 失敗=0 未実施=0（最終結果未保存・部分記録）");
    expect(await retrospective(f.root, id, { phase: "verification:1", log: "test" })).toContain("saved stdout");
    await f.save("verification-1.json", { commands: [command()] });
    expect(await retrospective(f.root, id)).toContain("成功=1 失敗=0 未実施=0");
    expect(await retrospective(f.root, id)).not.toContain("成功=2");
  });
  it.each(["missing", "corrupt", "unreadable", "malformed-commands"])("検証結果%sを確定した0件に補完しない", async mode => {
    const f = await fixture();
    await f.events([f.event(0, "phase.running", "verification", { attempt: 1 })]);
    if (mode === "corrupt") await writeFile(join(f.artifacts, "verification-1.json"), "{broken");
    if (mode === "unreadable") await f.save("verification-1.json", { commands: [command()] });
    if (mode === "malformed-commands") await f.save("verification-1.json", { commands: "not-an-array" });
    const text = await retrospective(f.root, id, {}, async path => {
      if (mode === "unreadable" && path.endsWith("verification-1.json")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return readFile(path, "utf8");
    });
    expect(text).toContain("成功・失敗・未実施の件数不明"); expect(text).not.toContain("成功=0 失敗=0 未実施=0");
  });
  it("保存済み空配列の0件と不正statusの取得不能件数を区別する", async () => {
    const f = await fixture(); await f.events([]);
    await f.save("verification-1.json", { commands: [] });
    expect(await retrospective(f.root, id)).toContain("成功=0 失敗=0 未実施=0");
    await f.save("verification-1.json", { commands: [command(), command("bad", "unknown"), null] });
    const text = await retrospective(f.root, id);
    expect(text).toContain("成功=1 失敗=0 未実施=0 取得不能=2");
    expect(text).toContain("成功・失敗・未実施の内訳は不明");
    expect(await retrospective(f.root, id, { phase: "verification:1" })).toContain("status不正・取得不能な結果2件");
  });
  it("途中保存の読取不能・破損も集計から消さず総件数不明を示す", async () => {
    const f = await fixture(); await f.events([]);
    await f.save("verification-1.command-0.json", command());
    await writeFile(join(f.artifacts, "verification-1.command-1.json"), "{broken");
    const text = await retrospective(f.root, id);
    expect(text).toContain("成功=1 失敗=0 未実施=0（最終結果未保存・部分記録） 取得不能=1");
    expect(text).toContain("総件数不明");
  });
  it("固定上限と詳細導線を示し、詳細では長文・全指摘を表示する", async () => {
    const f = await fixture(); await f.events([]);
    await f.save("review-1.json", { findings: Array.from({ length: 4 }, (_, i) => ({ severity: "minor", description: `${i}:` + "長".repeat(300) + "末尾", location: null })) });
    const text = await retrospective(f.root, id);
    expect(text).toContain("指摘1件省略"); expect(text).toContain("--phase review:1"); expect(text).not.toContain("末尾");
    const detail = await retrospective(f.root, id, { phase: "review:1" }); expect(detail).toContain("3:"); expect(detail).toContain("末尾");
    expect(showLimits).toEqual({ characters: 24000, phases: 40, events: 20, findings: 3, excerpt: 240 });
  });
  it("工程・出来事・全体の固定上限を守る", async () => {
    const f = await fixture();
    await f.events(Array.from({ length: 50 }, (_, i) => f.event(i, "phase.running", "review", { attempt: i + 1 })).concat(Array.from({ length: 30 }, (_, i) => f.event(50 + i, "operation.retry", "review", { operation: "x".repeat(2000), retryCount: 1 }))));
    const text = await retrospective(f.root, id);
    expect(text.length).toBeLessThanOrEqual(showLimits.characters + 1); expect(text).toContain("通常表示の文字数上限で省略");
  });
  it("記録外参照を拒否し欠落記録でも読める部分を表示する", async () => {
    const f = await fixture(); await symlink(join(f.root, "private.json"), join(f.artifacts, "plan.json"));
    await writeFile(join(f.root, "private.json"), '{"summary":"outside-secret"}');
    expect(await retrospective(f.root, id, { phase: "plan" })).not.toContain("outside-secret");
    await expect(retrospective(f.root, "../../escape")).rejects.toThrow("UUID");
    expect(await retrospective(f.root, "00000000-0000-4000-8000-000000000002")).toContain("欠落");
  });
  it("読取不能を一ファイルに限定して表示し、不正時刻を補完しない", async () => {
    const f = await fixture(); await f.save("plan.json", { summary: "unreadable" });
    await f.save("review-1.json", { summary: "readable", findings: [] });
    await f.events([f.event(10, "phase.running", "review", { attempt: 1 }), f.event(5, "phase.succeeded", "review", { attempt: 1 })]);
    const text = await retrospective(f.root, id, {}, async path => {
      if (path.endsWith("plan.json")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return readFile(path, "utf8");
    });
    expect(text).toContain("plan.json: 読取不能 (EACCES)");
    expect(text).toContain("review:1 succeeded 所要時間不明"); expect(text).not.toContain("unreadable");
  });
  it("複数Fix・全重大度・保存済み報告とcommitを全文表示する", async () => {
    const f = await fixture(); await f.events([]);
    for (let n = 1; n <= 3; n++) {
      await f.save(`implementation-${n + 1}.json`, { summary: `fix-${n}`, remainingIssues: [`issue-${n}`], blockers: [], validationPlanUpdates: [{ reason: "保存された理由" }] });
      expect(await retrospective(f.root, id, { phase: `fix:${n}` })).toContain(`issue-${n}`);
    }
    await f.save("review-1.json", { findings: ["critical", "major", "minor"].map(severity => ({ severity, description: severity, location: "file:1", validationCommandIds: ["test"] })), unverifiedItems: ["未確認"], blockers: [] });
    expect(await retrospective(f.root, id)).toContain("critical=1 major=1 minor=1");
    const review = await retrospective(f.root, id, { phase: "review:1" }); expect(review).toContain("file:1"); expect(review).toContain("validationCommandIds"); expect(review).toContain("未確認");
    await f.save("commit.json", { summary: "保存commit", commitHashes: ["a".repeat(40)], blockers: [] });
    await f.save("report.json", { summary: "保存report", unknown: { preserved: true } });
    await writeFile(join(f.artifacts, "report.md"), "報告本文");
    expect(await retrospective(f.root, id, { phase: "commit" })).toContain("a".repeat(40));
    expect(await retrospective(f.root, id, { phase: "report" })).toContain("報告本文");
    expect(await retrospective(f.root, id, { phase: "report" })).toContain("preserved");
  });
  it("工程40件・出来事20件の境界を表示し抜粋240文字ちょうどは省略しない", async () => {
    const f = await fixture();
    await f.save("implementation-1.json", { summary: "a".repeat(240) });
    await f.events(Array.from({ length: 41 }, (_, i) => f.event(i, "phase.running", "review", { attempt: i + 1 })).concat(Array.from({ length: 21 }, (_, i) => f.event(i + 50, "operation.retry", "review", { operation: "retry", retryCount: 1 }))));
    const text = await retrospective(f.root, id);
    expect(text).toContain("工程2件省略"); expect(text).toContain("出来事1件省略");
    await f.events([]);
    expect(await retrospective(f.root, id)).toContain("変更要約: " + "a".repeat(240) + "\n");
  });
  it("抜粋の境界にまたがる秘密値を切る前にマスキングする", async () => {
    const f = await fixture(); await f.events([]);
    const secret = "sensitive-" + "x".repeat(300);
    await f.save("implementation-1.json", { summary: "a".repeat(230) + secret });
    const text = await retrospective(f.root, id, {}, undefined, [secret]);
    expect(text).toContain("[REDACTED]"); expect(text).not.toContain("sensitive-");
  });
  it("設定・認証・worktreeなしでCLIを利用でき記録・ディレクトリを変更しない", async () => {
    const f = await fixture(); await f.events([]); await f.save("plan.json", { summary: "token=private-value\u001b[31m", extra: "full" });
    const connect = jest.spyOn(GitHubClient, "create"), run = jest.fn();
    const before = await readFile(join(f.run, "state.json"), "utf8"); const names = await readdir(f.root);
    const artifactBefore = await readFile(join(f.artifacts, "plan.json"), "utf8");
    const eventBefore = await readFile(join(f.run, "events.jsonl"), "utf8");
    const runNames = await readdir(f.run), artifactNames = await readdir(f.artifacts);
    let out = "", err = "";
    const code = await executeCli(["--config", "/absent", "show", id, "--phase", "plan", "--no-pager"], { root: f.root, env: {},  stdout: s => { out += s; }, stderr: s => { err += s; } });
    expect(code).toBe(0); expect(err).toBe(""); expect(out).not.toContain("private-value"); expect(out).not.toContain("\u001b"); expect(out).toContain("full");
    expect(connect).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    expect(await readFile(join(f.run, "state.json"), "utf8")).toBe(before); expect(await readdir(f.root)).toEqual(names);
    expect(await readFile(join(f.artifacts, "plan.json"), "utf8")).toBe(artifactBefore);
    expect(await readFile(join(f.run, "events.jsonl"), "utf8")).toBe(eventBefore);
    expect(await readdir(f.run)).toEqual(runNames); expect(await readdir(f.artifacts)).toEqual(artifactNames);
    expect(await executeCli(["show", id, "--phase", "bad"], { root: f.root, env: {}, stderr: () => {} })).toBe(2);
  });
  it("CLIからTTYの長い詳細をページャーへ渡し、--no-pagerは直接出力する", async () => {
    const f = await fixture(); await f.events([]); await f.save("plan.json", { summary: "full".repeat(2000) });
    const pager = jest.fn(async (_text: string) => {}), out = jest.fn(), err = jest.fn();
    const options = { root: f.root, env: {}, stdout: out, stderr: err, stdinIsTTY: true, stdoutIsTTY: true, pager };
    expect(await executeCli(["show", id, "--phase", "plan"], options)).toBe(0);
    expect(pager).toHaveBeenCalledTimes(1); expect(out).not.toHaveBeenCalled();
    expect(await executeCli(["show", id, "--phase", "plan", "--no-pager"], options)).toBe(0);
    expect(pager).toHaveBeenCalledTimes(1); expect(out).toHaveBeenCalledTimes(1); expect(err).not.toHaveBeenCalled();
  });
});

describe("振り返りページャー", () => {
  it.each([[true, true, true, 1], [false, true, true, 0], [true, false, true, 0], [true, true, false, 0]])("TTYと--no-pager条件 %s %s %s", async (enabled, stdinIsTTY, stdoutIsTTY, calls) => {
    const pager = jest.fn(async () => {}), out = jest.fn(), err = jest.fn();
    await pageRetrospective("detail\n".repeat(100), { enabled: Boolean(enabled), stdinIsTTY: Boolean(stdinIsTTY), stdoutIsTTY: Boolean(stdoutIsTTY), pager }, out, err);
    expect(pager).toHaveBeenCalledTimes(Number(calls)); expect(out).toHaveBeenCalledTimes(calls ? 0 : 1); expect(err).not.toHaveBeenCalled();
  });
  it("短文は直接、起動失敗は案内付きで直接表示", async () => {
    const pager = jest.fn(async () => { throw new Error("ENOENT"); }), out = jest.fn(), err = jest.fn();
    await pageRetrospective("short", { enabled: true, stdinIsTTY: true, stdoutIsTTY: true, pager }, out, err);
    expect(pager).not.toHaveBeenCalled();
    await pageRetrospective("long\n".repeat(100), { enabled: true, stdinIsTTY: true, stdoutIsTTY: true, pager }, out, err);
    expect(err).toHaveBeenCalledTimes(1); expect(out).toHaveBeenCalledTimes(2);
  });
});
