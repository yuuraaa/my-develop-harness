import { githubStateSchema } from "./github-state.js";
import { loadShowModel } from "./show-model.js";
import { loadShowSettings } from "./show-settings.js";
import { runShowTui } from "./show-tui.js";
import type { ShowModel } from "./show-model.js";
import type { ShowSettings } from "./show-settings.js";
import { Command, CommanderError } from "commander";
import { watchIssues, runIsolatedIssue } from "./watch.js";
import { harnessVersion } from "./version.js";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { RunStore, StorageError, newRunId, redact, environmentSecrets } from "./state.js";
import { runIdSchema } from "./schemas.js";
import type { RunState } from "./schemas.js";
import { CodexHomeError } from "./codex-home.js";
import { RunProgress } from "./progress.js";
import { retrospective, pageRetrospective, ShowArgumentError } from "./retrospective.js";
import { collectHistory, formatHistory } from "./history.js";
import type { HistoryOptions } from "./history.js";
import { diagnose, formatDoctor } from "./doctor.js";
import { loadGitHubConfig, githubTokens, GitHubConfigError, repositoryNameSchema } from "./github-config.js";
import { normalizeIssueReference, IssueContextError } from "./github-issue.js";
import { runIssueWorkflow, type IssueRunOptions } from "./github-workflow.js";
import { GitHubClient, GitHubError } from "./github.js";
import { createRepositoryLabels, type LabelCreateApi } from "./labels-create.js";
import { WorkspaceError } from "./github-workspace-store.js";
import { WorkflowError } from "./workflow-error.js";
import type { GitHubWorkflowStopped } from "./github-control.js";

export type ExitCode = 0 | 1 | 2;
export type CliOptions = {
  labelsApi?: LabelCreateApi;
  issueRun?: (options: IssueRunOptions) => Promise<"running" | "completed" | "stopped" | "blocked">;
  watchApi?: import("./github-issue.js").IssueApi;
  inspectIssue?: typeof import("./github-diagnostics.js").inspectIssue;
  root?: string; cwd?: string; env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void; stderr?: (text: string) => void;
  stdoutIsTTY?: boolean;
  stdinIsTTY?: boolean;
  pager?: (text: string) => Promise<void>;
  showTui?: (model: ShowModel, settings: ShowSettings) => Promise<void>;
};

export async function displayStatus(store: RunStore): Promise<string> {
  const github = await readFile(join(store.runPath, "state.json"), "utf8")
    .then(text => githubStateSchema.parse(JSON.parse(text))).catch(() => undefined);
  if (!github || github.runId !== store.runId) throw new StorageError("corrupt");
  const warnings: string[] = [];
  const names = await readdir(store.artifactsPath).catch(() => [] as string[]);
  for (const name of names) {
    if (name.endsWith(".pending") || name.endsWith(".tmp")) warnings.push(`未確定ファイル: ${name}`);
    const command = /^verification-([1-4])\.command-(\d+)\.json$/.exec(name);
    if (command) {
      try { await store.loadVerificationCommand(Number(command[1]), Number(command[2])); }
      catch { warnings.push(`成果物が破損・未確定: ${name}`); }
    }
  }
  return [`形式: GitHub`, `run ID: ${github.runId}`, `Issue: ${github.issue.url}`, `状態: ${github.status}`,
    `フェーズ: ${github.phase} (${github.phaseStatus})`, `記録: ${store.runPath}`, `成果物: ${store.artifactsPath}`,
    `worktree: ${github.worktreePath ?? "未確定"}`, `再利用元: ${github.previousRunId ?? "なし"}`,
    `成果ブランチ: ${github.branchName ?? "未確定"}`, `作業ブランチ: ${github.workBranchName ?? "未確定"}`,
    `成果コミット: ${github.resultCommits.join(", ") || "なし"}`, `着手反映: ${github.startTransition}`,
    `停止反映: ${github.stopReflection.status}${github.stopReflection.message ? ` (${github.stopReflection.message})` : ""}`,
    `停止理由: ${github.error?.message ?? "なし"}`, ...warnings.map(w => `注意: ${w}`)].join("\n") + "\n";
}

export async function executeCli(args = process.argv.slice(2), options: CliOptions = {}): Promise<ExitCode> {
  const root = options.root ?? join(homedir(), ".harness");
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const secrets = environmentSecrets(env);
  const out = (value: string) => (options.stdout ?? (text => process.stdout.write(text)))(redact(value, secrets));
  const err = (value: string) => (options.stderr ?? (text => process.stderr.write(text)))(redact(value, secrets));
  const program = new Command().name("harness").description("GitHub Issue の開発ハーネス").exitOverride()
    .version(harnessVersion, "--version", "ハーネスのバージョンを表示")
    .option("--config <path>", "非秘密設定ファイル").configureOutput({ writeOut: out, writeErr: () => {} })
    .addHelpText("after", `
実行例:
  harness watch
  harness watch --dry-run
  harness run https://github.com/owner/repo/issues/123 --repo /path/to/repository
  harness run 'owner/repo#123'
  harness status 00000000-0000-4000-8000-000000000001
  harness show 00000000-0000-4000-8000-000000000001 --phase review:1
  harness history --issue 'owner/repo#123' --status stopped --limit 10
  harness history --all
  harness labels create owner/repo
  harness doctor
  harness doctor 'owner/repo#123' --repo /path/to/repository --json
  harness --config /path/to/config.json run 'owner/repo#123' --repo /path/to/repository

Issue URLまたはowner/repo#番号を指定します。
run IDはrun開始時に発行されるUUIDで、Issue番号とは別です。statusには表示されたrun IDを指定します。
watchは設定watch.repositoriesの明示一覧のみを監視します。ghは通常版・単一バイナリとも外部依存です。
historyは実行一覧、statusは保存された現在状態、showは実行の振り返りです。
--repoは対象リポジトリを指定します（省略時は設定した探索先から自動選択）。
--configは設定ファイルを指定します（既定: ~/.harness/config.json）。記録先は変更しません。
`);
  let code: ExitCode = 1;
  const storeFor = (id: string) => {
    if (!runIdSchema.safeParse(id).success) throw new GitHubConfigError();
    return new RunStore(id, root, secrets);
  };
  program.command("labels").description("リポジトリのラベルを準備")
    .command("create <repository>").description("設定github.labelsの6種類を不足分だけ作成（既存は変更しない）")
    .addHelpText("after", "\n例: harness labels create owner/repo\n    harness --config /path/to/config.json labels create owner/repo\n")
    .action(async (repository: string) => {
      const parsed = repositoryNameSchema.safeParse(repository);
      if (!parsed.success) { err("リポジトリをOWNER/REPO形式で指定してください。\n"); code = 2; return; }
      const config = await loadGitHubConfig(resolve(cwd, program.opts<{ config?: string }>().config ?? join(root, "config.json")));
      const tokens = githubTokens(config, env);
      secrets.push(tokens.read, tokens.write);
      const api = options.labelsApi ?? await GitHubClient.create(config, { env });
      out(`リポジトリ: ${parsed.data}\n`);
      await createRepositoryLabels(api, parsed.data, config.github.labels, result =>
        out(`${result.status === "created" ? "作成" : "スキップ（既存）"}: ${result.name}\n`));
      code = 0;
    });
  program.command("doctor [issue]").description("GitHub前提の起動前診断（読み取り専用）")
    .option("--repo <path>", "Git診断対象（省略時は設定から探索）")
    .option("--json", "診断結果をJSON表示")
    .action(async (issue: string | undefined, flags: { repo?: string; json?: boolean }) => {
      if (issue !== undefined) normalizeIssueReference(issue);
      if (flags.repo === "") throw new GitHubConfigError();
      const report = await diagnose({ cwd, root, env,
        configPath: resolve(cwd, program.opts<{ config?: string }>().config ?? join(root, "config.json")),
        ...(issue !== undefined ? { issue } : {}),
        ...(flags.repo !== undefined ? { repo: resolve(cwd, flags.repo) } : {}),
      });
      out(formatDoctor(report, flags.json)); code = report.exitCode;
    });
  program.command("run <issue>").description("Issue URLまたはowner/repo#番号から実行").option("--repo <path>", "対象リポジトリ（省略時は設定から自動探索）")
    .option("--no-progress", "進捗を非表示（既定: 表示。run ID・最終結果・記録先・エラーは表示）")
    .action(async (id: string, flags: { repo?: string; progress: boolean }) => {
      normalizeIssueReference(id);
      if (flags.repo === "") throw new GitHubConfigError();
      const config = await loadGitHubConfig(resolve(cwd, program.opts<{ config?: string }>().config ?? join(root, "config.json")));
      const tokens = githubTokens(config, env);
      secrets.push(tokens.read, tokens.write);
      const store = new RunStore(newRunId(), root, [...secrets, tokens.read, tokens.write]);
      out(`run ID: ${store.runId}\n`);
      const progress = new RunProgress(store, id, out, { enabled: flags.progress,
        isTTY: options.stdoutIsTTY ?? (options.stdout ? false : process.stdout.isTTY === true) });
      try {
        let stopped: GitHubWorkflowStopped | undefined;
        const status = await (options.issueRun ?? runIssueWorkflow)({ store, config, issue: id, env,
          onStopped: value => { stopped = value; },
          ...(flags.repo !== undefined ? { repositoryPath: resolve(cwd, flags.repo) } : {}) });
        const state = stopped?.state ?? await store.loadGitHubState().catch(() => undefined);
        progress.finish(status, state?.error?.message);
        if (stopped?.recordingFailures.length) err(`ローカル停止は確定しましたが記録保存に失敗: ${stopped.recordingFailures.join(", ")}。途中成果と記録を確認してください。\n`);
        if (state) {
          if (state.startTransition === "unknown" || state.startTransition === "failed") err(`着手ラベル反映: ${state.startTransition}。記録とGitHubラベルを確認してください。\n`);
          if (["failed", "unknown"].includes(state.stopReflection.status)) err(`GitHub停止反映: ${state.stopReflection.status} (${state.stopReflection.message})\n`);
          if (state.error) err(`${state.error.message}\n`);
          if (state.submissionArtifact) {
            try {
              const { submissionSchema } = await import("./github-submission.js");
              const submitted = submissionSchema.parse(JSON.parse(await readFile(join(store.artifactsPath, "submission.json"), "utf8")));
              out(`提出結果: push=${submitted.push.status}, comment=${submitted.comment.status}, review=${submitted.reviewState.status}\n`);
              if (status !== "completed") err(`提出記録: ${join(store.artifactsPath, "submission.json")}。in_flight/unknownは成功未確認です。公開先と保存証拠を確認してください。\n`);
            } catch { err(`提出記録を読み取れません: ${join(store.artifactsPath, "submission.json")}。公開先と残った操作意図を確認してください。\n`); }
          }
          const diagnostic = await store.stoppedCodexMessage(state);
          if (diagnostic) err(`Codexエラー: ${diagnostic}\n`);
        } else if (status !== "completed") err(`着手前に停止しました。${store.artifactsPath} の取得・準備記録を確認してください。\n`);
        code = status === "completed" ? 0 : 1;
      } finally { progress.close(); }
    });
  program.command("watch").description("明示した複数リポジトリのIssueを逐次実行（失敗時停止）")
    .option("--interval <seconds>", "空一覧時の取得間隔（正の整数秒、既定60）", "60")
    .option("--dry-run", "1回だけ候補順・選択Issue・リポジトリ予定先を読み取り表示")
    .addHelpText("after", "\nreview提出成功後だけ最新一覧を即時取得します。Ctrl+Cは待機を中断し、実行中Issueの終了を待ちます。\n探索は設定から行い、cwdによる絞り込みはしません。dry-runは取得・更新・実行の成功を保証しません。\n例: harness watch --interval 60\n    harness --config /path/to/config.json watch --dry-run\n")
    .action(async (flags: { interval: string; dryRun?: boolean }) => {
      if (!/^[1-9]\d*$/.test(flags.interval) || !Number.isSafeInteger(Number(flags.interval))) throw new GitHubConfigError();
      const stop = new AbortController();
      let running = false;
      const interrupt = () => {
        if (stop.signal.aborted) return;
        stop.abort();
        out(running ? "停止要求: 実行中Issueの終了待ち\n" : "停止要求: 新規着手を停止\n");
      };
      process.on("SIGINT", interrupt);
      try {
        const configPath = resolve(cwd, program.opts<{ config?: string }>().config ?? join(root, "config.json"));
        const config = await loadGitHubConfig(configPath);
        const tokens = githubTokens(config, env);
        secrets.push(tokens.read, tokens.write);
        code = await watchIssues({ interval: Number(flags.interval), dryRun: flags.dryRun === true, signal: stop.signal,
          config, root, env, out,
          ...(options.watchApi ? { api: options.watchApi } : {}),
          ...(options.inspectIssue ? { inspect: options.inspectIssue } : {}),
          run: async issue => {
            if (stop.signal.aborted) return "completed";
            running = true;
            try {
              return await runIsolatedIssue({ issue, configPath, cwd, env, out, err });
            } finally { running = false; }
          },
        });
      } finally { process.removeListener("SIGINT", interrupt); }
    });
  program.command("history").description("保存済みの実行履歴を最終更新日時の降順で表示（認証・設定・外部接続不要）")
    .option("--issue <issue>", "Issue URLまたはowner/repo#番号で絞り込み")
    .option("--status <status>", "running / completed / stopped / blockedで絞り込み")
    .option("--limit <count>", "表示件数（正の整数、既定20件）")
    .option("--all", "全件表示（--limitと併用不可）")
    .addHelpText("after", `\n絞り込み・整列後に件数制限します。読取不能のrun IDは別途すべて表示します。\ncompletedは提出成功で、Issueのcloseとは異なります。\nrunningは保存状態であり、現在のプロセス稼働を保証しません。フェーズは最後の保存値です。\n詳細: harness status <run-id>\n`)
    .action(async (flags: { issue?: string; status?: string; limit?: string; all?: boolean }) => {
      if ((flags.status !== undefined && !githubStateSchema.shape.status.safeParse(flags.status).success)
        || (flags.limit !== undefined && (!/^[1-9]\d*$/.test(flags.limit) || !Number.isSafeInteger(Number(flags.limit))))
        || (flags.all && flags.limit !== undefined)) throw new GitHubConfigError();
      const filters: HistoryOptions = {};
      if (flags.issue !== undefined) filters.issue = normalizeIssueReference(flags.issue).url;
      if (flags.status !== undefined) filters.status = flags.status as RunState["status"];
      if (flags.limit !== undefined) filters.limit = Number(flags.limit);
      if (flags.all) filters.all = true;
      out(formatHistory(await collectHistory(root), filters, secrets)); code = 0;
    });
  program.command("status <run-id>").description("保存記録を読み取り専用で表示")
    .action(async (id: string) => { out(await displayStatus(storeFor(id))); code = 0; });
  program.command("show <run-id>").description("保存記録を工程一覧TUIで振り返る（設定なし可・認証/AI/外部接続不要）")
    .option("--phase <phase[:N]>", "フェーズ詳細（planは全体、plan:Nは試行別 / implementation / review:1 / fix:1 / verification:1 / commit / report）")
    .option("--log <command-id>", "verification:Nの保存済みstdout・stderr")
    .option("--no-pager", "TUI・ページャーを使わず直接テキスト出力")
    .action(async (id: string, flags: { phase?: string; log?: string; pager: boolean }) => {
      if (flags.pager && flags.phase === undefined && flags.log === undefined
        && (options.stdinIsTTY ?? process.stdin.isTTY === true)
        && (options.stdoutIsTTY ?? (options.stdout ? false : process.stdout.isTTY === true))) {
        const model = await loadShowModel(root, id, secrets);
        const settings = await loadShowSettings(resolve(cwd, program.opts<{ config?: string }>().config ?? join(root, "config.json")));
        await (options.showTui ?? runShowTui)(model, settings);
        code = 0; return;
      }
      const text = await retrospective(root, id, flags, undefined, secrets);
      await pageRetrospective(text, {
        enabled: flags.pager && flags.phase !== undefined,
        stdinIsTTY: options.stdinIsTTY ?? process.stdin.isTTY === true,
        stdoutIsTTY: options.stdoutIsTTY ?? (options.stdout ? false : process.stdout.isTTY === true),
        ...(options.pager ? { pager: options.pager } : {}),
      }, out, err);
      code = 0;
    });
  try {
    if (!args.length) { out(program.helpInformation()); return 2; }
    await program.parseAsync(args, { from: "user" });
    return code;
  } catch (error) {
    if (error instanceof GitHubConfigError || error instanceof IssueContextError && error.kind === "identifier") {
      err(error instanceof GitHubConfigError ? `${error.message}\n` : "Issue URLまたはowner/repo#番号を指定してください。PRや番号のみの指定は使えません。\n");
      return 2;
    }
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    if (error instanceof ShowArgumentError) { err(`${error.message}\n`); return 2; }
    if (error instanceof GitHubError || error instanceof WorkspaceError || error instanceof WorkflowError || error instanceof IssueContextError) { err(`安全停止: ${error.message}\n`); return 1; }
    const configuration = error instanceof CommanderError;
    err(error instanceof CodexHomeError ? `${error.message}\n` : configuration ? "引数または設定エラーです。help を確認してください。\n" : `安全停止: ${error instanceof StorageError ? error.kind : "実行失敗"}（自動復旧しません）\n`);
    return configuration ? 2 : 1;
  }
}
