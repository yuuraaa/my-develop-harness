import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GitHubClient } from "./github.js";
import type { GitHubConfig } from "./github-config.js";
import { issueResponseSchema, normalizeIssueReference, type IssueApi } from "./github-issue.js";
import type { GitHubRunState } from "./github-state.js";
import { inspectIssue } from "./github-diagnostics.js";
import { WorkflowError } from "./workflow-error.js";

declare const HARNESS_COMPILED: boolean;
export type WatchOptions = {
  interval: number; dryRun: boolean; signal: AbortSignal; config: GitHubConfig; root: string; env?: NodeJS.ProcessEnv;
  api?: IssueApi; inspect?: typeof inspectIssue;
  run: (issue: string) => Promise<GitHubRunState["status"]>;
  out: (text: string) => void;
  wait?: (seconds: number, signal: AbortSignal) => Promise<void>;
};
/** Split long intervals instead of allowing setTimeout's 32-bit overflow. */
export async function waitForPoll(seconds: number, signal: AbortSignal): Promise<void> {
  let remaining = seconds;
  while (remaining > 0 && !signal.aborted) {
    const chunk = Math.min(remaining, 2_147_483);
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, chunk * 1000);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
    remaining -= chunk;
  }
}

export async function watchIssues(options: WatchOptions): Promise<0 | 1> {
  const { signal, out, config } = options;
  if (!config.watch.repositories.length) throw new WorkflowError("fatal", "watch.repositoriesに監視先を明示してください");
  out(`監視先: ${config.watch.repositories.join(", ")}\n`);
  out(`監視開始: 間隔${options.interval}秒${options.dryRun ? " (dry-run・読み取り専用)" : ""}\n`);
  const api = options.api ?? await GitHubClient.create(config, { ...(options.env ? { env: options.env } : {}) });
  while (!signal.aborted) {
    const candidates: { issue: string; createdAt: string; repository: string; number: number }[] = [];
    for (const repository of config.watch.repositories) {
      const labels = `${config.github.labels.enabled},${config.github.labels.ready}`;
      const rows = await api.getPages(`/repos/${repository}/issues?state=open&labels=${encodeURIComponent(labels)}&per_page=100`);
      for (const raw of rows) {
        if (raw && typeof raw === "object" && "pull_request" in raw) continue;
        const issue = issueResponseSchema.parse(raw), ref = normalizeIssueReference(issue.html_url);
        if (ref.repository !== repository || ref.number !== issue.number) throw new WorkflowError("fatal", "候補のリポジトリ・番号が不一致です");
        candidates.push({ issue: ref.url, createdAt: issue.created_at, repository, number: issue.number });
      }
    }
    candidates.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0) || a.number - b.number);
    if (signal.aborted) break;
    out(`候補一覧（作成日時→owner/repo→Issue番号）:\n${candidates.map(c => `  ${c.issue}`).join("\n")}${candidates.length ? "\n" : ""}`);
    let selected: string | undefined;
    for (const candidate of candidates) {
      if (signal.aborted) break;
      const result = await (options.inspect ?? inspectIssue)({ api, config, root: options.root, issue: candidate.issue,
        ...(options.env ? { env: options.env } : {}) });
      for (const warning of result.warnings) out(`注意: ${warning}\n`);
      if (result.selection) out(`${candidate.issue}: ${result.selection.path ? `リポジトリ: ${result.selection.path}` : `clone予定先: ${result.selection.destination}`} / push remote: ${result.selection.pushRemote}\n`);
      if (result.eligibility.status === "waiting") { out(`待機: ${candidate.issue}: ${result.eligibility.reasons.join(" / ")}\n`); continue; }
      selected = candidate.issue;
      out(`選択Issue: ${selected}\n`); break;
    }
    if (options.dryRun) return 0;
    if (signal.aborted) break;
    if (!selected) {
      out(`候補なし、または全件待機。次回取得まで${options.interval}秒待機\n`);
      await (options.wait ?? waitForPoll)(options.interval, signal); continue;
    }
    const status = await options.run(selected);
    if (status !== "completed") { out(`監視停止: ${selected} (${status})\n`); return 1; }
    // 提出成功後は全監視先から取り直す。候補の保存リストを使い回さない。
  }
  out("監視終了: 停止要求\n"); return 0;
}

/** A session leader: terminal SIGINT reaches watch, never the active run tree.
 * Git execFile, verification spawn and SDK's internal spawn inherit this session.
 * Keep the child referenced and await close; detached does not mean background work.
 */
export async function runIsolatedIssue(input: { issue: string; configPath: string; cwd: string;
  env: NodeJS.ProcessEnv; out: (text: string) => void; err: (text: string) => void }): Promise<GitHubRunState["status"]> {
  const compiled = typeof HARNESS_COMPILED !== "undefined" && HARNESS_COMPILED;
  const entry = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./index.ts" : "./index.js", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(compiled ? [] : [entry]), "--config", input.configPath, "run", input.issue], {
      cwd: input.cwd, env: input.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8").on("data", input.out);
    child.stderr.setEncoding("utf8").on("data", input.err);
    child.once("error", reject);
    child.once("close", code => resolve(code === 0 ? "completed" : "stopped"));
  });
}
