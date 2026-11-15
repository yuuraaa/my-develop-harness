import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeCli } from "../src/cli.js";
import { GitHubError } from "../src/github.js";
import type { LabelCreateApi } from "../src/labels-create.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "github-cli-")); roots.push(root);
  const out: string[] = [], err: string[] = [];
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 2, github: {}, watch: { repositories: ["o/r"] } }));
  const options = { root, cwd: root, env: { HARNESS_GITHUB_READ_TOKEN: "reader-private", HARNESS_GITHUB_WRITE_TOKEN: "writer-private" }, stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) };
  return { root, out, err, config, options };
}
describe("公開CLIのGitHub専用契約", () => {
  it("labels createは--configの6種類を使い、作成・スキップを表示して実行記録を作らない", async () => {
    const f = await setup(), custom = join(f.root, "custom.json");
    const labels = { enabled: "custom:enabled", ready: "custom:ready", running: "custom:running",
      blocked: "custom:blocked", stopped: "custom:stopped", review: "custom:review" };
    await writeFile(custom, JSON.stringify({ schemaVersion: 2, github: { labels } }));
    const posts: unknown[] = [];
    const labelsApi: LabelCreateApi = {
      getPages: async <T,>(endpoint: string) => {
        expect(endpoint).toBe("/repos/o/r/labels?per_page=100");
        return [{ name: "CUSTOM:ENABLED" }] as T[];
      },
      update: async <T,>(method: string, endpoint: string, payload: unknown) => {
        expect(method).toBe("POST"); expect(endpoint).toBe("/repos/o/r/labels");
        posts.push(payload); return payload as T;
      },
    };
    expect(await executeCli(["--config", "custom.json", "labels", "create", "O/R"], { ...f.options, labelsApi })).toBe(0);
    expect(posts).toHaveLength(5);
    const text = f.out.join("");
    expect(text).toContain("リポジトリ: o/r");
    expect(text).toContain("スキップ（既存）: custom:enabled");
    expect(text).toContain("作成: custom:review");
    expect(text).not.toContain("run ID:");
    expect((await readdir(f.root)).sort()).toEqual(["config.json", "custom.json"]);
  });
  it.each(["o", "o/r/extra", "https://github.com/o/r", "o/r#1", "../r", "o/r?x", "o/.."])("labels createの不正repo %sをAPI呼び出し前に拒否", async repo => {
    const f = await setup();
    const labelsApi: LabelCreateApi = { getPages: async () => { throw new Error("呼び出し禁止"); },
      update: async () => { throw new Error("呼び出し禁止"); } };
    expect(await executeCli(["labels", "create", repo], { ...f.options, labelsApi })).toBe(2);
    expect(f.err.join("")).toContain("OWNER/REPO");
  });
  it("labels createは認証不備を拒否し、APIエラー時は終了1と途中結果を表示", async () => {
    const f = await setup();
    const labelsApi: LabelCreateApi = {
      getPages: async <T,>() => [{ name: "harness:enabled" }] as T[],
      update: async () => { throw new GitHubError("permission"); },
    };
    expect(await executeCli(["labels", "create", "o/r"], { ...f.options, env: {}, labelsApi })).toBe(2);
    expect(f.out).toEqual([]);
    expect(await executeCli(["labels", "create", "o/r"], { ...f.options, labelsApi })).toBe(1);
    expect(f.out.join("")).toContain("スキップ（既存）: harness:enabled");
    expect(f.err.join("")).toContain("GitHub: permission");
  });
  it.each([["labels", "create"], ["labels", "create", "o/r", "extra"]].map(args => ({ args })))("labels createの引数不足・余分な引数を拒否 %s", async ({ args }) => {
    const f = await setup();
    expect(await executeCli(args, f.options)).toBe(2);
  });
  it("新設定のrunはIssueを正規化して既存のIssueワークフローを呼ぶ", async () => {
    const f = await setup(); let issue: string | undefined;
    expect(await executeCli(["run", "o/r#3", "--no-progress"], { ...f.options, issueRun: async input => { issue = input.issue; return "completed"; } })).toBe(0);
    expect(issue).toBe("o/r#3"); expect(f.out.join("")).toContain("run ID:");
  });
  it.each([["run", "1"], ["run", "o/r#1", "--branch", "feature/old"], ["doctor", "1"], ["watch", "--interval", "0"]].map(args => ({ args })))("不正引数%sは記録を作らず拒否", async ({ args }) => {
    const f = await setup(); expect(await executeCli(args, f.options)).toBe(2);
    expect(await readdir(f.root)).toEqual(["config.json"]);
  });
  it("不正設定に設定例を表示して停止する", async () => {
    const f = await setup(), old = JSON.stringify({ unexpected: true }); await writeFile(f.config, old);
    expect(await executeCli(["run", "o/r#1"], f.options)).toBe(2);
    expect(f.err.join("")).toContain("schemaVersion: 2"); expect(f.err.join("")).toContain("github-config.example.json");
    expect(await readdir(f.root)).toEqual(["config.json"]);
  });
  it("ヘルプはIssue/監視設定/外部ghを案内する", async () => {
    const f = await setup(); expect(await executeCli(["--help"], f.options)).toBe(0);
    const text = f.out.join(""); expect(text).toContain("watch.repositories"); expect(text).toContain("外部依存"); expect(text).toContain("owner/repo#");
  });
});
