import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeCli } from "../src/cli.js";
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
