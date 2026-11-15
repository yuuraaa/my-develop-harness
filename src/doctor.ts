import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspectCodexHome, inspectWritableDirectory } from "./codex-home.js";
import { resolveCodexPath } from "./codex-path.js";
import { environmentSecrets, redact } from "./state.js";
import { loadGitHubConfig, githubTokens, GitHubConfigError } from "./github-config.js";
import { GitHubClient, GitHubError } from "./github.js";
import { inspectIssue } from "./github-diagnostics.js";
import { normalizeIssueReference, type IssueApi } from "./github-issue.js";
import { WorkspaceError } from "./github-workspace-store.js";

export type Diagnostic = { id: string; status: "正常" | "警告" | "異常" | "未確認"; reason: string; remedy: string; required: boolean };
export type DoctorReport = { items: Diagnostic[]; exitCode: 0 | 1 };
export type CommandResult = { code: number | null; stdout: string; timedOut: boolean; failed: boolean };
export type DoctorOptions = {
  cwd: string; root: string; configPath: string; env: NodeJS.ProcessEnv; repo?: string; issue?: string;
  command?: typeof doctorCommand; api?: IssueApi; inspect?: typeof inspectIssue;
};
export function doctorCommand(program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise(resolve => {
    execFile(program, args, { cwd, env: { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 65_536, encoding: "utf8" }, (error, stdout) => {
      resolve({ code: error ? typeof error.code === "number" ? error.code : null : 0,
        stdout, timedOut: !!error?.killed && error.signal === "SIGKILL", failed: !!error });
    });
  });
}
export async function diagnose(options: DoctorOptions): Promise<DoctorReport> {
  const items: Diagnostic[] = [], { env, cwd, root } = options;
  const secrets = environmentSecrets(env);
  const add = (id: string, status: Diagnostic["status"], reason: string, remedy = "不要", required = true) => items.push({ id, status, reason, remedy, required });
  const check = async <T>(id: string, action: () => Promise<T>, remedy: string): Promise<T | undefined> => {
    try { const value = await action(); add(id, "正常", "確認できました"); return value; }
    catch (error) {
      add(id, "異常", error instanceof GitHubConfigError || error instanceof GitHubError || error instanceof WorkspaceError ? error.message : "形式不正・読取不能・起動失敗（生の応答は非表示）", remedy);
      return undefined;
    }
  };
  const config = await check("config", () => loadGitHubConfig(options.configPath), "schemaVersion: 2のexamples/github-config.example.jsonを参照してください。");
  if (config) await check("github.tokens", async () => { const tokens = githubTokens(config, env); secrets.push(tokens.read, tokens.write); return tokens; }, "明示した書き込み用・読み取り用の異なる認証環境変数を設定してください。");
  const command = options.command ?? doctorCommand;
  const execute = async (id: string, program: string, args: string[]) => check(id, async () => {
    const result = await command(program, args, cwd, env);
    if (result.failed || result.code !== 0 || !result.stdout.trim()) throw new Error();
    return true;
  }, `${program}をPATHへ配置し、実行権限を確認してください。ghは通常版・単一バイナリとも外部依存です。`);
  await execute("gh.version", "gh", ["--version"]);
  await execute("git.version", "git", ["--version"]);
  const codex = await check("codex.path", () => resolveCodexPath(env, true), "HARNESS_CODEX_PATHまたはPATHにCodex CLIを配置してください。");
  if (codex) await execute("codex.version", codex, ["--version"]);
  for (const item of await inspectCodexHome({ userHome: env.HOME ?? homedir(), ...(config?.execution?.codexHome ? { codexHome: config.execution.codexHome } : {}) })) items.push({ ...item, required: true });
  for (const name of ["", "runs", "worktrees"]) await check(`storage.${name || "root"}`, () => inspectWritableDirectory(join(root, name)), "既存の保存先または祖先の権限を確認してください。診断では作成しません。");
  if (config) {
    add("watch.repositories", config.watch.repositories.length ? "正常" : "警告", `監視先: ${config.watch.repositories.join(", ") || "未指定（watch不可、手動runは利用可）"}`, "watch.repositoriesに監視先を明示列挙してください。", false);
    await check("github.read-access", async () => {
      // read認証をwrite欄へ入れたクライアントもGETだけを使い、両認証の可視性を確認する。
      const swapped = { ...config, github: { ...config.github, writeTokenEnv: config.github.readTokenEnv, readTokenEnv: config.github.writeTokenEnv } };
      const read = options.api ?? await GitHubClient.create(swapped, { env });
      await read.get("/user");
      const repos = options.issue ? [normalizeIssueReference(options.issue).repository] : config.watch.repositories;
      for (const repository of repos) await read.get(`/repos/${repository}`);
      return true;
    }, "読み取り用認証の対象リポジトリ可視性を確認してください。書き込み権限の分離は発行側で保証してください。");
    const api = await check("github.write-access", async () => {
      const client = options.api ?? await GitHubClient.create(config, { env });
      await client.get("/user"); return client;
    }, "書き込み用の明示認証とGitHub接続を確認してください。読み取り成功だけで更新成功は保証しません。");
    if (api && options.issue) {
      const result = await check("issue.context", () => (options.inspect ?? inspectIssue)({ api, config, root, issue: options.issue!, env,
        ...(options.repo ? { repositoryPath: options.repo } : {}) }), "Issue・repo/push remote・必要資料・保存済み対応記録を確認してください。");
      if (result) {
        add("issue.eligibility", result.eligibility.status === "ready" ? "正常" : "警告", result.eligibility.reasons.join(" / ") || "着手条件を満たします", "待機理由を解消すると次のwatch周期で再評価します。", false);
        if (result.selection) add("issue.repository", "正常", `repo: ${result.selection.path ?? `clone予定先 ${result.selection.destination}`} / push remote: ${result.selection.pushRemote} / 開始SHA: ${result.startCommit}`);
        if (result.previousRunId) add("issue.restart", "正常", `再利用元: ${result.previousRunId} / 実worktree: ${result.worktreePath}`);
        for (const warning of result.warnings) add("issue.history", "警告", warning, "必要に応じて記録を確認してください。", false);
      }
    } else if (!options.issue) add("issue.context", "未確認", "Issue指定時にrepo/push先・資料・依存待ちを診断します", "doctor 'owner/repo#番号' [--repo パス]を実行してください。", false);
  }
  add("limits", "正常", "開発時の統合検証は実施済みです。doctorは現在の環境の接続と前提条件を診断します。", "不要", false);
  return { items: items.map(item => ({ ...item, reason: redact(item.reason, secrets), remedy: redact(item.remedy, secrets) })),
    exitCode: items.some(item => item.status === "異常" || item.required && item.status === "未確認") ? 1 : 0 };
}
export function formatDoctor(report: DoctorReport, json = false): string {
  return json ? JSON.stringify(report, null, 2) + "\n" : report.items.map(item => `[${item.status}] ${item.id}: ${item.reason}${item.status === "正常" ? "" : `\n  対処: ${item.remedy}`}`).join("\n") + "\n";
}
