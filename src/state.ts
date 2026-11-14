import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, tmpdir } from "node:os";
import { join, basename } from "node:path";
import { mkdir, open, readFile, rename, link, unlink, readdir, mkdtemp, rm } from "node:fs/promises";
import { z } from "zod";
import { validationResolutionSchema, validationSubmissionSchema, runIdSchema, eventSchema, planSchema, planOutputSchema, planStartSchema, planSessionSchema, planDecisionSchema, implementationSchema, verificationSchema, verificationCommandSchema, reviewSchema, issueInputSchema, reviewInputSchema, commitSchema } from "./schemas.js";
import type { Plan, RunState, RunEvent, ReviewInput } from "./schemas.js";
import { codexDiagnosticSchema, diagnosticMessage, type CodexDiagnostic } from "./codex-diagnostics.js";
import type { GitHubRunState } from "./github-state.js";

export class StorageError extends Error {
  constructor(public readonly kind: "schema" | "io" | "corrupt" | "incomplete" | "exists") {
    super(`実行記録: ${kind}`); this.name = "StorageError";
  }
}
export const newRunId = () => randomUUID();
export const diffId = (diff: string) => createHash("sha256").update(diff).digest("hex");
export function environmentSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env).filter(([key, value]) => /token|password|secret|api[_-]?key|authorization|private[_-]?key/i.test(key) && !!value).map(([, value]) => value!);
}
export function boundedOutput(raw: string, secrets: readonly string[] = environmentSecrets()) {
  const masked = redact(raw, secrets);
  const truncated = masked.length > 65536;
  return { text: masked.slice(0, 65536), truncated, omittedReason: truncated ? "65536文字を超えた出力を省略。省略部分は未確認。" : null };
}

/** 出力を流し読みし、秘密値を途中で切る前にマスキングするための余白を保持する。 */
export class OutputCapture {
  private prefix = "";
  private omitted = false;
  private readonly limit: number;
  constructor(private readonly secrets: readonly string[]) {
    this.limit = 65536 + Math.max(8192, ...secrets.map(s => s.length));
  }
  append(text: string) {
    const remaining = this.limit - this.prefix.length;
    this.prefix += text.slice(0, remaining);
    if (text.length > remaining) this.omitted = true;
  }
  finish() {
    // 巨大な秘密鍵が保持上限をまたぐ場合も、未完の鍵を保存しない。
    const raw = this.prefix.replace(/-----BEGIN [\w ]*PRIVATE KEY-----(?:(?!-----END [\w ]*PRIVATE KEY-----)[\s\S])*$/g, "[REDACTED PRIVATE KEY]");
    const output = boundedOutput(raw, this.secrets);
    return this.omitted ? { ...output, truncated: true, omittedReason: "出力保持上限を超えた部分を省略。省略部分は未確認。" } : output;
  }
}

/** 既知の認証値を必ず渡す。未知の秘密値はキー・一般的な表記でも除外する。 */
export function redact(value: string, secrets: readonly string[] = []): string {
  let result = value;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[^\s"',]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]+|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/((?:token|password|secret|api[_-]?key|authorization|private[_-]?key)\s*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"',;]+)/gi, "$1[REDACTED]")
    .replace(/((?:https?|ssh):\/\/)[^\s/@"']+@/gi, "$1[REDACTED]@");
}
function scrub(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map(v => scrub(v, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k, secrets), /token|password|secret|api[_-]?key|authorization|private[_-]?key/i.test(k) ? "[REDACTED]" : scrub(v, secrets)]));
  return value;
}
export function planMarkdown(plan: Plan): string {
  // JSON値の表記を使い、改行・Markdown記号を含む内容も欠落させない。
  return "# 計画\n\n" + Object.entries(planSchema.parse(plan)).map(([key, value]) =>
    `## ${key}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``).join("\n\n") + "\n";
}
const artifactSchemas = {
  "plan-start": planStartSchema, "plan-session": planSessionSchema, "plan-output": planOutputSchema, "plan-decision": planDecisionSchema,
  "issue-input": issueInputSchema, plan: planSchema, implementation: implementationSchema,
  "validation-plan": validationResolutionSchema, verification: verificationSchema, "review-input": reviewInputSchema, review: reviewSchema, commit: commitSchema,
} as const;
type ArtifactKind = keyof typeof artifactSchemas;
function artifactName(kind: ArtifactKind, attempt?: number): string {
  if (["validation-plan", "implementation", "verification", "review-input", "review", "plan-start", "plan-session", "plan-output", "plan-decision"].includes(kind)) {
    if (!Number.isInteger(attempt) || attempt! < 1 || attempt! > 4) throw new StorageError("schema");
    return `${kind}-${attempt}.json`;
  }
  if (attempt !== undefined) throw new StorageError("schema");
  return `${kind}.json`;
}

export class RunStore {
  private readonly eventListeners = new Set<(event: RunEvent) => void>();
  /** 保存が確定したイベントだけを通知。表示の障害で実行記録を失敗させない。 */
  observeEvents(listener: (event: RunEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }
  readonly runPath: string;
  readonly worktreePath: string;
  readonly artifactsPath: string;
  outputCapture() { return new OutputCapture(this.secrets); }
  captureDiff(worktreePath: string, baseCommit: string) { return captureReviewDiff(worktreePath, baseCommit, this.secrets); }
  constructor(readonly runId: string, readonly root = join(homedir(), ".harness"), private secrets: readonly string[] = environmentSecrets()) {
    if (!runIdSchema.safeParse(runId).success) throw new StorageError("schema");
    this.runPath = join(root, "runs", runId); this.worktreePath = join(root, "worktrees", runId);
    this.artifactsPath = join(this.runPath, "artifacts");
  }
  protectSecrets(secrets: readonly string[]) { this.secrets = [...new Set([...this.secrets, ...secrets])]; }
  private validate<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
    try { return schema.parse(scrub(schema.parse(value), this.secrets)); } catch { throw new StorageError("schema"); }
  }
  private async atomic(path: string, content: string, replace = false) {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
      if (replace) await rename(temp, path); else { await link(temp, path); await unlink(temp); }
    } catch (e) { await unlink(temp).catch(() => {}); throw new StorageError((e as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "io"); }
  }
  private async ready() {
    try { if ((await readdir(this.artifactsPath)).some(n => n.endsWith(".pending"))) throw new StorageError("incomplete"); }
    catch (e) { if (e instanceof StorageError) throw e; throw new StorageError("io"); }
  }
  private async read<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
    await this.ready();
    let content: string;
    try { content = await readFile(path, "utf8"); } catch { throw new StorageError("io"); }
    try { return schema.parse(JSON.parse(content)); } catch { throw new StorageError("corrupt"); }
  }
  async createGitHub(state: GitHubRunState) {
    const { githubStateSchema } = await import("./github-state.js");
    this.validate(githubStateSchema, state);
    if (state.runId !== this.runId) throw new StorageError("schema");
    await this.initializeGitHub();
    await this.saveGitHubState(state);
  }
  /** 識別情報の取得前も失敗の場所とイベントを保持する。stateのIDを推測しない。 */
  async initializeGitHub() {
    try {
      await mkdir(join(this.root, "runs"), { recursive: true, mode: 0o700 });
      await mkdir(this.runPath, { mode: 0o700 });
      await mkdir(this.artifactsPath, { mode: 0o700 });
    } catch (e) { throw new StorageError((e as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "io"); }
  }
  async saveGitHubState(state: GitHubRunState) {
    const { githubStateSchema } = await import("./github-state.js");
    const parsed = this.validate(githubStateSchema, state);
    if (parsed.runId !== this.runId) throw new StorageError("schema");
    await this.atomic(join(this.runPath, "state.json"), JSON.stringify(parsed, null, 2) + "\n", true);
  }
  async loadGitHubState() {
    const { githubStateSchema } = await import("./github-state.js");
    const state = await this.read(join(this.runPath, "state.json"), githubStateSchema);
    if (state.runId !== this.runId) throw new StorageError("corrupt");
    return state;
  }
  async saveJson(name: string, value: unknown) {
    if (!/^[a-z][a-z0-9-]*\.json$/.test(name)) throw new StorageError("schema");
    await this.atomic(join(this.artifactsPath, name), JSON.stringify(scrub(value, this.secrets), null, 2) + "\n");
  }
  async saveSubmission(value: unknown) {
    await this.atomic(join(this.artifactsPath, "submission.json"), JSON.stringify(scrub(value, this.secrets), null, 2) + "\n", true);
  }
  async saveIssueReport(value: unknown, markdown: string) {
    await this.saveJson("report.json", value);
    await this.atomic(join(this.artifactsPath, "report.md"), redact(markdown, this.secrets));
  }
  async saveCodexDiagnostic(value: CodexDiagnostic) {
    const parsed = this.validate(codexDiagnosticSchema, value);
    if (parsed.runId !== this.runId) throw new StorageError("schema");
    // 秘密値をマスクしてから上限を適用し、途中で切れた秘密値を残さない。
    const bound = (value: unknown): unknown => {
      if (typeof value === "string") {
        const output = boundedOutput(value, this.secrets);
        if (output.truncated) parsed.omitted = true;
        return output.text;
      }
      if (Array.isArray(value)) return value.map(bound);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bound(v)]));
      return value;
    };
    parsed.details = bound(parsed.details) as CodexDiagnostic["details"];
    const name = `codex-diagnostic-${randomUUID()}.json`;
    await this.atomic(join(this.artifactsPath, name), JSON.stringify(parsed, null, 2) + "\n");
    await this.appendEvent({ timestamp: parsed.timestamp, type: "codex.diagnostic", phase: parsed.phase,
      data: { artifact: name, operation: parsed.operation, attempt: parsed.attempt, retryCount: parsed.retryCount,
        threadId: parsed.threadId, source: parsed.source } });
    return name;
  }
  /** 停止した操作の最終試行だけを読む。表示用の読み取り失敗は停止原因にしない。 */
  async stoppedCodexMessage(state: Pick<RunState, "runId" | "status" | "phase" | "error" | "retryCount">): Promise<string | undefined> {
    try {
      const operation = state.error?.operation;
      // 接続初期化だけはworkflow.developの内側で診断を保存してから例外を返す。
      const configuring = operation === "workflow.develop" && state.phase === "plan"
        && /^(Codex SDK:|Codexホーム:|Codex CLI:)/.test(state.error?.message ?? "");
      if (state.runId !== this.runId || state.status !== "stopped" || !operation
        || !configuring && !/^codex\.(plan|implementation|fix|review|commit|report)\.[1-4]$/.test(operation)) return;
      const diagnosticOperation = configuring ? "codex.configure" : operation;
      const retryCount = state.retryCount[operation] ?? 0;
      const events = await this.loadEvents();
      const start = events.findLastIndex(event => event.type === "operation.started"
        && event.data.operation === operation && event.data.retryCount === retryCount);
      if (start < 0) return;
      const trial = events.slice(start + 1);
      if (trial.some(event => event.type === "operation.succeeded" && event.data.operation === operation)) return;
      if (configuring && trial.some(event => event.type === "operation.started" && String(event.data.operation).startsWith("codex."))) return;
      const event = trial.findLast(event => event.type === "codex.diagnostic" && event.data.operation === diagnosticOperation
        && event.data.retryCount === retryCount && event.phase === state.phase
        && ["error", "turn.failed", "exception", "incomplete", "response"].includes(String(event.data.source)));
      if (!event || typeof event.data.artifact !== "string"
        || !/^codex-diagnostic-[0-9a-f-]{36}\.json$/.test(event.data.artifact)) return;
      const diagnostic = this.validate(codexDiagnosticSchema,
        await this.read(join(this.artifactsPath, event.data.artifact), codexDiagnosticSchema));
      if (diagnostic.runId !== this.runId || diagnostic.operation !== diagnosticOperation || diagnostic.phase !== state.phase
        || diagnostic.retryCount !== retryCount || diagnostic.attempt !== event.data.attempt
        || (configuring ? diagnostic.attempt !== 1 : operation !== `codex.${diagnostic.phase}.${diagnostic.attempt}`)
        || diagnostic.source !== event.data.source || diagnostic.threadId !== event.data.threadId) return;
      const output = boundedOutput(diagnosticMessage(diagnostic), this.secrets);
      if (!output.text) return;
      // マスク後に制御文字を除去し、元のメッセージの改行は維持する。
      const safe = output.text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ");
      return safe + (output.truncated || diagnostic.omitted ? "\n（診断の一部省略あり。省略部分は未確認。）" : "");
    } catch { return; }
  }
  async saveValidationSubmission(value: z.infer<typeof validationSubmissionSchema>) {
    await this.ready();
    const parsed = this.validate(validationSubmissionSchema, value);
    const name = `validation-submission-${parsed.attempt}-${parsed.submission}.json`;
    await this.atomic(join(this.artifactsPath, name), JSON.stringify(parsed, null, 2) + "\n");
    await this.appendEvent({ timestamp: new Date().toISOString(), type: "validation.submission", phase: parsed.phase,
      data: { artifact: name, attempt: parsed.attempt, submission: parsed.submission, accepted: parsed.accepted, error: parsed.error } });
    return parsed;
  }
  async loadValidationSubmissions() {
    await this.ready();
    let names: string[];
    try { names = await readdir(this.artifactsPath); } catch { throw new StorageError("io"); }
    return Promise.all(names.filter(name => /^validation-submission-[1-4]-[1-3]\.json$/.test(name)).sort()
      .map(async name => {
        const saved = await this.read(join(this.artifactsPath, name), validationSubmissionSchema);
        if (name !== `validation-submission-${saved.attempt}-${saved.submission}.json`) throw new StorageError("corrupt");
        return saved;
      }));
  }
  async saveArtifact<K extends ArtifactKind>(kind: K, value: z.infer<(typeof artifactSchemas)[K]>, attempt?: number) {
    const parsed = this.validate(artifactSchemas[kind], value);
    if ((kind === "verification" || kind === "review-input") && (parsed as { attempt: number }).attempt !== attempt) throw new StorageError("schema");
    await this.atomic(join(this.artifactsPath, artifactName(kind, attempt)), JSON.stringify(parsed, null, 2) + "\n");
    return parsed;
  }
  async loadArtifact<K extends ArtifactKind>(kind: K, attempt?: number): Promise<z.infer<(typeof artifactSchemas)[K]>> {
    const result = await this.read(join(this.artifactsPath, artifactName(kind, attempt)), artifactSchemas[kind]);
    if ((kind === "verification" || kind === "review-input") && (result as { attempt: number }).attempt !== attempt) throw new StorageError("corrupt");
    return result as z.infer<(typeof artifactSchemas)[K]>;
  }
  private async bundle(name: string, write: () => Promise<void>) {
    await this.ready();
    if ((await readdir(this.artifactsPath)).includes(`${name}.json`)) throw new StorageError("exists");
    const marker = join(this.artifactsPath, `${name}.pending`);
    await this.atomic(marker, "未確定\n");
    await write(); // 失敗時はmarkerを残し、部分保存を正常扱いしない。
    try { await unlink(marker); } catch { throw new StorageError("io"); }
  }
  async savePlan(value: Plan) {
    const plan = this.validate(planSchema, value);
    await this.bundle("plan", async () => {
      await this.saveArtifact("plan", plan);
      await this.atomic(join(this.artifactsPath, "plan.md"), planMarkdown(plan));
    });
    return plan;
  }
  async loadPlan() {
    const plan = await this.loadArtifact("plan");
    let markdown: string;
    try { markdown = await readFile(join(this.artifactsPath, "plan.md"), "utf8"); } catch { throw new StorageError("io"); }
    if (markdown !== planMarkdown(plan)) throw new StorageError("corrupt");
    return { plan, markdown };
  }
  async saveVerification(value: z.infer<typeof verificationSchema>) {
    const verification = this.validate(verificationSchema, value);
    await this.bundle(`verification-${verification.attempt}`, async () => {
      await this.saveArtifact("verification", verification, verification.attempt);
      for (const stream of ["stdout", "stderr"] as const) {
        const log = verification.commands.map(v => `## ${JSON.stringify(v.definition.id)}\n${v[stream].text}\n${v[stream].truncated ? "[出力省略] " + v[stream].omittedReason + "\n" : ""}`).join("\n");
        await this.atomic(join(this.artifactsPath, `verification-${verification.attempt}.${stream}.log`), log);
      }
    });
    return verification;
  }
  async saveVerificationCommand(attempt: number, index: number, value: z.infer<typeof verificationCommandSchema>) {
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 4 || !Number.isSafeInteger(index) || index < 0) throw new StorageError("schema");
    await this.ready();
    const parsed = this.validate(verificationCommandSchema, value);
    await this.atomic(join(this.artifactsPath, `verification-${attempt}.command-${index}.json`), JSON.stringify(parsed, null, 2) + "\n");
    return parsed;
  }
  async loadVerificationCommand(attempt: number, index: number) {
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 4 || !Number.isSafeInteger(index) || index < 0) throw new StorageError("schema");
    return this.read(join(this.artifactsPath, `verification-${attempt}.command-${index}.json`), verificationCommandSchema);
  }
  async saveReviewInput(value: Omit<ReviewInput, "diffId" | "diffArtifact" | "redactions" | "checklist">, rawDiff: string, exclusions: string[] = []) {
    const diff = redact(rawDiff, this.secrets);
    const maskedInput = JSON.stringify(scrub(value, this.secrets)) !== JSON.stringify(value);
    const redactions = [...exclusions, ...(diff !== rawDiff ? ["差分中の認証情報をマスキング。該当箇所は未確認。"] : []),
      ...(maskedInput ? ["文脈・計画・実装・検証入力の認証情報をマスキング。該当箇所は未確認。"] : [])];
    const input = this.validate(reviewInputSchema, { ...value, diffId: diffId(diff), diffArtifact: `review-${value.attempt}.diff`, redactions });
    if (input.baseCommit !== input.verification.baseCommit || input.diffId !== input.verification.diffId || input.attempt !== input.verification.attempt
      || input.verificationArtifact !== `verification-${input.attempt}.json`) throw new StorageError("schema");
    const saved = await this.loadArtifact("verification", input.attempt);
    if (JSON.stringify(saved) !== JSON.stringify(input.verification)) throw new StorageError("schema");
    await this.bundle(`review-input-${input.attempt}`, async () => {
      await this.atomic(join(this.artifactsPath, input.diffArtifact), diff);
      await this.saveArtifact("review-input", input, input.attempt);
    });
    return { input, diff }; // Reviewへはこの確定済みのdiffを渡す。
  }
  async loadReviewInput(attempt: number) {
    const input = await this.loadArtifact("review-input", attempt);
    if (input.diffArtifact !== `review-${attempt}.diff` || input.attempt !== attempt || input.verificationArtifact !== `verification-${attempt}.json`) throw new StorageError("corrupt");
    let diff: string;
    try { diff = await readFile(join(this.artifactsPath, input.diffArtifact), "utf8"); } catch { throw new StorageError("io"); }
    if (diffId(diff) !== input.diffId || JSON.stringify(await this.loadArtifact("verification", attempt)) !== JSON.stringify(input.verification)) throw new StorageError("corrupt");
    return { input, diff };
  }
  async appendEvent(value: RunEvent) {
    const event = this.validate(eventSchema, value);
    const line = JSON.stringify(event) + "\n";
    if (Buffer.byteLength(line) > 262144) throw new StorageError("schema");
    // 破損・末尾の途中行があれば追記で隠さない。
    await this.loadEvents();
    try {
      const handle = await open(join(this.runPath, "events.jsonl"), "a", 0o600);
      try { await handle.writeFile(line); await handle.sync(); } finally { await handle.close(); }
    } catch { throw new StorageError("io"); }
    for (const listener of this.eventListeners) {
      try { listener(structuredClone(event)); } catch { /* 表示は実行制御から分離する。 */ }
    }
  }
  async loadEvents(): Promise<RunEvent[]> {
    let content: string;
    try { content = await readFile(join(this.runPath, "events.jsonl"), "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw new StorageError("io"); }
    if (!content) return [];
    if (!content.endsWith("\n")) throw new StorageError("incomplete");
    try { return content.slice(0, -1).split("\n").map(line => eventSchema.parse(JSON.parse(line))); }
    catch { throw new StorageError("corrupt"); }
  }
}

const gitExec = promisify(execFile);
const sensitivePath = (path: string) => /(^|\/)(\.env(?:\..*)?|\.aws|\.codex|\.ssh|auth\.json|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx))($|\/)/i.test(path);
/** 実indexを触らず、baseから現在の作業ツリーまでを一時indexでパッチ化する。 */
export async function captureReviewDiff(worktreePath: string, baseCommit: string, secrets: readonly string[] = environmentSecrets(), environment: NodeJS.ProcessEnv = process.env) {
  if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new StorageError("schema");
  const dir = await mkdtemp(join(tmpdir(), "harness-diff-"));
  const env = { ...environment, GIT_INDEX_FILE: join(dir, "index") };
  const git = async (args: string[]) => (await gitExec("git", args, { cwd: worktreePath, env, maxBuffer: 16 * 1024 * 1024 })).stdout;
  try {
    await git(["read-tree", "HEAD"]);
    const currentPaths = (await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    const paths = [...new Set([...currentPaths, ...(await git(["ls-tree", "-r", "--name-only", "-z", baseCommit])).split("\0").filter(Boolean)])];
    const excluded = paths.filter(sensitivePath);
    const safe = paths.filter(p => !sensitivePath(p));
    // パスはliteral指定。巨大な引数列は分割してもindexが共通なので累積する。
    const toAdd = currentPaths.filter(p => !sensitivePath(p));
    for (let i = 0; i < toAdd.length; i += 100) await git(["--literal-pathspecs", "add", "-A", "--", ...toAdd.slice(i, i + 100)]);
    const tree = (await git(["write-tree"])).trim();
    // binary patchのbase85には認証値を文字列照合できない。内容を記録せず未確認とする。
    const binaryPaths = new Set<string>();
    const numstat = (await git(["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", baseCommit, tree])).split("\0");
    for (const entry of numstat) if (entry.startsWith("-\t-\t")) binaryPaths.add(entry.slice(4));
    const reviewPaths = safe.filter(p => !binaryPaths.has(p));
    let raw = "";
    for (let i = 0; i < reviewPaths.length; i += 100) raw += await git(["--literal-pathspecs", "diff", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv", baseCommit, tree, "--", ...reviewPaths.slice(i, i + 100)]);
    const diff = redact(raw, secrets);
    return { diff, diffId: diffId(diff), redactions: [...excluded.map(p => `認証ファイルを除外: ${redact(basename(p), secrets)}。該当変更は未確認。`), ...[...binaryPaths].filter(p => !sensitivePath(p)).map(p => `バイナリ内容を除外: ${redact(p, secrets)}。該当変更は未確認。`), ...(raw !== diff ? ["差分中の認証情報をマスキング。該当箇所は未確認。"] : [])] };
  } catch { throw new StorageError("io"); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
