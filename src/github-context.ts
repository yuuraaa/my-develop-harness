import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { GitHubConfig } from "./github-config.js";
import { gitEnvironment, type GitCommand } from "./git.js";
import { redact, environmentSecrets } from "./state.js";
import { IssueContextError, IssueReader, fullSha, issueKey, normalizeIssueReference, parseResponse, summarizeIssue,
  type Issue, type IssueApi, type IssueDocument, type IssueSummary } from "./github-issue.js";
import { evaluateDependency, type CheckInclusion, type DependencyDecision } from "./github-evidence.js";

export type ContextFile = { repository: string; repositoryId: string; commit: string; path: string; body: string;
  source: string; fetchedAt: string; appliesTo: string | null; supersededBy?: string };
export type IssueContext = { schemaVersion: 2; backend: "github"; fetchedAt: string; target: IssueDocument;
  ancestors: IssueDocument[]; managementIssue: Issue; children: IssueSummary[]; dependencies: IssueDocument[];
  dependencyGraph: { issue: string; blockedBy: string[]; source: string }[]; requiredIssues: IssueDocument[];
  files: ContextFile[]; previousInputs: { source: string; body: string }[]; totalBytes: number; maxBytes: number;
  startCommit: string | null; sourcesComplete: boolean };
class Budget {
  total = 0;
  private readonly seen = new Map<string, string>();
  constructor(readonly max: number) {}
  add(key: string, body: string) {
    if (this.seen.has(key)) {
      if (this.seen.get(key) !== body) throw new IssueContextError("response", { source: key });
      return;
    }
    this.seen.set(key, body); this.total += Buffer.byteLength(body, "utf8");
    if (this.total > this.max) throw new IssueContextError("limit", { source: key, totalBytes: this.total, maxBytes: this.max });
  }
  document(document: IssueDocument) {
    this.add(`issue:${document.issue.repositoryId}:${document.issue.id}`, document.issue.body ?? "");
    for (const c of document.comments) this.add(`comment:${c.id}`, c.body);
  }
}
export type CommitFileReader = { list(commit: string): Promise<{ path: string; mode: string }[]>; read(commit: string, path: string): Promise<string> };
const exec = promisify(execFile);
/** 本文上限はBudgetで適用する。Gitの既定4MiBバッファやUTF-8置換で内容を落とさない。 */
const readContextGit: GitCommand = async (cwd, args) => {
  try {
    const output = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false", ...args],
      { cwd, env: gitEnvironment(process.env), encoding: "buffer", maxBuffer: Infinity });
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output.stdout);
  } catch { throw new IssueContextError("source"); }
};
/** 開始点のtreeを読み、作業ディレクトリ上の未コミット指示やsymlinkを追わない。 */
export function localCommitFiles(repositoryPath: string, git: GitCommand = readContextGit): CommitFileReader {
  return {
    async list(commit) {
      fullSha.parse(commit);
      if ((await git(repositoryPath, ["rev-parse", "--verify", `${commit}^{commit}`])).trim() !== commit) throw new IssueContextError("source");
      return (await git(repositoryPath, ["ls-tree", "-r", "-z", "--full-tree", commit])).split("\0").filter(Boolean).map(line => {
        const match = /^(\d{6}) \w+ [a-f0-9]+\t([\s\S]+)$/.exec(line);
        if (!match) throw new IssueContextError("source");
        return { mode: match[1]!, path: match[2]! };
      });
    },
    async read(commit, path) { return git(repositoryPath, ["show", `${fullSha.parse(commit)}:${safePath(path)}`]); },
  };
}
function safePath(path: string): string {
  if (!path || path.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(path) || path.split("/").some(p => !p || p === "." || p === ".."))
    throw new IssueContextError("source");
  return path;
}
const entrySchema = z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: fullSha });
const treeSchema = z.object({ truncated: z.literal(false), tree: z.array(entrySchema) });
function decodeBlob(value: unknown): string {
  const blob = parseResponse(z.object({ encoding: z.literal("base64"), content: z.string(), size: z.number().int().nonnegative() }), value);
  const encoded = blob.content.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new IssueContextError("source");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== blob.size) throw new IssueContextError("source");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new IssueContextError("source"); }
}

export async function fetchIssueContext(api: IssueApi, config: GitHubConfig, input: string, options: {
  startCommit?: string; commitFiles?: CommitFileReader; previousInputs?: { source: string; body: string }[];
  now?: () => string;
} = {}): Promise<IssueContext> {
  const reader = new IssueReader(api, options.now), budget = new Budget(config.github.maxContextBytes);
  const target = await reader.document(normalizeIssueReference(input)); budget.document(target);
  const ancestors: IssueDocument[] = [], seen = new Set([`${target.issue.repositoryId}:${target.issue.id}`]);
  let current = target.issue, managementIssue = target.issue;
  while (true) {
    const parent = await reader.parent(current);
    if (!parent) break;
    const key = `${parent.repositoryId}:${parent.id}`;
    if (seen.has(key)) throw new IssueContextError("cycle");
    seen.add(key);
    const document = await reader.document(parent);
    if (document.issue.id !== parent.id || document.issue.repositoryId !== parent.repositoryId) throw new IssueContextError("response");
    ancestors.push(document); budget.document(document);
    if (parent.repositoryId === target.issue.repositoryId) managementIssue = document.issue;
    current = document.issue;
  }
  const children = await reader.relations(target.issue, "sub_issues");
  if (children.some(c => seen.has(`${c.repositoryId}:${c.id}`))) throw new IssueContextError("cycle");
  const direct = await reader.relations(target.issue, "dependencies/blocked_by");
  const dependencies: IssueDocument[] = [];
  for (const dependency of direct) {
    const doc = await reader.document(dependency);
    if (doc.issue.id !== dependency.id) throw new IssueContextError("response");
    budget.document(doc); dependencies.push(doc);
  }
  // DFSの明示スタックで深い依存でもcall stackを消費しない。共有依存は一度だけ取得。
  const dependencyGraph: IssueContext["dependencyGraph"] = [];
  const done = new Set<string>(), active = new Set<string>();
  const stack: { issue: Issue; exit: boolean }[] = [{ issue: target.issue, exit: false }];
  while (stack.length) {
    const node = stack.pop()!, key = issueKey(node.issue);
    if (node.exit) { active.delete(key); done.add(key); continue; }
    if (active.has(key)) throw new IssueContextError("cycle");
    if (done.has(key)) continue;
    active.add(key); stack.push({ ...node, exit: true });
    const relations = key === issueKey(target.issue) ? direct : await reader.relations(node.issue, "dependencies/blocked_by");
    dependencyGraph.push({ issue: key, blockedBy: relations.map(issueKey), source: `${node.issue.source}/dependencies/blocked_by` });
    for (const issue of relations.toReversed()) stack.push({ issue, exit: false });
  }
  const context: IssueContext = { schemaVersion: 2, backend: "github", fetchedAt: reader.now(), target, ancestors, managementIssue,
    children: children.map(summarizeIssue), dependencies, dependencyGraph, requiredIssues: [], files: [], previousInputs: options.previousInputs ?? [],
    totalBytes: 0, maxBytes: budget.max, startCommit: options.startCommit ?? null, sourcesComplete: false };
  for (const previous of context.previousInputs) budget.add(`previous:${previous.source}`, previous.body);
  const required = config.repositories[target.issue.repository]?.requiredSources ?? [];
  // APIで読める追加Issueは開始点なしでも取得。file/指示は開始SHA確定後に読む。
  for (const source of required.filter(s => s.kind === "githubIssue")) {
    const doc = await reader.document(normalizeIssueReference(`${source.repository}#${source.number}`));
    budget.document(doc); context.requiredIssues.push(doc);
  }
  const addFile = (file: ContextFile) => {
    const key = `file:${file.repositoryId}:${file.commit}:${file.path}`;
    budget.add(key, file.body);
    if (!context.files.some(f => f.repositoryId === file.repositoryId && f.commit === file.commit && f.path === file.path)) context.files.push(file);
  };
  if (options.startCommit) {
    if (!fullSha.safeParse(options.startCommit).success || !options.commitFiles) throw new IssueContextError("source");
    const entries = await options.commitFiles.list(options.startCommit);
    const paths = new Set(entries.filter(e => /(?:^|\/)AGENTS(?:\.override)?\.md$/.test(e.path)).map(e => e.path));
    for (const source of required) if (source.kind === "file") paths.add(safePath(source.path));
    for (const path of [...paths].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
      const entry = entries.find(e => e.path === path);
      if (!entry || !["100644", "100755"].includes(entry.mode)) throw new IssueContextError("source");
      const instruction = /(?:^|\/)AGENTS(?:\.override)?\.md$/.test(path);
      const override = path.replace(/AGENTS\.md$/, "AGENTS.override.md");
      const supersededBy = path.endsWith("AGENTS.md") && paths.has(override) ? override : null;
      addFile({ repository: target.issue.repository, repositoryId: target.issue.repositoryId, commit: options.startCommit, path,
        body: await options.commitFiles.read(options.startCommit, path), source: `git:${options.startCommit}:${path}`, fetchedAt: reader.now(),
        appliesTo: instruction && !supersededBy ? (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) + "/**" : "**") : null,
        ...(supersededBy ? { supersededBy } : {}) });
    }
    context.sourcesComplete = true;
  }
  for (const source of required) if (source.kind === "githubFile") {
    const repositoryId = await reader.repositoryId(source.repository);
    const commit = parseResponse(z.object({ sha: fullSha, commit: z.object({ tree: z.object({ sha: fullSha }) }) }),
      await api.get(`/repos/${source.repository}/commits/${encodeURIComponent(source.ref)}`));
    const tree = parseResponse(treeSchema, await api.get(`/repos/${source.repository}/git/trees/${commit.commit.tree.sha}?recursive=1`));
    const path = safePath(source.path), entry = tree.tree.find(e => e.path === path);
    if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw new IssueContextError("source");
    addFile({ repository: source.repository, repositoryId, commit: commit.sha, path,
      body: decodeBlob(await api.get(`/repos/${source.repository}/git/blobs/${entry.sha}`)),
      source: `/repos/${source.repository}/git/blobs/${entry.sha}`, fetchedAt: reader.now(), appliesTo: null });
  }
  context.totalBytes = budget.total;
  return context;
}

export type IssueEligibility = { status: "ready" | "waiting"; reasons: string[]; dependencies: DependencyDecision[] };
/** run/watch共通の純粋な候補条件。取得・設定・保存の失敗はwaitingへ丸めず例外で停止する。 */
export async function evaluateIssueEligibility(api: IssueApi, config: GitHubConfig, context: IssueContext,
  options: { harnessLogin?: string; checkInclusion?: CheckInclusion } = {}): Promise<IssueEligibility> {
  const reasons: string[] = [], issue = context.target.issue, labels = config.github.labels;
  if (issue.state !== "open") reasons.push("Issueがopenではない");
  const actual = issue.labels.map(l => l.toLowerCase());
  if (!actual.includes(labels.enabled.toLowerCase())) reasons.push("実行許可ラベルがない");
  const states = [labels.ready, labels.running, labels.blocked, labels.stopped, labels.review].map(l => l.toLowerCase()).filter(l => actual.includes(l));
  if (states.length !== 1 || states[0] !== labels.ready.toLowerCase()) reasons.push("単一readyではない");
  if (context.children.length) reasons.push("子Issueを持つ親は実行対象外");
  const dependencies: DependencyDecision[] = [];
  for (const dependency of context.dependencies) {
    const decision = await evaluateDependency(api, dependency, options.harnessLogin ?? null, context.startCommit, options.checkInclusion);
    dependencies.push(decision);
    if (decision.status !== "satisfied") reasons.push(`${decision.issue}: ${decision.reason}`);
  }
  if (!context.sourcesComplete) reasons.push("開始コミットの指示・必須資料が未取得");
  return { status: reasons.length ? "waiting" : "ready", reasons, dependencies };
}

/** runディレクトリは呼び出し側で作成する。成果物は新規のみ・秘密除外・fsync後確定。 */
export async function saveIssueContext(artifactsPath: string, context: IssueContext, eligibility: IssueEligibility,
  secrets: readonly string[] = environmentSecrets()): Promise<void> {
  const scrub = (value: unknown): unknown => typeof value === "string" ? redact(value, secrets)
    : Array.isArray(value) ? value.map(scrub) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)])) : value;
  for (const [name, value] of [["issue-context", context], ["dependency-evidence", { startCommit: context.startCommit, ...eligibility }]] as const) {
    const path = join(artifactsPath, `${name}.json`), temp = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(artifactsPath, { recursive: true, mode: 0o700 });
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(scrub(value), null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
      await link(temp, path); await unlink(temp);
      const directory = await open(artifactsPath, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { await unlink(temp).catch(() => {}); throw new IssueContextError("storage"); }
  }
}
