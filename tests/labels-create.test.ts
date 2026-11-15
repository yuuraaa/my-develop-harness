import { describe, expect, it } from "bun:test";
import { parseGitHubConfig } from "../src/github-config.js";
import { GitHubClient } from "../src/github.js";
import { createRepositoryLabels, type LabelCreateResult } from "../src/labels-create.js";
import type { GitHubProcess } from "../src/github-auth.js";

const config = (labels = {}) => parseGitHubConfig({ schemaVersion: 2,
  github: { writeTokenEnv: "WRITE", readTokenEnv: "READ", labels } }, "/tmp/config.json");
const env = { WRITE: "private-writer", READ: "private-reader", GH_TOKEN: "ambient" };
const reply = (status: number, body: unknown, headers = "") => ({
  code: status < 300 ? 0 : 1, stderr: "",
  stdout: `HTTP/2 ${status} Response\r\nContent-Type: application/json\r\n${headers}\r\n${JSON.stringify(body)}`,
});

describe("リポジトリラベルの明示作成", () => {
  it("全ページを照合し、大小文字違いを含む既存ラベルを保持して不足分だけ作成、再実行は全スキップ", async () => {
    const c = config({ enabled: "custom:enabled", ready: "custom:ready" });
    const existing = [{ name: "CUSTOM:ENABLED", color: "123456", description: "維持する説明" },
      { name: "custom:ready", color: "abcdef", description: "手動設定" }];
    const before = structuredClone(existing), posts: unknown[] = [], gets: string[] = [];
    const client = await GitHubClient.create(c, { env, run: async (program, args, auth, input) => {
      expect(program).toBe("gh");
      expect(auth.GH_TOKEN).toBe(env.WRITE);
      expect(auth.READ).toBeUndefined(); expect(auth.WRITE).toBeUndefined();
      expect(args).toContain("github.com");
      const endpoint = args.find(arg => arg.startsWith("/repos/"))!;
      if (input) {
        expect(args[args.indexOf("--method") + 1]).toBe("POST");
        expect(endpoint).toBe("/repos/o/r/labels");
        const value = JSON.parse(input); posts.push(value);
        existing.push(value);
        return reply(201, value);
      }
      gets.push(endpoint);
      return endpoint.includes("page=2")
        ? reply(200, existing.slice(1))
        : reply(200, existing.slice(0, 1), 'Link: <https://api.github.com/repos/o/r/labels?page=2>; rel="next"\r\n');
    } });
    const results: LabelCreateResult[] = [];
    await createRepositoryLabels(client, "O/R", c.github.labels, r => results.push(r));
    expect(gets).toEqual(["/repos/o/r/labels?per_page=100", "/repos/o/r/labels?page=2"]);
    expect(posts).toEqual(["running", "blocked", "stopped", "review"].map(role => ({ name: `harness:${role}`, color: "ededed" })));
    expect(existing.slice(0, 2)).toEqual(before);
    expect(results.map(r => r.status)).toEqual(["skipped", "skipped", "created", "created", "created", "created"]);
    results.length = 0;
    await createRepositoryLabels(client, "o/r", c.github.labels, r => results.push(r));
    expect(posts).toHaveLength(4);
    expect(results).toHaveLength(6);
    expect(results.every(r => r.status === "skipped")).toBe(true);
  });

  it.each([true, false])("422競合は存在を再確認した場合のみスキップ（存在=%s）", async present => {
    let gets = 0, posts = 0;
    const c = config(), results: LabelCreateResult[] = [];
    const client = await GitHubClient.create(c, { env, run: async (_p, _a, _e, input) => {
      if (input) { posts++; return reply(422, {}); }
      gets++;
      return reply(200, gets === 1 ? [] : present ? Object.values(c.github.labels).map(name => ({ name })) : []);
    } });
    const operation = createRepositoryLabels(client, "o/r", c.github.labels, r => results.push(r));
    if (present) {
      await operation;
      expect(results.every(r => r.status === "skipped")).toBe(true);
    } else {
      await expect(operation).rejects.toMatchObject({ status: 422 });
      expect(results).toEqual([]);
    }
    expect(posts).toBe(present ? 6 : 1);
  });

  it.each([true, false])("作成応答不明は再送せず存在照合する（存在=%s）", async present => {
    let posts = 0, gets = 0;
    const c = config(), results: LabelCreateResult[] = [];
    const client = await GitHubClient.create(c, { env, run: async (_p, _a, _e, input) => {
      if (input) { posts++; return { code: 1, stdout: "", stderr: "通信切断" }; }
      gets++;
      return reply(200, gets > 1 && present ? Object.values(c.github.labels).map(name => ({ name })) : []);
    } });
    const operation = createRepositoryLabels(client, "o/r", c.github.labels, r => results.push(r));
    if (present) { await operation; expect(results).toHaveLength(6); }
    else { await expect(operation).rejects.toMatchObject({ kind: "unknown" }); expect(results).toEqual([]); }
    expect(posts).toBe(present ? 6 : 1);
  });

  it.each([403, 429, 404])("取得エラー%sでは作成しない", async status => {
    const run: GitHubProcess = async (_p, _a, _e, input) => {
      expect(input).toBeUndefined(); return reply(status, {});
    };
    const c = config(), client = await GitHubClient.create(c, { env, run });
    await expect(createRepositoryLabels(client, "o/r", c.github.labels, () => {})).rejects.toThrow();
  });

  it("不正な一覧応答では作成しない", async () => {
    const c = config(), client = await GitHubClient.create(c, { env, run: async (_p, _a, _e, input) => {
      expect(input).toBeUndefined(); return reply(200, [{ color: "ededed" }]);
    } });
    await expect(createRepositoryLabels(client, "o/r", c.github.labels, () => {})).rejects.toMatchObject({ kind: "response" });
  });
});
