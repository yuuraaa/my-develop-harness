import { githubProcess, isolatedGitHubEnvironment, type GitHubProcess } from "./github-auth.js";
import { GitHubConfigError, githubTokens, type GitHubConfig } from "./github-config.js";
import type { RunStore } from "./state.js";
import type { RunEvent } from "./schemas.js";

export type GitHubFailure = "configuration" | "permission" | "request" | "response" | "transport" | "rate_limit" | "unknown" | "cancelled";
export class GitHubError extends Error {
  constructor(public readonly kind: GitHubFailure, public readonly retryAt: string | null = null, public readonly status: number | null = null) {
    super(`GitHub: ${kind}${retryAt ? `（再アクセス可能時刻: ${retryAt}）` : ""}`);
  }
}
type Response = { status: number; headers: Record<string, string>; body: string };
function response(raw: string): Response {
  const match = /^HTTP\/[^\s]+ (\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(raw);
  if (!match) throw new GitHubError("response");
  const headers: Record<string, string> = {};
  for (const line of match[2]!.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: Number(match[1]), headers, body: match[3]! };
}
function retryTime(headers: Record<string, string>, now: number): string | null {
  const after = headers["retry-after"], reset = headers["x-ratelimit-reset"];
  const value = after ? (/^\d+$/.test(after) ? now + Number(after) * 1000 : Date.parse(after))
    : reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : NaN;
  return Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? new Date(value).toISOString() : null;
}
export type GitHubRecord = { kind: GitHubFailure; attempt: number; retryAt: string | null };
/** 通信記録を既存のfsync付き保存へ接続。保存できない場合は例外で停止する。 */
export function githubRunRecorder(store: Pick<RunStore, "appendEvent">, phase: RunEvent["phase"] = "prepare") {
  return (event: GitHubRecord): Promise<void> => store.appendEvent({ timestamp: new Date().toISOString(),
    type: "github.failure", phase, data: { kind: event.kind, attempt: event.attempt, retryAt: event.retryAt } });
}
export class GitHubClient {
  private constructor(private readonly env: Record<string, string>, private readonly secrets: string[], private readonly run: GitHubProcess,
    private readonly record: (event: GitHubRecord) => Promise<void>, private readonly sleep: (ms: number) => Promise<void>, private readonly now: () => number) {}
  static async create(config: GitHubConfig, options: {
    env?: NodeJS.ProcessEnv; run?: GitHubProcess; record?: (event: GitHubRecord) => Promise<void>;
    sleep?: (ms: number) => Promise<void>; now?: () => number;
  } = {}): Promise<GitHubClient> {
    const tokens = githubTokens(config, options.env);
    const env = await isolatedGitHubEnvironment(options.env);
    env.GH_TOKEN = tokens.write;
    return new GitHubClient(env, [tokens.write, tokens.read], options.run ?? githubProcess, options.record ?? (async () => {}),
      options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))), options.now ?? Date.now);
  }
  /** doctor向け。存在・起動可否だけで権限の充足を保証しない。 */
  async checkExecutable(): Promise<void> {
    try { if ((await this.run("gh", ["--version"], this.env)).code !== 0) throw new Error(); }
    catch { throw new GitHubError("configuration"); }
  }
  private async request(method: string, endpoint: string, payload?: unknown): Promise<Response> {
    // 任意ホスト・query内認証・ghプレースホルダーを受け付けない。
    if (!/^\/(?:repos|user)(?:\/|\?|$)/.test(endpoint) || /[\x00-\x20\x7f{}#]/.test(endpoint)
      || /(?:token|authorization|password)=/i.test(endpoint)) throw new GitHubConfigError();
    const args = ["api", "--hostname", "github.com", "--include", "--method", method,
      "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10", endpoint];
    let input: string | undefined;
    if (payload !== undefined) { input = JSON.stringify(payload); args.push("--input", "-"); }
    for (let attempt = 1; attempt <= 3; attempt++) {
      let failure: GitHubError;
      let result;
      try { result = await this.run("gh", args, this.env, input); }
      catch { throw new GitHubError("configuration"); }
      let res: Response | undefined;
      try { res = response(result.stdout); } catch { /* 受信の途中切断を含む。不明な更新は照合へ渡す。 */ }
      if (result.code === 2) {
        // ghの終了2はキャンセル。更新が実行済みの可能性を残し、読み取りも再試行しない。
        failure = new GitHubError(method === "GET" ? "cancelled" : "unknown");
      } else if (res && res.status >= 200 && res.status < 300) {
        if (result.code === 0) {
          for (const secret of this.secrets) res.body = res.body.split(secret).join("[REDACTED]");
          return res;
        }
        // 成功ヘッダーの後でも本文受信中に切断し得る。終了失敗だけで更新失敗と断定しない。
        failure = new GitHubError(method === "GET" ? "transport" : "unknown");
      } else if (result.code === 4) {
        failure = new GitHubError("permission");
      } else if (res) {
        if (res.status === 429 || res.status === 403 && (res.headers["x-ratelimit-remaining"] === "0" || !!res.headers["retry-after"] || /(?:secondary |API )?rate limit/i.test(res.body))) {
          failure = new GitHubError("rate_limit", retryTime(res.headers, this.now()));
        } else if (res.status === 401 || res.status === 403) failure = new GitHubError("permission");
        else if (res.status >= 500 || res.status === 408) failure = new GitHubError(method === "GET" ? "transport" : "unknown");
        else failure = new GitHubError("request", null, res.status);
      } else {
        failure = new GitHubError(method !== "GET" ? "unknown" : result.code === 0 ? "response" : "transport");
      }
      await this.record({ kind: failure.kind, attempt, retryAt: failure.retryAt });
      if (failure.kind !== "transport" || attempt === 3) throw failure;
      await this.sleep(1000 * attempt);
    }
    throw new GitHubError("transport");
  }
  async get<T = unknown>(endpoint: string): Promise<T> {
    const res = await this.request("GET", endpoint);
    try { return JSON.parse(res.body) as T; } catch { throw new GitHubError("response"); }
  }
  /** 全ページを順次取得。本文の型検証・文脈総量制限は利用側で行う。 */
  async getPages<T = unknown>(endpoint: string): Promise<T[]> {
    const items: T[] = [], seen = new Set<string>();
    let next: string | null = endpoint;
    while (next !== null) {
      if (seen.has(next)) throw new GitHubError("response");
      seen.add(next);
      const res = await this.request("GET", next);
      let page: unknown;
      try { page = JSON.parse(res.body); } catch { throw new GitHubError("response"); }
      if (!Array.isArray(page)) throw new GitHubError("response");
      items.push(...page as T[]);
      const link = res.headers.link?.split(",").find(part => /rel="next"/.test(part));
      next = null;
      if (link) {
        const target = /<([^>]+)>/.exec(link)?.[1];
        if (!target) throw new GitHubError("response");
        let url: URL;
        try { url = new URL(target, "https://api.github.com"); } catch { throw new GitHubError("response"); }
        if (url.origin !== "https://api.github.com" || url.username || url.password || url.hash) throw new GitHubError("response");
        next = url.pathname + url.search;
      }
    }
    return items;
  }
  /** 応答不明は照合へ渡す。照合失敗・未確認でも同じ更新を再送しない。 */
  async update<T = unknown>(method: "POST" | "PATCH" | "PUT" | "DELETE", endpoint: string, payload: unknown,
    reconcile?: () => Promise<{ confirmed: true; value: T } | { confirmed: false }>): Promise<T | undefined> {
    let res;
    try { res = await this.request(method, endpoint, payload); }
    catch (error) {
      if (error instanceof GitHubError && error.kind === "unknown" && reconcile) {
        const confirmed = await reconcile();
        if (confirmed.confirmed) return confirmed.value;
      }
      throw error;
    }
    if (!res.body.trim()) return undefined;
    try { return JSON.parse(res.body) as T; }
    catch {
      await this.record({ kind: "unknown", attempt: 1, retryAt: null });
      if (reconcile) { const confirmed = await reconcile(); if (confirmed.confirmed) return confirmed.value; }
      throw new GitHubError("unknown");
    }
  }
}
