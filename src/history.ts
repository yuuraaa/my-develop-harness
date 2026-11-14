import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runIdSchema } from "./schemas.js";
import type { RunState } from "./schemas.js";
import { githubStateSchema, type GitHubRunState } from "./github-state.js";
import { redact, environmentSecrets } from "./state.js";

export type HistoryOptions = { issue?: string; status?: RunState["status"]; limit?: number; all?: boolean };
export type HistoryEntry = { runId: string; state: GitHubRunState | null };

/** Read only the last atomically saved state; artifacts and run locks are independent. */
export async function collectHistory(root: string): Promise<HistoryEntry[]> {
  let entries;
  try { entries = await readdir(join(root, "runs"), { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("履歴一覧を読み取れません。");
  }
  const result: HistoryEntry[] = [];
  for (const entry of entries) {
    if (!runIdSchema.safeParse(entry.name).success) continue;
    let state: GitHubRunState | null = null;
    try {
      // Do not follow run-directory symlinks outside the record directory.
      if (entry.isDirectory()) {
        const raw = JSON.parse(await readFile(join(root, "runs", entry.name, "state.json"), "utf8"));
        const parsed = githubStateSchema.parse(raw);
        if (parsed.runId === entry.name) state = parsed;
      }
    } catch { /* One unreadable record must not hide the other runs. */ }
    result.push({ runId: entry.name, state });
  }
  return result;
}

export function formatHistory(entries: readonly HistoryEntry[], options: HistoryOptions = {}, secrets = environmentSecrets()): string {
  const matching = entries.filter(entry => entry.state !== null
    && (!options.issue || entry.state.issue.url === options.issue)
    && (!options.status || entry.state.status === options.status))
    .sort((a, b) => Date.parse(b.state!.updatedAt) - Date.parse(a.state!.updatedAt) || a.runId.localeCompare(b.runId));
  const selected = options.all ? matching : matching.slice(0, options.limit ?? 20);
  const unreadable = entries.filter(entry => entry.state === null).sort((a, b) => a.runId.localeCompare(b.runId));
  const lines = ["run ID\t形式\tIssue\t保存状態\t最後の保存フェーズ\t最終更新日時"];
  for (const entry of selected) {
    const state = entry.state!;
    lines.push([entry.runId, "GitHub", state.issue.url, state.status, state.phase, state.updatedAt].join("\t"));
  }
  if (!matching.length) lines.push("該当する実行履歴はありません。");
  if (unreadable.length) {
    lines.push("注意: 以下の記録は読取不能です（絞り込み・件数制限の対象外）。");
    for (const entry of unreadable) lines.push(`${entry.runId}\t読取不能`);
  }
  lines.push("詳細: harness status <run-id>");
  return redact(lines.join("\n") + "\n", secrets);
}
