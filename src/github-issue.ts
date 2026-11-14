import { z } from "zod";
import { repositoryNameSchema } from "./github-config.js";
import { GitHubError, type GitHubClient } from "./github.js";

export const fullSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).refine(v => v.length === 40 || v.length === 64);
export const githubId = z.union([z.string().regex(/^[1-9][0-9]*$/).refine(v => v.trim() === v), z.number().int().positive().safe().transform(String)]);
export type IssueReference = { repository: string; number: number; url: string };
export class IssueContextError extends Error {
  constructor(readonly kind: "identifier" | "response" | "cycle" | "limit" | "source" | "storage",
    readonly details: Record<string, string | number> = {}) {
    super(`Issue文脈: ${kind}`);
  }
}
/** URL parserによるパス正規化より先に、許可する表記だけを照合する。 */
export function normalizeIssueReference(input: string): IssueReference {
  if (/[\x00-\x20\x7f]/.test(input)) throw new IssueContextError("identifier");
  const match = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/issues\/([1-9][0-9]*)\/?$/i.exec(input)
    ?? /^([^/#]+\/[^/#]+)#([1-9][0-9]*)$/.exec(input);
  const repository = repositoryNameSchema.safeParse(match?.[1]);
  const number = Number(match?.[2]);
  if (!repository.success || !Number.isSafeInteger(number) || number < 1) throw new IssueContextError("identifier");
  return { repository: repository.data, number, url: `https://github.com/${repository.data}/issues/${number}` };
}
const timestamp = z.iso.datetime({ offset: true });
const user = z.object({ id: githubId, login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9\[\]-]*$/), type: z.string() });
export const issueResponseSchema = z.object({
  id: githubId, number: z.number().int().positive().safe(), html_url: z.string(),
  title: z.string(), body: z.string().nullable(), state: z.enum(["open", "closed"]), state_reason: z.string().nullable(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).transform(v => v.map(x => typeof x === "string" ? x : x.name)),
  created_at: timestamp, updated_at: timestamp, pull_request: z.unknown().optional(),
  parent_issue_url: z.string().nullable().optional(),
});
export const commentResponseSchema = z.object({
  id: githubId, body: z.string(), user: user.nullable(), created_at: timestamp, updated_at: timestamp, html_url: z.string(),
});
export type Issue = z.infer<typeof issueResponseSchema> & IssueReference & { repositoryId: string; fetchedAt: string; source: string };
export type IssueSummary = Pick<Issue, "id" | "number" | "repository" | "repositoryId" | "url" | "state" | "state_reason" | "source" | "fetchedAt">;
export function summarizeIssue(issue: Issue): IssueSummary {
  const { id, number, repository, repositoryId, url, state, state_reason, source, fetchedAt } = issue;
  return { id, number, repository, repositoryId, url, state, state_reason, source, fetchedAt };
}
export type IssueComment = z.infer<typeof commentResponseSchema>;
export type IssueDocument = { issue: Issue; comments: IssueComment[]; commentsSource: string; fetchedAt: string };
export type IssueApi = Pick<GitHubClient, "get" | "getPages">;
export function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new IssueContextError("response");
  return parsed.data;
}
export function issueEndpoint(ref: Pick<IssueReference, "repository" | "number">): string {
  return `/repos/${ref.repository}/issues/${ref.number}`;
}
export function issueKey(ref: Pick<IssueReference, "repository" | "number">): string { return `${ref.repository}#${ref.number}`; }

/** 改名・移転を自動追従せず、repoのAPI名/IDとIssueのURLを照合する。 */
export class IssueReader {
  private readonly repositories = new Map<string, string>();
  private readonly documents = new Map<string, IssueDocument>();
  constructor(readonly api: IssueApi, readonly now: () => string = () => new Date().toISOString()) {}
  async repositoryId(repository: string): Promise<string> {
    const cached = this.repositories.get(repository);
    if (cached) return cached;
    const repo = parseResponse(z.object({ id: githubId, full_name: repositoryNameSchema }), await this.api.get(`/repos/${repository}`));
    if (repo.full_name !== repository) throw new IssueContextError("response");
    this.repositories.set(repository, repo.id);
    return repo.id;
  }
  async issue(raw: unknown, expected?: IssueReference): Promise<Issue> {
    const value = parseResponse(issueResponseSchema, raw);
    if (value.pull_request !== undefined) throw new IssueContextError("identifier");
    const ref = normalizeIssueReference(value.html_url);
    if (value.number !== ref.number || expected && issueKey(expected) !== issueKey(ref)) throw new IssueContextError("response");
    return { ...value, ...ref, repositoryId: await this.repositoryId(ref.repository), fetchedAt: this.now(), source: issueEndpoint(ref) };
  }
  async document(ref: IssueReference): Promise<IssueDocument> {
    const key = issueKey(ref), cached = this.documents.get(key);
    if (cached) return cached;
    const issue = await this.issue(await this.api.get(issueEndpoint(ref)), ref);
    const commentsSource = `${issueEndpoint(ref)}/comments?per_page=100`;
    const comments = parseResponse(z.array(commentResponseSchema), await this.api.getPages(commentsSource));
    if (new Set(comments.map(c => c.id)).size !== comments.length) throw new IssueContextError("response");
    const document = { issue, comments, commentsSource, fetchedAt: this.now() };
    this.documents.set(key, document);
    return document;
  }
  async parent(issue: Issue): Promise<Issue | null> {
    try {
      const parent = await this.issue(await this.api.get(`${issueEndpoint(issue)}/parent`));
      if (issue.parent_issue_url === null) throw new IssueContextError("response");
      if (issue.parent_issue_url !== undefined && issue.parent_issue_url !== `https://api.github.com${issueEndpoint(parent)}`)
        throw new IssueContextError("response");
      return parent;
    } catch (e) {
      // 可視のIssue本体が親なしを明示する場合のみ404を採用。欠落・不可視の親は停止する。
      if (e instanceof GitHubError && e.status === 404 && issue.parent_issue_url === null) return null;
      throw e;
    }
  }
  async relations(ref: IssueReference, kind: "sub_issues" | "dependencies/blocked_by"): Promise<Issue[]> {
    const raw = await this.api.getPages(`${issueEndpoint(ref)}/${kind}?per_page=100`);
    const issues: Issue[] = [];
    for (const item of raw) issues.push(await this.issue(item));
    if (new Set(issues.map(i => `${i.repositoryId}:${i.id}`)).size !== issues.length) throw new IssueContextError("response");
    return issues;
  }
}
