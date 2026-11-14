import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, link, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { fullSha, githubId } from "./github-issue.js";
import { repositoryNameSchema } from "./github-config.js";

export class WorkspaceError extends Error {
  constructor(readonly reason: string, readonly candidates: string[] = []) {
    super(`GitHub作業環境: ${reason}${candidates.length ? ` (${candidates.join(", ")})` : ""}`);
  }
}
export const contentBranchSchema = z.string().regex(/^(?:feature|fix|hotfix|chore|docs|refactor)\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .refine(v => !/[\x00-\x20\x7f]/.test(v));
export const workspaceIdentitySchema = z.object({ host: z.literal("github.com"), repositoryId: githubId,
  repository: repositoryNameSchema, issueId: githubId, number: z.number().int().positive().safe() });
export type WorkspaceIdentity = z.infer<typeof workspaceIdentitySchema>;
export const branchRecordSchema = z.strictObject({ schemaVersion: z.literal(2), host: z.literal("github.com"),
  repositoryId: githubId, repository: repositoryNameSchema, managementIssueId: githubId,
  managementIssueNumber: z.number().int().positive().safe(), branchName: contentBranchSchema,
  decisionRunId: z.uuid(), initialBaseCommit: fullSha, creationStatus: z.enum(["reserved", "created"]),
  localTip: fullSha.nullable(), remoteTip: fullSha.nullable(), updatedAt: z.iso.datetime(),
}).refine(r => r.creationStatus !== "created" || r.localTip !== null);
export type BranchRecord = z.infer<typeof branchRecordSchema>;
const absolutePath = z.string().refine(p => isAbsolute(p) && resolve(p) === p);
/** 作業環境の照合に必要な識別情報と開始点。 */
export const workspaceRunSchema = z.object({ schemaVersion: z.literal(2), backend: z.literal("github"), runId: z.uuid(),
  issue: workspaceIdentitySchema, managementIssue: workspaceIdentitySchema,
  repositoryPath: absolutePath.nullable(), worktreePath: absolutePath.nullable(),
  previousRunId: z.uuid().nullable(), worktreeOriginRunId: z.uuid(),
  branchName: contentBranchSchema.nullable(), workBranchName: z.string().nullable(), branchRecordPath: absolutePath.nullable(),
  baseCommit: fullSha.nullable(), restartHead: fullSha.nullable(), remoteStartCommit: fullSha.nullable(),
});
export type WorkspaceRun = z.infer<typeof workspaceRunSchema>;
export function sameIdentity(a: WorkspaceIdentity, b: WorkspaceIdentity): boolean {
  return a.host === b.host && a.repositoryId === b.repositoryId && a.repository === b.repository && a.issueId === b.issueId && a.number === b.number;
}
export function recordMatches(record: BranchRecord, identity: WorkspaceIdentity): boolean {
  return record.host === identity.host && record.repositoryId === identity.repositoryId && record.repository === identity.repository
    && record.managementIssueId === identity.issueId && record.managementIssueNumber === identity.number;
}
export async function pathInfo(path: string) {
  try { return await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
async function regularJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { throw new WorkspaceError("記録を読み取れません", [path]); }
}
export async function durableJson(path: string, value: unknown, replace = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
    if (replace) await rename(temporary, path); else { await link(temporary, path); await unlink(temporary); }
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch { await unlink(temporary).catch(() => {}); throw new WorkspaceError("記録の永続保存に失敗。実物と記録を確認してください", [path]); }
}
export class BranchStore {
  readonly root: string;
  readonly warnings: string[] = [];
  constructor(root: string) { this.root = resolve(root); }
  path(identity: WorkspaceIdentity): string {
    workspaceIdentitySchema.parse(identity);
    return join(this.root, "branches", identity.repositoryId, `${identity.issueId}.json`);
  }
  async read(identity: WorkspaceIdentity): Promise<BranchRecord | null> {
    const path = this.path(identity);
    if (!await pathInfo(path)) return null;
    const parsed = branchRecordSchema.safeParse(await regularJson(path));
    if (!parsed.success || !recordMatches(parsed.data, identity)) throw new WorkspaceError("ブランチ対応が破損・不一致です", [path]);
    return parsed.data;
  }
  /** 他管理単位からは衝突判定に必要な名前だけを読む。 */
  async reservedNames(repositoryId: string): Promise<string[]> {
    githubId.parse(repositoryId);
    const directory = join(this.root, "branches", repositoryId);
    if (!await pathInfo(directory)) return [];
    const names: string[] = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = z.object({ branchName: contentBranchSchema }).parse(await regularJson(join(directory, name)));
        names.push(parsed.branchName);
      } catch { this.warnings.push(`予約名を読み取れません: ${join(directory, name)}`); }
    }
    return names;
  }
  async reserve(record: BranchRecord): Promise<void> {
    const checked = branchRecordSchema.parse(record);
    if (checked.creationStatus !== "reserved" || checked.localTip !== null || checked.remoteTip !== null) throw new WorkspaceError("新規予約が不正です");
    if (await pathInfo(this.path(recordIdentity(record))) || (await this.reservedNames(record.repositoryId)).includes(record.branchName))
      throw new WorkspaceError("名前または管理単位の予約が既存です");
    await durableJson(this.path(recordIdentity(record)), checked);
  }
  async update(previous: BranchRecord, next: BranchRecord): Promise<void> {
    const identity = recordIdentity(previous), current = await this.read(identity);
    const parsed = branchRecordSchema.parse(next);
    if (!current || JSON.stringify(current) !== JSON.stringify(previous)
      || !recordMatches(parsed, identity) || parsed.branchName !== current.branchName || parsed.decisionRunId !== current.decisionRunId
      || parsed.initialBaseCommit !== current.initialBaseCommit || parsed.creationStatus !== "created")
      throw new WorkspaceError("対応記録の期待値が変化しました");
    await durableJson(this.path(identity), parsed, true);
  }
  async runs(identity: WorkspaceIdentity, issue: WorkspaceIdentity, excludeRunId?: string): Promise<WorkspaceRun[]> {
    const directory = join(this.root, "runs");
    if (!await pathInfo(directory)) return [];
    const runs: WorkspaceRun[] = [];
    for (const name of await readdir(directory)) {
      if (!z.uuid().safeParse(name).success || name === excludeRunId) continue;
      const path = join(directory, name, "state.json");
      let raw: unknown;
      try { raw = await regularJson(path); }
      catch { this.warnings.push(`履歴を読み取れません: ${path}`); continue; }
      const reference = z.object({ repositoryId: githubId, issueId: githubId });
      const owner = z.object({ managementIssue: reference }).safeParse(raw);
      const target = z.object({ issue: reference }).safeParse(raw);
      const sameIssue = target.success && target.data.issue.repositoryId === issue.repositoryId && target.data.issue.issueId === issue.issueId;
      if (!sameIssue) {
        if (!owner.success) { this.warnings.push(`履歴の管理単位を読み取れません: ${path}`); continue; }
        if (owner.data.managementIssue.repositoryId !== identity.repositoryId || owner.data.managementIssue.issueId !== identity.issueId) continue;
      }
      const parsed = workspaceRunSchema.safeParse(raw);
      if (!parsed.success || parsed.data.runId !== name) throw new WorkspaceError("過去実行記録が破損・不足しています", [path]);
      runs.push(parsed.data);
    }
    return runs;
  }
  async publicationStatus(runId: string): Promise<"not_started" | "in_flight" | "succeeded" | "failed" | "unknown" | null> {
    z.uuid().parse(runId);
    const path = join(this.root, "runs", runId, "artifacts", "submission.json");
    if (!await pathInfo(path)) return null;
    const parsed = z.object({ push: z.object({ status: z.enum(["not_started", "in_flight", "succeeded", "failed", "unknown"]) }) }).safeParse(await regularJson(path));
    if (!parsed.success) throw new WorkspaceError("提出記録が破損しています", [path]);
    return parsed.data.push.status;
  }
}
export function recordIdentity(record: BranchRecord): WorkspaceIdentity {
  return { host: record.host, repositoryId: record.repositoryId, repository: record.repository,
    issueId: record.managementIssueId, number: record.managementIssueNumber };
}
