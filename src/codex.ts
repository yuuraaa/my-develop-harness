import { mkdtemp, mkdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Codex, type Thread, type ThreadOptions } from "@openai/codex-sdk";
import { z } from "zod";
import { StorageError } from "./state.js";
import { WorkflowError, WorkflowStopped, type DevelopmentControl, developmentIdentity, developmentBranch, developmentHead } from "./workflow.js";
import { runGit, readHeadBranch, fingerprintWorktree, fingerprintWorktreeContents, captureWorktreeTree, verifyResultCommits, type GitCommand } from "./git.js";
import { planOutputSchema, reviewSchema, reviewInputSchema, issueInputSchema,
  commitSchema, type IssueInput } from "./schemas.js";
import { CodexHomeError, initializeCodexHome, readPhaseSettings, type CodexPhase } from "./codex-home.js";
import { CodexPathError, resolveCodexPath } from "./codex-path.js";
import { applyValidationUpdates, ValidationUpdateError } from "./verification.js";
import { implementationCandidateSchema, implementationOutputSchema, validationRepairSchema, validationRepairCandidateSchema, type Implementation } from "./schemas.js";
import { diagnosticDetail, type DiagnosticDetail } from "./codex-diagnostics.js";
import { githubTokens, type GitHubConfig } from "./github-config.js";
import { checkRepositoryCredentials, isolatedGitHubEnvironment } from "./github-auth.js";

export { planSchema, planOutputSchema } from "./schemas.js";
export { reviewChecklist } from "./schemas.js";


export class CodexError extends Error {
  constructor(public readonly kind: "configuration" | "execution" | "response", public readonly safeToRetry = false, cause?: unknown) {
    super(`Codex SDK: ${kind}`, cause === undefined ? undefined : { cause });
    this.name = "CodexError";
  }
}

const inheritedCodexEnvironment = ["PATH", "HOME", "TMPDIR", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR", "OPENAI_API_KEY", "CODEX_API_KEY"] as const;

/** 編集用ホームと、対象ルールだけを持つ実行用ホームを分離する。 */
export async function createCodexConnection(options: {
  worktreePath: string;
  codexHome?: string;
  github: GitHubConfig;
  model?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PhaseConnection> {
  const source = options.env ?? process.env;
  let worktreePath: string;
  let codexHome: string;
  let token = "";
  try {
    if (!isAbsolute(options.worktreePath)) throw new Error();
    worktreePath = await realpath(options.worktreePath);
    if (!(await stat(worktreePath)).isDirectory()) throw new Error();
    if (options.github) {
      const tokens = githubTokens(options.github, source);
      // GitHub認証名は任意指定できる。別名やOpenAI認証を経由した書き込み値の継承も拒否する。
      // HOME等は初期化エラーやargvにも使うため、ファイル操作・SDK生成より前に検査する。
      for (const key of [...inheritedCodexEnvironment, "HARNESS_CODEX_PATH"]) {
        if (options.github.github.writeTokenEnv === key || source[key]?.includes(tokens.write)) throw new Error();
      }
      token = tokens.read;
    }
  } catch { throw new CodexError("configuration"); }
  const codexPathOverride = await resolveCodexPath(source);
  const initialized = await initializeCodexHome({ ...(options.codexHome ? { codexHome: options.codexHome } : {}),
    ...(source.HOME ? { userHome: source.HOME } : {}) });
  codexHome = initialized.home;
  let runtimeHome: string;
  try {
    runtimeHome = await mkdtemp(join(codexHome, "codex-run-"));
    await mkdir(join(runtimeHome, "rules"), { mode: 0o700 });
    await symlink(initialized.auth, join(runtimeHome, "auth.json"));
  } catch { throw new CodexHomeError(`${codexHome} に実行用ホームを作成できません。空き容量と書き込み権限を確認してください。`); }

  // env指定時、SDKはprocess.envを継承しない。書き込み用トークンを渡さない。
  const env: Record<string, string> = {
    CODEX_HOME: runtimeHome,
  };
  for (const key of inheritedCodexEnvironment) {
    if (source[key]) env[key] = source[key];
  }
  if (options.github) {
    Object.assign(env, await isolatedGitHubEnvironment(source, runtimeHome));
    env.GH_TOKEN = token;
    await checkRepositoryCredentials(worktreePath, env);
  }

  const prepare = async (phase: CodexPhase): Promise<PhaseConnection> => {
    // 同じruntimeを継続してセッションを保持。SDKは呼び出しごとにCLIを起動する。
    const settings = await readPhaseSettings(codexHome, phase);
    try {
      await writeFile(join(runtimeHome, "config.toml"), settings.config, { mode: 0o600 });
      await writeFile(join(runtimeHome, "rules", "active.rules"), settings.rules, { mode: 0o600 });
    } catch { throw new CodexHomeError(`${runtimeHome} にフェーズ設定を保存できません。空き容量と書き込み権限を確認してください。`); }
    let codex: Codex;
    try {
      codex = new Codex({
        ...(codexPathOverride ? { codexPathOverride } : {}),
        env,
        ...(source.CODEX_API_KEY || source.OPENAI_API_KEY ? { apiKey: source.CODEX_API_KEY || source.OPENAI_API_KEY! } : {}),
        config: {
          sandbox_workspace_write: { writable_roots: [], exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
        },
        // テーブル全体を置換し、専用ホームにある他のMCP設定を継承しない。
        configOverrides: ["mcp_servers={}", 'cli_auth_credentials_store="file"',
          ...(options.github ? [`shell_environment_policy={inherit="all",ignore_default_excludes=true,include_only=${JSON.stringify(Object.keys(env).filter(k => !["OPENAI_API_KEY", "CODEX_API_KEY"].includes(k)))},exclude=[],set={}}`] : []),
          // リポジトリや親ディレクトリの設定・rules・hooksを継承しない。
          'projects={}', 'project_root_markers=[]',
          `projects.${JSON.stringify(worktreePath)}.trust_level="untrusted"`],
      });
    } catch (error) { throw new CodexError("configuration", false, error); }
    const writable = phase === "implementation" || phase === "fix";
    const threadOptions: ThreadOptions = {
      workingDirectory: worktreePath,
      sandboxMode: writable ? "workspace-write" : "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: !!options.github,
      webSearchMode: "disabled",
      ...(options.model ? { model: options.model } : {}),
    };
    return {
      prepare,
      start: (readonly = false) => codex.startThread({ ...threadOptions, ...(readonly ? { sandboxMode: "read-only" as const } : {}) }),
      // 同一実行内の明示的な継続用。障害後の自動resumeは行わない。
      resume: (id: string, readonly = false) => {
        if (!id.trim()) throw new CodexError("configuration");
        return codex.resumeThread(id, { ...threadOptions, ...(readonly ? { sandboxMode: "read-only" as const } : {}) });
      },
    };
  };
  return prepare("plan");
}

// 生イベントのコマンド出力・MCP引数・応答は公開しない。診断は保存側でマスクする。
export type CodexObservation = {
  type: string;
  threadId?: string;
  itemType?: string;
  mcp?: { server: string; tool: string; status: string };
  diagnostic?: DiagnosticDetail;
};

/** SDK終了はターン終了の証拠だけ。正式な検証結果・Issue完了判定は返さない。 */
export async function runStructured<T extends z.ZodType>(
  thread: Pick<Thread, "id" | "runStreamed">,
  prompt: string,
  schema: T,
  observe: (event: CodexObservation) => void | Promise<void> = () => {},
  apiSchema: z.ZodType = schema,
): Promise<{ threadId: string; output: z.infer<T>; source: "codex" }> {
  let response: string | undefined;
  let completed = false;
  let observed = false;
  const outputSchema = z.toJSONSchema(apiSchema, { target: "draft-7" });
  try {
    const { events } = await thread.runStreamed(prompt, { outputSchema });
    for await (const event of events) {
      observed = true;
      const diagnostic = event.type === "error" ? diagnosticDetail("error", event)
        : event.type === "turn.failed" ? diagnosticDetail("turn.failed", event.error)
        : "item" in event && event.item.type === "error" ? diagnosticDetail("item.error", event.item)
        : "item" in event && event.item.type === "mcp_tool_call" && event.item.error ? diagnosticDetail("mcp.error", event.item.error)
        : undefined;
      await observe({
        type: event.type,
        ...(diagnostic ? { diagnostic } : {}),
        ...(event.type === "thread.started" ? { threadId: event.thread_id } : {}),
        ...("item" in event ? { itemType: event.item.type } : {}),
        ...("item" in event && event.item.type === "mcp_tool_call" ? {
          mcp: { server: event.item.server, tool: event.item.tool, status: event.item.status },
        } : {}),
      });
      if (event.type === "turn.failed" || event.type === "error") throw new CodexError("execution");
      if (event.type === "turn.completed") completed = true;
      if (event.type === "item.completed" && event.item.type === "agent_message") response = event.item.text;
    }
  } catch (error) {
    if (error instanceof StorageError || error instanceof WorkflowStopped || error instanceof WorkflowError) throw error;
    if (!(error instanceof CodexError)) await observe({ type: "exception", diagnostic: diagnosticDetail("exception", error) });
    // 接続前・spawn前の既知の一時エラーだけ再試行可。切断やイベント後は反映が不明。
    const code = (error as NodeJS.ErrnoException)?.code;
    if (!observed && ["ENOENT", "EACCES", "ENOEXEC"].includes(code ?? "")) {
      throw new CodexPathError(`外部CLIを起動できません（${code}）。ファイルの存在・実行権限・実行形式、shebangのインタープリターと動的ローダーを確認してください`);
    }
    throw new CodexError("execution", !observed && ["EAGAIN", "EAI_AGAIN", "ECONNREFUSED"].includes(code ?? ""));
  }
  if (!completed || !thread.id) {
    await observe({ type: "incomplete", diagnostic: diagnosticDetail("incomplete", "turn.completed または thread ID が取得できませんでした") });
    throw new CodexError("execution");
  }
  try {
    return { threadId: thread.id, output: schema.parse(JSON.parse(response ?? "")), source: "codex" };
  } catch {
    await observe({ type: "response", diagnostic: diagnosticDetail("response", "構造化応答がJSONまたは出力Schemaに適合しません（応答本文は保存しません）") });
    throw new CodexError("response");
  }
}

type Phase = "plan" | "implementation" | "fix" | "review" | "commit" | "report";
type PhaseThread = Pick<Thread, "id" | "runStreamed">;
export type PhaseConnection = { start: (readonly?: boolean) => PhaseThread; resume: (id: string, readonly?: boolean) => PhaseThread;
  prepare?: (phase: CodexPhase) => Promise<PhaseConnection> };
const constraints = [
  "タスク要件と完了条件をPlanより優先し、リポジトリの指示と事前設定の権限に従う。",
  "レビュー合格前のgit commitは禁止。push、merge、rebase、amend、reset、履歴変更は禁止。",
  "追加調査は専用の読み取りgh認証でgh apiを使用する。調査先をwatch一覧で制限せず、事前取得の10 MiB上限も適用しない。状態更新・コメント・提出・他の外部書き込みは禁止。認証値・認証ヘッダーを出力・保存せず、別のログイン・credential helper・SSH認証を利用しない。",
  "人間の判断・権限・外部対応が不可欠なら具体的な理由をblockersで返す。調査コマンド一つの拒否からタスク全体を実行不能と判断しない。許可された読み取り・代替手段で調査を続け、実行不能が確定した必須操作と必要な人間対応を区別する。",
  "Codexのフェーズ別サンドボックス・コマンドルールと、ハーネス起動環境の権限は別である。Codex内のpermission deniedだけでOS権限不足やハーネスでも実行不能と断定しない。自動昇格・許可拡大・拒否された操作の迂回は禁止。",
  "Docker等の環境調査は一操作ずつ独立したツール呼び出しで行い、コマンド・終了コード・stderrを個別に確認する。sed/rg/git status等を連結して後続成功で失敗を隠さない。複合コマンドの終了0も各操作の成功証拠にはならない。",
  "準備・検証のcommandも原則一操作ずつに分ける。ハーネスは/bin/sh -ecで実行するが、条件式・pipeline途中の失敗は隠れ得るため、必須ガードはcheck || exit等で非ゼロ終了を明示する。|| true等で必須操作の失敗を無視しない。",
  "ハーネス・エージェントの稼働場所を固定しない。対象リポジトリの指示から準備(kind=prepare)・検証を実行順に提示し、既存権限内で対象worktreeのコードを使用する。自己申告は正式な検証結果ではない。",
];

/** 一実行中の明示的なフェーズ呼び出し。再開・Reviewループ・検証実行は行わない。 */
export class CodexPhases {
  private busy = false;
  private readonly git: GitCommand;
  constructor(private readonly options: {
    control: DevelopmentControl; connection: PhaseConnection;
    block?: (reasons: string[]) => Promise<never>;
    git?: GitCommand; warningAfterMs?: number;
  }) { this.git = options.git ?? runGit; }

  private async phase<T extends z.ZodType, U>(phase: Phase, schema: T,
    input: () => Promise<unknown>, save: (output: z.infer<T>, threadId: string | null) => Promise<U>, attempt: number, apiSchema: z.ZodType = schema): Promise<U> {
    const { control, connection } = this.options;
    const operation = `codex.${phase}.${attempt}`;
    if (this.busy) return control.stop(new WorkflowError("fatal", "Codexフェーズの並行実行は禁止"), operation);
    this.busy = true;
    try {
      return await control.execute({ operation: `${operation}.phase`, run: async () => {
        const state = control.snapshot();
        if (state.status !== "running"
          || state.issue && phase !== "plan" && state.startTransition !== "succeeded"
          || (phase === "plan" ? state.codexThreadId !== null || state.phase !== "plan" || state.phaseStatus !== "pending" : !state.codexThreadId)
          || phase === "implementation" && (state.phase !== "plan" || state.phaseStatus !== "succeeded")
          || phase === "fix" && (state.phase !== "review" || state.phaseStatus !== "succeeded" || attempt !== state.fixCount + 1)
          || phase === "commit" && (state.phase !== "review" || state.phaseStatus !== "succeeded" || !state.reviewedTreeId || state.resultCommits.length > 0)
          || phase === "report" && (state.phase !== "commit" || state.phaseStatus !== "succeeded" || !state.resultCommits.length)
          || phase === "review" && (state.phase !== "verification" || state.phaseStatus !== "succeeded" || attempt !== state.reviewThreadIds.length + 1)) {
          throw new WorkflowError("fatal", "Codexフェーズの開始状態が不正");
        }
        const warningAfterMs = this.options.warningAfterMs ?? 60_000;
        if (!Number.isSafeInteger(warningAfterMs) || warningAfterMs < 1) throw new CodexError("configuration");
        const readonly = phase === "plan" || phase === "review" || phase === "report";
        const checkHistory = async () => {
          if (phase === "report") {
            const commits = await verifyResultCommits(state, this.git);
            if (JSON.stringify(commits) !== JSON.stringify(state.resultCommits)) throw new WorkflowError("fatal", "報告工程の成果コミットが不一致");
            return;
          }
          if ((await this.git(state.worktreePath, ["rev-parse", "HEAD"])).trim() !== developmentHead(state)
            || (phase === "plan" && !state.workBranchName
              ? await readHeadBranch(state.worktreePath, this.git) !== null
              : await readHeadBranch(state.worktreePath, this.git) !== `refs/heads/${developmentBranch(state)}`)) {
            throw new WorkflowError("fatal", "レビュー前のcommitまたは履歴・ブランチ変更を検出");
          }
        };
        await checkHistory();
        const before = await fingerprintWorktree(state.worktreePath, this.git);
        const payload = await input();
        const prompt = `${phase}フェーズ\n${constraints.join("\n")}\n${readonly ? "ファイル変更・commitを行わず調査結果のみ返す。" : phase === "commit" ? "コミット結果とSHAを返す。" : "変更内容・検証コマンドの追加変更削除と根拠・残課題を返す。"}\n`
          + (phase === "plan" ? "依存導入・コンテナ起動等の準備(kind=prepare)、テスト・型チェック・ビルドを実行順に検出し、起動cwd・実行環境・根拠・必須性・未検出事項を記録する。各commandはworktree内のcwdからそのまま実行する。コンテナ等の間接実行では対象runのworktreeのコードを使うことをマウント・実パス等で確認するガードをcommandに含め、確認失敗時は非ゼロで停止する。手順の失敗をシェルで握り潰さない。環境や権限の不足は具体的な操作・理由を記録し、権限昇格しない。\n"
            + "Planは準備・検証の実行成功を前提にしない。Planで実行できない準備・検証も、リポジトリの指示から実行可能なvalidationPlanとしてハーネスへ渡す。拒否された操作・観測した終了コード/stderr・ルールやsandboxの根拠・原因の不明点・許可された代替調査・ハーネスでの未確認事項をsummary/stepsと該当手順のevidence/executionMethodへ記録する。コマンドを発見済みの未実行と、未検出のundetectedValidationを区別する。\n"
            + "許可された調査と可能な実装を進められ、残りをハーネスの準備・正式検証で確認できるならblockersは空にする。Plan内でDockerに接続できないことだけをblockersにしない。必須性を下げたり検証を成功扱いにしたりせず、Implementation後のハーネス実行で成否を確定する。ハーネスでも必須手順が権限不足となれば結果と後続未実施を保存して安全停止する。人間の対応なしでは計画・実装にも進めない具体的理由がある場合はblockersに残す。\n" : "")
          + (["plan", "implementation", "fix"].includes(phase) ? 'workingDirectoryはworktree内の相対パス（ルートは"."）。内容変更はupdate、削除はID指定。追加はadd、add/updateは{operation:"add"または"update",definition:{id,kind,command,workingDirectory,executionMethod,evidence,required},reason}、removeは{operation:"remove",id:"prepare-image",reason:"実行順を変更"}。削除前定義を転記しない。\n' : "")
          + (phase === "review" ? "Plan自体と累積全差分を検査。必須検証の失敗・未実施・原因不明はmajor以上。指摘のvalidationCommandIdsに今回の検証コマンドIDを列挙する（複数可、一般のコード指摘は空配列）。locationは人間向けのファイル・行・説明またはnullとし、IDの対応判定には使わない。必須確認の削除・弱体化、未検出、未確認、秘密情報の除外を検査する。\n" : "")
          + (phase === "commit" ? "レビュー合格済み。ファイル内容を変更せず、Git index操作と論理単位の1件または複数commitだけを行う。空commitは禁止。コミット規約に従い、SHAを作成順にcommitHashesで返す。Issue再実行ではbaseCommitからの既存コミットも全件返す。追加変更がなければ空commitは作らず既存成果を返し、HEADがbaseCommitと同じ場合はHEADだけを返す。push・merge・rebase・amend・reset・既存履歴の変更・自動修正は禁止。\n" : "")
          + JSON.stringify({ worktreePath: state.worktreePath, constraints, input: payload });
        if (phase === "fix") await control.recordFix(attempt);
        await control.recordPhase(phase, "running", { attempt });
        let retrySafe = false;
        let phaseThreadId: string | null = null;
        const result = await control.execute({ operation, run: async () => {
          if (phase === "commit" && await fingerprintWorktree(state.worktreePath, this.git) !== before) {
            throw new WorkflowError("uncertain", "コミット実行前にレビュー対象が変更された");
          }
          // 通常継続だけresume。失敗した実行の自動resumeはしない。
          let lastEvent = Date.now();
          let currentThreadId: string | null = readonly ? null : state.codexThreadId;
          let failureDiagnosed = false;
          const diagnose = async (detail: DiagnosticDetail) => {
            await control.store.saveCodexDiagnostic({ ...detail, runId: state.runId, phase, attempt, operation,
              retryCount: control.snapshot().retryCount[operation] ?? 0, threadId: currentThreadId, timestamp: new Date().toISOString() });
            if (detail.source !== "item.error" && detail.source !== "mcp.error") failureDiagnosed = true;
          };
          let sessionSaved = false;
          let reportThreadId: string | undefined;
          let warningFailure: unknown;
          let warningWriting = false;
          let observing = false;
          let warningPending: Promise<void> = Promise.resolve();
          const timer = setInterval(() => {
            if (observing || warningWriting || warningFailure || Date.now() - lastEvent < warningAfterMs) return;
            lastEvent = Date.now();
            warningWriting = true;
            warningPending = (async () => {
              try { await control.store.appendEvent({ timestamp: new Date().toISOString(), type: "codex.unresponsive_warning", phase, data: { attempt } }); }
              catch (error) { warningFailure = error; }
              finally { warningWriting = false; }
            })();
          }, warningAfterMs);
          try {
            const currentConnection = connection.prepare ? await connection.prepare(phase) : connection;
            const thread = readonly ? currentConnection.start(true) : currentConnection.resume(state.codexThreadId!);
            currentThreadId = thread.id;
            if (readonly && thread.id !== null || !readonly && thread.id !== state.codexThreadId) throw new CodexError("configuration");
            const value = await runStructured(thread, prompt, schema, async event => {
              observing = true;
              try {
                if (control.snapshot().status !== "running") throw new WorkflowStopped(control.snapshot());
                lastEvent = Date.now();
                await warningPending;
                if (warningFailure) throw warningFailure;
                if (event.threadId) {
                  currentThreadId = event.threadId;
                  if (sessionSaved || !event.threadId.trim()) throw new WorkflowError("fatal", "セッション開始イベントが不正");
                  if (phase === "report") {
                    if (event.threadId === state.codexThreadId || state.reviewThreadIds.includes(event.threadId)) throw new CodexError("configuration");
                    reportThreadId = event.threadId;
                  }
                  if (phase === "plan") {
                    if (event.threadId === state.codexThreadId || state.reviewThreadIds.includes(event.threadId)) throw new CodexError("configuration");
                    for (let previous = 1; previous < attempt; previous++) {
                      if ((await control.store.loadArtifact("plan-session", previous)).threadId === event.threadId) throw new CodexError("configuration");
                    }
                    await control.store.saveArtifact("plan-session", { threadId: event.threadId, readonly: true }, attempt);
                    phaseThreadId = event.threadId;
                  } else if (readonly && phase !== "report") await control.recordCodexSession(event.threadId, phase === "review");
                  else if (!readonly && event.threadId !== state.codexThreadId) throw new WorkflowError("fatal", "継続セッションが不一致");
                  sessionSaved = true;
                }
                if (event.mcp) {
                  throw new WorkflowError("fatal", "読み取り専用MCPの範囲外の呼び出しを検出");
                }
                if (event.diagnostic) await diagnose(event.diagnostic);
                const { diagnostic: _diagnostic, ...observation } = event;
                await control.store.appendEvent({ timestamp: new Date().toISOString(), type: "codex.event", phase,
                  data: { ...observation, attempt, operation, threadId: currentThreadId, retryCount: control.snapshot().retryCount[operation] ?? 0 } });
              } finally { observing = false; }
            }, apiSchema);
            if (phase === "plan" && value.threadId !== phaseThreadId
              || value.threadId !== control.snapshot().codexThreadId && phase !== "plan" && phase !== "review" && phase !== "report"
              || phase === "report" && value.threadId !== reportThreadId
              || phase === "review" && !control.snapshot().reviewThreadIds.includes(value.threadId)) throw new CodexError("response");
            if (phase !== "commit") await checkHistory();
            if (readonly && await fingerprintWorktree(state.worktreePath, this.git) !== before) throw new WorkflowError("fatal", "読み取りフェーズでGit内容変更を検出");
            return value.output;
          } catch (error) {
            if (!failureDiagnosed && !(error instanceof StorageError) && !(error instanceof WorkflowStopped) && !(error instanceof WorkflowError)) {
              await diagnose(diagnosticDetail("exception", error));
            }
            retrySafe = error instanceof CodexError && error.safeToRetry;
            if (retrySafe) throw new WorkflowError("transient", "Codex実行開始前の一時的障害");
            throw error;
          } finally {
            clearInterval(timer);
            await warningPending;
            if (warningFailure) throw warningFailure;
          }
        }, confirmRetry: async () => ({ outcome: retrySafe && await fingerprintWorktree(state.worktreePath, this.git) === before ? "retry" : "uncertain" }) });
        if (control.snapshot().status !== "running") throw new WorkflowStopped(control.snapshot());
        const output = await save(result, phaseThreadId);
        const blockers = (output as { blockers?: unknown; plan?: { blockers?: unknown } }).blockers
          ?? (output as { plan?: { blockers?: unknown } }).plan?.blockers;
        if (Array.isArray(blockers) && blockers.length) await this.block(blockers);
        await control.recordPhase(phase, "succeeded", { attempt });
        return output;
      }, confirmRetry: async () => ({ outcome: "uncertain" }) });
    } finally { this.busy = false; }
  }

  private block(reasons: string[]): Promise<never> {
    if (this.options.block) return this.options.block(reasons);
    return this.options.control.stop(new WorkflowError("fatal", "blocked処理が未接続"), "blocked");
  }

  /** GitHubの命名・予約保存・ref作成はworkspace側へ委ねる。同じ応答のPlanを採用する。 */
  async issuePlan(context: IssueInput, input: { attempt: number; branchName: string | null; reason: string | null;
    managementContent: unknown; namingInstruction: string; restart: unknown }) {
    const { control } = this.options;
    await control.recordPhase("plan", "pending");
    await control.store.saveArtifact("plan-start", { attempt: input.attempt, readonly: true, branchName: input.branchName, reason: input.reason }, input.attempt);
    const output = await this.phase("plan", planOutputSchema, async () => ({ issueInput: this.context(context), ...input }), async value => {
      await control.store.saveArtifact("plan-output", value, input.attempt);
      return value;
    }, input.attempt);
    return { ...output, threadId: (await control.store.loadArtifact("plan-session", input.attempt)).threadId };
  }

  private async previousImplementations(attempt: number) {
    const previous: Implementation[] = [];
    for (let index = 1; index < attempt; index++) previous.push(await this.options.control.store.loadArtifact("implementation", index));
    return previous;
  }
  private async currentValidationPlan(attempt: number) {
    return applyValidationUpdates((await this.options.control.store.loadPlan()).plan, await this.previousImplementations(attempt)).validationPlan;
  }

  /** 更新データの訂正だけ。Fix/通信再試行の回数を増やさず、検証を開始しない。 */
  private async acceptValidationUpdates(candidate: z.infer<typeof implementationCandidateSchema>, phase: "implementation" | "fix", attempt: number): Promise<Implementation> {
    const { control, connection } = this.options;
    if (candidate.blockers.length) {
      const blocked = implementationOutputSchema.safeParse(candidate);
      if (blocked.success) return blocked.data; // 元のblockersを正式保存して共通blocked経路へ。
      await control.store.saveValidationSubmission({ phase, attempt, submission: 1, candidate,
        error: JSON.stringify(blocked.error.issues), accepted: false });
      await this.block(candidate.blockers);
    }
    const state = control.snapshot();
    const plan = (await control.store.loadPlan()).plan;
    const previous = await this.previousImplementations(attempt);
    const currentValidationPlan = applyValidationUpdates(plan, previous).validationPlan;
    const fingerprint = await fingerprintWorktree(state.worktreePath, this.git);
    let updates = candidate.validationPlanUpdates;
    for (let submission = 1; submission <= 3; submission++) {
      const parsed = implementationOutputSchema.safeParse({ ...candidate, validationPlanUpdates: updates });
      let error: string | null = null;
      if (!parsed.success) error = JSON.stringify(parsed.error.issues);
      else {
        try {
          applyValidationUpdates(plan, [...previous, parsed.data]);
          for (const [index, update] of parsed.data.validationPlanUpdates.entries()) {
            if (update.operation === "remove") continue;
            const cwd = update.definition.workingDirectory;
            const delta = relative(state.worktreePath, resolve(state.worktreePath, cwd));
            if (isAbsolute(cwd) || cwd.includes("\0") || delta === ".." || delta.startsWith("../") || isAbsolute(delta)) {
              throw new ValidationUpdateError(`validationPlanUpdates[${index}] ${update.operation} ID=${update.definition.id}: 実行場所はworktree内の相対パスが必要`);
            }
            if (update.definition.command.includes("\0")) throw new ValidationUpdateError(`validationPlanUpdates[${index}] ${update.operation} ID=${update.definition.id}: コマンドにNUL文字は使用できない`);
            // ディレクトリ作成をprepareが担う場合がある。存在・symlinkは実行直前に検査する。
          }
        }
        catch (cause) { if (!(cause instanceof ValidationUpdateError)) throw cause; error = cause.message; }
      }
      await control.store.saveValidationSubmission({ phase, attempt, submission,
        candidate: submission === 1 ? candidate : { validationPlanUpdates: updates }, error, accepted: error === null });
      if (error === null && parsed.success) return parsed.data;
      if (submission === 3) throw new WorkflowError("fatal", `検証計画更新の再提出上限（初回含む3回）: ${error}`);
      const prompt = `検証計画更新の再提出。コード変更・commit・検証コマンド実行は禁止。validationPlanUpdates全体の置換データだけを返す。workingDirectoryはworktree内の相対パス。内容変更はupdate、removeは{operation:"remove",id,reason}。削除前の定義は不要。\n${constraints.join("\n")}\n`
        + JSON.stringify({ currentValidationPlan, rejectedUpdates: updates, error, remainingSubmissions: 3 - submission });
      // 当該フェーズの設定を再読し、read-onlyで同じthreadを継続する。失敗の自動再実行はしない。
      const prepared = connection.prepare ? await connection.prepare(phase) : connection;
      const thread = prepared.resume(state.codexThreadId!, true);
      await control.store.appendEvent({ timestamp: new Date().toISOString(), type: "validation.resubmission.started", phase,
        data: { attempt, submission: submission + 1, threadId: state.codexThreadId } });
      const response = await runStructured(thread, prompt, validationRepairCandidateSchema, async event => {
        if (event.threadId && event.threadId !== state.codexThreadId) throw new WorkflowError("fatal", "再提出セッションが不一致");
        if (event.mcp) throw new WorkflowError("fatal", "再提出で読み取り専用MCP範囲外の呼び出し");
        if (event.diagnostic) await control.store.saveCodexDiagnostic({ ...event.diagnostic, runId: state.runId, phase, attempt: phase === "fix" ? attempt - 1 : 1,
          operation: `codex.${phase}.${phase === "fix" ? attempt - 1 : 1}`, retryCount: 0, threadId: state.codexThreadId, timestamp: new Date().toISOString() });
        const { diagnostic: _diagnostic, ...observation } = event;
        await control.store.appendEvent({ timestamp: new Date().toISOString(), type: "codex.event", phase,
          data: { ...observation, attempt: phase === "fix" ? attempt - 1 : 1, operation: `codex.${phase}.${phase === "fix" ? attempt - 1 : 1}`,
            submission: submission + 1, threadId: state.codexThreadId, retryCount: 0 } });
      }, validationRepairSchema);
      if (response.threadId !== state.codexThreadId || await fingerprintWorktree(state.worktreePath, this.git) !== fingerprint) {
        const error = "検証計画再提出中にコード・index・履歴またはセッションが変更された";
        await control.store.saveValidationSubmission({ phase, attempt, submission: submission + 1, candidate: response.output, error, accepted: false });
        throw new WorkflowError("fatal", error);
      }
      updates = response.output.validationPlanUpdates;
    }
    throw new WorkflowError("fatal", "検証計画更新が確定しない");
  }

  implementation(context: IssueInput, extraConstraints: string[] = []) {
    return this.phase("implementation", implementationCandidateSchema, async () => ({ issueInput: this.context(context),
      plan: (await this.options.control.store.loadPlan()).plan, currentValidationPlan: await this.currentValidationPlan(1), extraConstraints: z.array(z.string()).parse(extraConstraints) }),
      async output => this.options.control.store.saveArtifact("implementation", await this.acceptValidationUpdates(output, "implementation", 1), 1), 1, implementationOutputSchema);
  }

  fix(attempt: number) {
    return this.phase("fix", implementationCandidateSchema, async () => {
      if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3) throw new CodexError("configuration");
      const { input, diff } = await this.options.control.store.loadReviewInput(attempt);
      await this.checkReviewInput(input);
      return { issueInput: input.issueInput, plan: input.plan, currentValidationPlan: await this.currentValidationPlan(attempt + 1), implementation: input.implementation,
        verification: input.verification, cumulativeDiff: diff,
        review: await this.options.control.store.loadArtifact("review", attempt) };
    }, async output => this.options.control.store.saveArtifact("implementation", await this.acceptValidationUpdates(output, "fix", attempt + 1), attempt + 1), attempt, implementationOutputSchema);
  }

  review(attempt: number) {
    return this.phase("review", reviewSchema, async () => {
      const saved = await this.options.control.store.loadReviewInput(attempt);
      await this.checkReviewInput(saved.input);
      return { ...reviewInputSchema.parse(saved.input), cumulativeDiff: saved.diff };
    }, async output => reviewSchema.parse(await this.options.control.store.saveArtifact("review", output, attempt)), attempt);
  }

  /** 保存済みの合格Reviewに一致する変更だけをコミットし、ハーネスが実Gitで照合する。 */
  commit() {
    const { control } = this.options;
    let reviewedContents: string;
    return this.phase("commit", commitSchema, async () => {
      const state = control.snapshot();
      const attempt = state.reviewThreadIds.length;
      const saved = await control.store.loadReviewInput(attempt);
      await this.checkReviewInput(saved.input);
      const review = await control.store.loadArtifact("review", attempt);
      const { assessReview } = await import("./review.js");
      if (state.verificationArtifact !== saved.input.verificationArtifact || assessReview(review, saved.input.verification) !== "passed"
        || !saved.input.verification.worktreeFingerprint || await captureWorktreeTree(state.worktreePath) !== state.reviewedTreeId) {
        throw new WorkflowError("fatal", "コミット対象が保存済みの合格Reviewと不一致");
      }
      reviewedContents = await fingerprintWorktreeContents(state.worktreePath, this.git);
      await control.store.appendEvent({ timestamp: new Date().toISOString(), type: "git.commit_input", phase: state.phase,
        data: { reviewedTreeId: state.reviewedTreeId, reviewedContents } });
      return { ...saved.input, cumulativeDiff: saved.diff, review, reviewedTreeId: state.reviewedTreeId,
        splittingPolicy: "関連する実装とテストを論理単位でまとめる。分割が不要なら1件とし、ファイル内容は変更しない。" };
    }, async output => {
      if (output.blockers.length) await this.block(output.blockers);
      const commits = await verifyResultCommits(control.snapshot(), this.git);
      if (await fingerprintWorktreeContents(control.snapshot().worktreePath, this.git) !== reviewedContents) {
        throw new WorkflowError("fatal", "コミット工程で実ファイルの内容・属性が変更された");
      }
      if (JSON.stringify(commits) !== JSON.stringify(output.commitHashes)) throw new WorkflowError("fatal", "Codex申告とGit成果コミットが不一致");
      await control.recordCommitState({ reviewedTreeId: control.snapshot().reviewedTreeId, resultCommits: commits });
      return commitSchema.parse(await control.store.saveArtifact("commit", output));
    }, 1);
  }

  /** 読み取り専用の新規セッションで文章を作り、事実項目を照合して保存する。 */
  async issueReport() {
    const { issueReportDraftSchema, issueReportEvidence, issueReportMarkdown } = await import("./github-report.js");
    const { control } = this.options;
    return this.phase("report", issueReportDraftSchema, async () => ({
      evidence: await issueReportEvidence(control, this.git),
      instructions: "Issue本文のすべての要件・完了条件をcriterionごとに整理し、今回の最終Review・正式検証・コードによる確認結果resultと根拠evidenceを返す。summaryとchangesには変更要約を返す。検証・Review・Gitの事実や未検証事項を創作しない。",
    }), async draft => {
      const report = { ...await issueReportEvidence(control, this.git), ...draft };
      await control.store.saveIssueReport(report, issueReportMarkdown(report));
      return report;
    }, 1);
  }

  private context(context: IssueInput): IssueInput {
    const parsed = issueInputSchema.parse(context);
    if (parsed.issue.id !== developmentIdentity(this.options.control.snapshot())) throw new WorkflowError("fatal", "Codex入力のIssueが不一致");
    return parsed;
  }

  private async checkReviewInput(input: z.infer<typeof reviewInputSchema>) {
    const state = this.options.control.snapshot();
    this.context(input.issueInput);
    if (input.baseCommit !== state.baseCommit || input.verification.worktreePath !== state.worktreePath) {
      throw new WorkflowError("fatal", "Review入力のworktreeまたはbaseCommitが不一致");
    }
    if (input.verification.worktreeFingerprint
      && await fingerprintWorktree(state.worktreePath, this.git) !== input.verification.worktreeFingerprint) {
      throw new WorkflowError("uncertain", "検証後にReview対象のコード・index・履歴が変更された");
    }
  }
}
