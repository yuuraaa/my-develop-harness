import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const showRunId = "00000000-0000-4000-8000-000000000135";
export const showPhaseNames = ["prepare", "start", "plan", "implementation", "verification", "review", "fix", "verification", "review", "commit", "report"];
export async function createShowFixture(home: string) {
  const root = join(home, ".harness"), run = join(root, "runs", showRunId), artifacts = join(run, "artifacts");
  await mkdir(artifacts, { recursive: true });
  const save = (name: string, value: unknown) => writeFile(join(artifacts, name), JSON.stringify(value));
  await writeFile(join(run, "state.json"), JSON.stringify({ runId: showRunId, schemaVersion: 2, issue: { url: "https://github.com/owner/repo/issues/133" }, status: "completed", phase: "report", phaseStatus: "succeeded", error: null }));
  await save("issue-input.json", { issue: { id: "133", title: "工程一覧と日本語全文の確認" } });
  const events: unknown[] = [];
  for (const [i, phase] of showPhaseNames.entries()) {
    const attempt = (phase === "verification" || phase === "review") && i > 6 ? 2 : 1;
    events.push({ timestamp: new Date(Date.UTC(2026, 9, 31, 0, 0, i * 2)).toISOString(), type: "phase.running", phase, data: { attempt } });
    events.push({ timestamp: new Date(Date.UTC(2026, 9, 31, 0, 0, i * 2 + 1)).toISOString(), type: "phase.succeeded", phase, data: { attempt } });
    if (phase === "review") events.push({ timestamp: new Date(Date.UTC(2026, 9, 31, 0, 0, i * 2 + 1)).toISOString(), type: "review.assessed", phase, data: { attempt, decision: attempt === 1 ? "fix" : "passed" } });
  }
  await writeFile(join(run, "events.jsonl"), events.map(v => JSON.stringify(v)).join("\n") + "\n");
  await save("plan-output-1.json", { summary: "計画本文", steps: ["調査", "実装"] });
  await save("plan.json", { summary: "正式採用計画" });
  await save("plan-decision-1.json", { accepted: true });
  const summary = "日本語長文・全角・e\u0301・👩‍💻を保持する。\n".repeat(100) + "全文末尾マーカー";
  await save("implementation-1.json", { summary, validation: [{ command: "self", status: "passed", details: "エージェント自主検証" }], unknownField: "未知項目末尾" });
  await save("implementation-2.json", { summary: "修正の全文\n" + summary });
  for (const attempt of [1, 2]) {
    const commands = Array.from({ length: 8 }, (_, i) => ({ definition: { id: `check-${i}` }, status: attempt === 1 && i >= 5 ? "failed" : "passed", stdout: { text: "保存ログ全文\nログ末尾", truncated: true, omittedReason: "保存上限" }, stderr: { text: "[REDACTED]", truncated: false } }));
    await save(`verification-${attempt}.json`, { commands });
    await save(`review-${attempt}.json`, { summary: "レビュー全文", findings: attempt === 1 ? [1, 2].map(i => ({ severity: "major", description: `指摘${i}\n${summary}`, location: "example.ts:1" })) : [] });
  }
  await save("commit.json", { commitHashes: ["abc123"] });
  await save("report.json", { summary: "報告本文" });
  await writeFile(join(artifacts, "report.md"), "# 完了報告\n報告全文末尾");
  return { home, root, run, artifacts, save, summary };
}
