import { z } from "zod";
import { GitHubError, type GitHubClient } from "./github.js";
import type { GitHubConfig } from "./github-config.js";
import { issueEndpoint, type IssueReference } from "./github-issue.js";
import type { RunStore } from "./state.js";

export type IssueWriteApi = Pick<GitHubClient, "get" | "getPages" | "update">;
type Labels = GitHubConfig["github"]["labels"];
type StateRole = Exclude<keyof Labels, "enabled">;
const labelList = z.array(z.union([z.string(), z.object({ name: z.string() })]));

/** ラベル集合だけを照合する。本文やenabledの途中変更を追跡して停止しない。 */
export async function transitionIssueLabels(api: IssueWriteApi, store: RunStore, issue: IssueReference,
  labels: Labels, from: StateRole, to: StateRole, operation: string,
  progress?: { observe: (states: StateRole[]) => Promise<void>; write: () => Promise<void>; unconfirmed: () => void }): Promise<StateRole[]> {
  const endpoint = `${issueEndpoint(issue)}/labels`;
  const states = async () => {
    let value: unknown;
    try { value = await api.getPages(endpoint); } catch (error) { progress?.unconfirmed(); throw error; }
    const parsed = labelList.safeParse(value);
    if (!parsed.success) throw new GitHubError("response");
    const actual = parsed.data.map(v => (typeof v === "string" ? v : v.name).toLowerCase());
    const found = (["ready", "running", "blocked", "stopped", "review"] as const).filter(role => actual.includes(labels[role].toLowerCase()));
    await progress?.observe(found);
    return found;
  };
  const observe = async () => {
    const observed = await states();
    if (!observed.length || observed.some(s => s !== from && s !== to)) throw new GitHubError("unknown");
    return observed;
  };
  let actual = await observe();
  await store.saveJson(`labels-${operation}-before.json`, { from, to, actual });
  if (!actual.includes(to)) {
    await store.saveJson(`labels-${operation}-add-intent.json`, { method: "POST", endpoint, label: labels[to] });
    await progress?.write();
    await api.update("POST", endpoint, { labels: [labels[to]] }, async () => {
      const observed = await observe();
      return observed.includes(to) ? { confirmed: true, value: observed } : { confirmed: false };
    });
    actual = await observe();
    if (!actual.includes(to)) throw new GitHubError("unknown");
  }
  if (actual.includes(from)) {
    await store.saveJson(`labels-${operation}-remove-intent.json`, { method: "DELETE", endpoint, label: labels[from] });
    await progress?.write();
    await api.update("DELETE", `${endpoint}/${encodeURIComponent(labels[from])}`, undefined, async () => {
      const observed = await observe();
      return observed.length === 1 && observed[0] === to ? { confirmed: true, value: observed } : { confirmed: false };
    });
  }
  actual = await observe();
  if (actual.length !== 1 || actual[0] !== to) throw new GitHubError("unknown");
  await store.saveJson(`labels-${operation}-confirmed.json`, { from, to, actual });
  return actual;
}

/** 応答不明では全コメントの完全一致を確認し、遅延投稿の可能性が残れば再投稿しない。 */
export async function postBlockedComment(api: IssueWriteApi, store: RunStore, issue: IssueReference, body: string) {
  const endpoint = `${issueEndpoint(issue)}/comments`;
  const comment = z.object({ id: z.union([z.string(), z.number()]), html_url: z.string(), body: z.string() });
  await store.saveJson("blocked-comment-intent.json", { endpoint, body });
  const result = await api.update("POST", endpoint, { body }, async () => {
    const parsed = z.array(comment).safeParse(await api.getPages(endpoint));
    if (!parsed.success) throw new GitHubError("response");
    const matches = parsed.data.filter(c => c.body === body);
    return matches.length === 1 ? { confirmed: true, value: matches[0]! } : { confirmed: false };
  });
  const parsed = comment.safeParse(result);
  if (!parsed.success || parsed.data.body !== body) throw new GitHubError("unknown");
  await store.saveJson("blocked-comment-confirmed.json", parsed.data);
}
