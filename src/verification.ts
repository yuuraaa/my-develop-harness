import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { fingerprintWorktree, runGit } from "./git.js";
import { type RunStore } from "./state.js";
import { validationDefinitionSchema, validationHistorySchema, type Plan, type Implementation, type Verification } from "./schemas.js";
import { type DevelopmentControl, developmentIdentity, developmentBranch, developmentHead } from "./workflow.js";
import { WorkflowError } from "./workflow-error.js";
import { checkRepositoryCredentials, isolatedGitHubEnvironment } from "./github-auth.js";

type Definition = z.infer<typeof validationDefinitionSchema>;
// 非同期の成果物読み取りより前に、同じ実行の重複開始を拒否する。
const activeVerifications = new WeakSet<DevelopmentControl>();

export class ValidationUpdateError extends WorkflowError {
  constructor(message: string) { super("fatal", message); this.name = "ValidationUpdateError"; }
}

/** 全体をローカルMapで検査する。失敗した候補は一部も確定しない。 */
export function applyValidationUpdates(plan: Plan, implementations: Implementation[]) {
  const definitions = new Map<string, Definition>();
  for (const definition of plan.validationPlan) {
    if (definitions.has(definition.id)) throw new WorkflowError("fatal", `検証コマンドIDが重複: ${definition.id}`);
    definitions.set(definition.id, definition);
  }
  const updates = implementations.flatMap(output => output.validationPlanUpdates);
  const validationHistory: z.infer<typeof validationHistorySchema>[] = [];
  const indexedUpdates = implementations.flatMap((output, implementationIndex) =>
    output.validationPlanUpdates.map((update, index) => ({ update, index, implementationIndex })));
  for (const { update, index, implementationIndex } of indexedUpdates) {
    const id = "id" in update ? update.id : update.definition.id;
    const old = definitions.get(id);
    const fail = (reason: string): never => { throw new ValidationUpdateError(`implementation-${implementationIndex + 1}.validationPlanUpdates[${index}] ${update.operation} ID=${id}: ${reason}`); };
    if (update.operation === "add" ? !!old : !old) fail(update.operation === "add" ? "登録済みID。内容変更にはupdateを使用する" : "対象IDが登録されていない");
    const after = update.operation === "remove" ? null : update.definition;
    validationHistory.push({ operation: update.operation, id, reason: update.reason, before: old ?? null, after });
    if (after === null) definitions.delete(id);
    else definitions.set(id, after);
  }
  return { validationPlan: [...definitions.values()], validationPlanUpdates: updates, validationHistory, undetectedValidation: plan.undetectedValidation };
}

const inside = (root: string, path: string) => {
  const delta = relative(root, path);
  return delta !== ".." && !delta.startsWith("../") && !isAbsolute(delta);
};
// 検証子プロセスへ認証、GIT_*、NODE_OPTIONS等のホスト設定を持ち込まない。
export const executionEnvironment = () => isolatedGitHubEnvironment();
/** 起動cwdを実パスで制限する。実行環境はリポジトリから発見したコマンドに含める。 */
export async function prepareVerificationCommand(definition: Definition, worktree: string) {
  if (definition.command.includes("\0")) return { skippedReason: "コマンドにNUL文字は使用できない" };
  if (isAbsolute(definition.workingDirectory) || definition.workingDirectory.includes("\0")) return { skippedReason: "実行場所はworktree内の相対パスが必要" };
  const root = await realpath(worktree);
  const requested = resolve(root, definition.workingDirectory);
  if (!inside(root, requested)) return { skippedReason: "実行場所がworktree外" };
  let cwd: string;
  try { cwd = await realpath(requested); }
  catch { return { skippedReason: "実行ディレクトリを確認できない" }; }
  if (!inside(root, cwd)) return { skippedReason: "実行ディレクトリのリンク先がworktree外" };
  // 単純コマンドの失敗を、後続の成功で隠さない。条件式・pipelineの限界は手順発見時にも扱う。
  return { program: "/bin/sh", args: ["-ec", definition.command], cwd };
}

/** 非ゼロ終了は実装の検証結果。起動失敗は未実施として保存し、signal・結果不明は安全停止。再実行しない。 */
async function executeCommand(invocation: { program: string; args: string[]; cwd: string }, store: RunStore) {
  const stdout = store.outputCapture(), stderr = store.outputCapture();
  const outDecoder = new StringDecoder("utf8"), errDecoder = new StringDecoder("utf8");
  const startedAt = new Date().toISOString();
  let launchError: string | null = null;
  const env = await executionEnvironment();
  await checkRepositoryCredentials(invocation.cwd, env, undefined, true);
  const exitCode = await new Promise<number | null>((accept, reject) => {
    const child = spawn(invocation.program, invocation.args, { cwd: invocation.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => stdout.append(outDecoder.write(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(errDecoder.write(chunk)));
    child.on("error", (error: NodeJS.ErrnoException) => { launchError = error.code ?? "UNKNOWN"; });
    child.on("close", (code, signal) => {
      stdout.append(outDecoder.end()); stderr.append(errDecoder.end());
      if (launchError) accept(null);
      else if (signal || code === null) reject(new WorkflowError("uncertain", "検証プロセスの終了結果を確認できない"));
      else accept(code);
    });
  });
  const output = { stdout: stdout.finish(), stderr: stderr.finish() };
  const permissionDenied = launchError === "EACCES" || launchError === "EPERM" || exitCode === 126
    || exitCode !== 0 && /permission denied|operation not permitted|access denied|insufficient permissions/i.test(output.stderr.text);
  return { startedAt, endedAt: new Date().toISOString(), exitCode, ...output,
    unavailableReason: launchError ? `起動失敗: ${launchError}` : null, permissionDenied };
}

/** 初回ImplementationまたはFix成功後のみ呼ぶ。戻り値と同じ保存済み結果がReviewへ渡る。 */
export async function verifyImplementation(control: DevelopmentControl) {
  const attempt = control.snapshot().fixCount + 1;
  if (activeVerifications.has(control)) return control.stop(new WorkflowError("fatal", "検証フェーズの並行実行は禁止"), `verification.${attempt}`);
  activeVerifications.add(control);
  const run = async () => {
    const state = control.snapshot();
    if (state.status !== "running" || state.phaseStatus !== "succeeded"
      || state.phase !== (attempt === 1 ? "implementation" : "fix")) throw new WorkflowError("fatal", "検証フェーズの開始状態が不正");
    const store = control.store;
    const { plan } = await store.loadPlan();
    const context = await store.loadArtifact("issue-input");
    if (context.issue.id !== developmentIdentity(state)) throw new WorkflowError("fatal", "検証対象Issueが不一致");
    const implementations: Implementation[] = [];
    for (let index = 1; index <= attempt; index++) implementations.push(await store.loadArtifact("implementation", index));
    const detection = applyValidationUpdates(plan, implementations);
    await store.saveArtifact("validation-plan", detection, attempt);
    await control.recordPhase("verification", "running", { attempt });
    const checkHistory = async () => {
      if (await realpath(state.worktreePath) !== state.worktreePath
        || (await runGit(state.worktreePath, ["rev-parse", "--show-toplevel"])).trim() !== state.worktreePath
        || (await runGit(state.worktreePath, ["rev-parse", "HEAD"])).trim() !== developmentHead(state)
        || (await runGit(state.worktreePath, ["symbolic-ref", "HEAD"])).trim() !== `refs/heads/${developmentBranch(state)}`) {
        throw new WorkflowError("fatal", "検証対象worktreeまたはレビュー前履歴が不整合");
      }
    };
    await checkHistory();
    const fingerprint = await fingerprintWorktree(state.worktreePath);
    const commands: Verification["commands"] = [];
    let haltedReason: string | null = null;
    let permissionFailure = false;
    for (let index = 0; index < detection.validationPlan.length; index++) {
      const definition = detection.validationPlan[index]!;
      const progress = { attempt, commandIndex: index, commandTotal: detection.validationPlan.length, commandKind: definition.kind, commandId: definition.id };
      await control.recordPhase("verification", "running", { ...progress, commandStatus: "started" });
      const invocation: Awaited<ReturnType<typeof prepareVerificationCommand>> = haltedReason ? { skippedReason: haltedReason } : await prepareVerificationCommand(definition, state.worktreePath);
      if ("skippedReason" in invocation) {
        commands.push({ definition, execution: null, startedAt: null, endedAt: null, exitCode: null, status: "skipped", outcome: "not_run", skippedReason: invocation.skippedReason,
          stdout: store.outputCapture().finish(), stderr: store.outputCapture().finish() });
        if (definition.kind === "prepare" && !haltedReason) haltedReason = `準備未実施: 手順 ${definition.id} (${invocation.skippedReason}) により後続を未実施`;
      } else {
        const result = await executeCommand(invocation, store);
        const { permissionDenied, unavailableReason, ...record } = result;
        const outcome = permissionDenied ? "permission_denied" : unavailableReason ? "not_run"
          : result.exitCode === 0 ? "passed" : definition.kind === "prepare" ? "preparation_failed" : "verification_failed";
        commands.push({ definition, execution: { program: invocation.program, args: invocation.args, workingDirectory: invocation.cwd },
          ...record, status: unavailableReason ? "skipped" : result.exitCode === 0 ? "passed" : "failed", outcome,
          skippedReason: unavailableReason });
        if (permissionDenied) {
          permissionFailure = true;
          haltedReason = `権限不足: 手順 ${definition.id} (${definition.command}) を実行できない。終了コード・stderrを確認し、必要な権限を準備してください。権限昇格は行いません。`;
        } else if (unavailableReason || definition.kind === "prepare" && result.exitCode !== 0) {
          haltedReason = `準備・起動失敗: 手順 ${definition.id} の失敗により後続を未実施`;
        }
      }
      commands[index] = await store.saveVerificationCommand(attempt, index, commands[index]!);
      await control.recordPhase("verification", "running", { ...progress, commandStatus: commands.at(-1)!.status });
      if (await fingerprintWorktree(state.worktreePath) !== fingerprint) throw new WorkflowError("uncertain", "検証中に対象コード・index・履歴が変更された");
    }
    await checkHistory();
    const diff = await store.captureDiff(state.worktreePath, state.baseCommit);
    if (await fingerprintWorktree(state.worktreePath) !== fingerprint) throw new WorkflowError("uncertain", "検証後の差分取得中に対象コードが変更された");
    const verification = await store.saveVerification({ source: "harness", attempt, worktreePath: state.worktreePath,
      baseCommit: state.baseCommit, diffId: diff.diffId, worktreeFingerprint: fingerprint, commands, ...detection });
    const saved = await store.saveReviewInput({ attempt, issueInput: context, plan, implementation: implementations.at(-1)!, implementationHistory: implementations,
      verification, validationSubmissions: await store.loadValidationSubmissions(), baseCommit: state.baseCommit, verificationArtifact: `verification-${attempt}.json` }, diff.diff, diff.redactions);
    await control.recordVerification(attempt);
    if (permissionFailure) throw new WorkflowError("fatal", haltedReason!);
    await control.recordPhase("verification", "succeeded", { attempt });
    return saved;
  };
  try {
    return await control.execute({ operation: `verification.${attempt}`, run, confirmRetry: async () => ({ outcome: "uncertain" }) });
  } finally { activeVerifications.delete(control); }
}
