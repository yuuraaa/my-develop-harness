import { describe, it, expect } from "bun:test";
import { watchIssues, waitForPoll, type WatchOptions } from "../src/watch.js";
import { parseGitHubConfig } from "../src/github-config.js";
import type { IssueInspection } from "../src/github-diagnostics.js";
const ready: IssueInspection = { eligibility: { status: "ready", reasons: [], dependencies: [] }, selection: null, startCommit: null, worktreePath: null, previousRunId: null, warnings: [] };
const row = (repo: string, number: number, date = "2026-01-01T00:00:00Z") => ({ id: number, number, html_url: `https://github.com/${repo}/issues/${number}`, title: "候補", body: "要件", state: "open", state_reason: null, labels: ["harness:enabled", "harness:ready"], created_at: date, updated_at: date, assignees: [], priority: "low" });
function setup() {
  const abort = new AbortController(), output: string[] = [], calls: string[] = [], runs: string[] = [];
  const options: WatchOptions = { root: "/tmp/unused", config: parseGitHubConfig({ schemaVersion: 2, github: {}, watch: { repositories: ["z/b", "a/a"] } }, "/tmp/config.json"),
    signal: abort.signal, interval: 1, dryRun: false, out: text => output.push(text),
    api: { get: async () => { throw new Error("unused"); }, getPages: async endpoint => { calls.push(endpoint); return [row(endpoint.includes("z/b") ? "z/b" : "a/a", 1)] as never; } },
    inspect: async () => ready, run: async issue => { runs.push(issue); abort.abort(); return "completed"; } };
  return { abort, output, calls, runs, options };
}
describe("GitHub watch", () => {
  it("明示した全repoの全候補を作成日時・repo・番号順に整列し、優先度・担当者を条件にしない", async () => {
    const f = setup();
    f.options.api!.getPages = async endpoint => (endpoint.includes("z/b") ? [row("z/b", 8, "2025-01-01T00:00:00Z"), row("z/b", 1)] : [row("a/a", 9), row("a/a", 2)]) as never;
    expect(await watchIssues(f.options)).toBe(0);
    const text = f.output.join("");
    expect(text.indexOf("  https://github.com/z/b/issues/8")).toBeLessThan(text.indexOf("  https://github.com/a/a/issues/2"));
    expect(text.indexOf("  https://github.com/a/a/issues/2")).toBeLessThan(text.indexOf("  https://github.com/a/a/issues/9"));
    expect(f.runs).toEqual(["https://github.com/z/b/issues/8"]);
  });
  it("待機を飛ばし、外部更新せず次のready候補を実行", async () => {
    const f = setup();
    f.options.inspect = async ({ issue }) => issue.includes("a/a") ? { ...ready, eligibility: { status: "waiting", reasons: ["依存未完了"], dependencies: [] } } : ready;
    expect(await watchIssues(f.options)).toBe(0);
    expect(f.runs).toEqual(["https://github.com/z/b/issues/1"]);
    expect(f.output.join("")).toContain("依存未完了");
    expect(f.calls).toHaveLength(2);
  });
  it("全件待機は次周期で再取得・再評価する", async () => {
    const f = setup(); let waiting = true, waits = 0;
    f.options.inspect = async () => waiting ? { ...ready, eligibility: { status: "waiting", reasons: ["依存成果なし"], dependencies: [] } } : ready;
    f.options.wait = async () => { waits++; waiting = false; };
    expect(await watchIssues(f.options)).toBe(0);
    expect(waits).toBe(1); expect(f.calls).toHaveLength(4); expect(f.runs).toHaveLength(1);
  });
  it("提出完了後は全repoの候補を再取得する", async () => {
    const f = setup(); let count = 0;
    f.options.run = async () => { if (++count === 2) f.abort.abort(); return "completed"; };
    expect(await watchIssues(f.options)).toBe(0); expect(f.calls).toHaveLength(4);
  });
  it.each(["blocked", "stopped", "running"] as const)("%sで次のIssueを開始しない", async status => {
    const f = setup(); f.options.run = async () => status;
    expect(await watchIssues(f.options)).toBe(1); expect(f.calls).toHaveLength(2);
  });
  it("dry-runは候補と待機理由を表示するだけで実行しない", async () => {
    const f = setup(); f.options.dryRun = true;
    expect(await watchIssues(f.options)).toBe(0); expect(f.runs).toEqual([]);
  });
  it("PRは候補から除く", async () => {
    const f = setup(); f.options.dryRun = true;
    f.options.api!.getPages = async () => [{ ...row("a/a", 1), pull_request: {} }] as never;
    expect(await watchIssues(f.options)).toBe(0); expect(f.runs).toEqual([]);
  });
  it("取得失敗は継続しない", async () => {
    const f = setup(); f.options.api!.getPages = async () => { throw new Error("private-response"); };
    await expect(watchIssues(f.options)).rejects.toThrow(); expect(f.runs).toEqual([]);
  });
  it("監視一覧が空なら探索先やcwdへフォールバックしない", async () => {
    const f = setup(); f.options.config.watch.repositories = [];
    await expect(watchIssues(f.options)).rejects.toThrow("監視先"); expect(f.calls).toEqual([]);
  });
  it("待機を中断でき、停止後は取得しない", async () => {
    const f = setup(); f.abort.abort(); await waitForPoll(2_147_484, f.abort.signal);
    expect(await watchIssues(f.options)).toBe(0); expect(f.calls).toEqual([]);
  });
});
