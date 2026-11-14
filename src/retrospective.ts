import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { runIdSchema, eventSchema, planSchema, implementationSchema, verificationSchema, reviewSchema, commitSchema } from "./schemas.js";
import { githubStateSchema } from "./github-state.js";
import { redact, diffId } from "./state.js";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown) => typeof value === "string" ? value : "不明";
const safe = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "�");
export const showLimits = { characters: 24000, phases: 40, events: 20, findings: 3, excerpt: 240 } as const;
import { ShowArgumentError } from "./show-error.js";
export { ShowArgumentError } from "./show-error.js";
export type ShowSelection = { phase?: string; log?: string };
export function parseShowSelection(selection: ShowSelection) {
  const match = selection.phase?.match(/^(plan|implementation|fix|verification|review|commit|report|push|comment|review_state|prepare|start)(?::([1-9]\d*))?$/);
  if (selection.phase !== undefined && !match) throw new ShowArgumentError("--phaseの形式が不正です（例: review:1）。");
  const phase = match?.[1];
  const attempt = Number(match?.[2] ?? 1);
  if (!Number.isSafeInteger(attempt)) throw new ShowArgumentError("フェーズの回数が不正です。");
  if (["implementation", "commit", "report", "prepare", "start"].includes(phase ?? "") && attempt !== 1) throw new ShowArgumentError("このフェーズには1回目だけを指定できます。修正はfix:Nを指定してください。");
  if (selection.log !== undefined && (phase !== "verification" || !selection.log)) throw new ShowArgumentError("--logには--phase verification:Nと空でないコマンドIDが必要です。");
  return { phase, attempt };
}
const fileFor = (phase: string, attempt: number) => ["push", "comment", "review_state"].includes(phase) ? "submission.json" : phase === "fix" ? `implementation-${attempt + 1}.json`
  : phase === "plan" ? `plan-output-${attempt}.json`
  : ["implementation", "review", "verification"].includes(phase) ? `${phase}-${attempt}.json` : `${phase}.json`;
const savedTimestamp = z.iso.datetime();
export const duration = (start: unknown, end: unknown) => {
  const a = typeof start === "string" && savedTimestamp.safeParse(start).success ? Date.parse(start) : NaN;
  const b = typeof end === "string" && savedTimestamp.safeParse(end).success ? Date.parse(end) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? `${((b - a) / 1000).toFixed(1)}秒` : "所要時間不明";
};
const render = (value: unknown) => JSON.stringify(value, null, 2) ?? "null";
const schemas = { plan: planSchema, implementation: implementationSchema, verification: verificationSchema, review: reviewSchema, commit: commitSchema };

type Phase = { phase: string; attempt: number; start?: string | undefined; end?: string | undefined; result?: string; artifact?: string };
/** 読み取り専用。破損した一記録によって他の保存値を捨てない。 */
export async function loadRetrospective(root: string, runId: string, selection: ShowSelection = {}, readText: (path: string) => Promise<string> = path => readFile(path, "utf8"), secrets: readonly string[] = []) {
  if (!runIdSchema.safeParse(runId).success) throw new ShowArgumentError("run IDにはUUIDを指定してください。");
  const selected = parseShowSelection(selection);
  const run = join(root, "runs", runId), artifacts = join(run, "artifacts");
  const warnings: string[] = [];
  const inside = async (path: string) => {
    const base = await realpath(join(root, "runs"));
    const actual = await realpath(path);
    const rel = relative(base, actual);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || !rel.startsWith(`${runId}/`) && rel !== runId) throw new Error("記録外への参照");
    if ((await lstat(path)).isSymbolicLink()) throw new Error("シンボリックリンクは読み取らない");
    return actual;
  };
  const read = async (path: string): Promise<string | undefined> => {
    try { await inside(run); return await readText(await inside(path)); }
    catch (error) { warnings.push(`${relative(run, path) || "実行記録"}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "欠落" : (error as NodeJS.ErrnoException).code === "EACCES" ? "読取不能 (EACCES)" : "読取不能・記録外参照"}`); return undefined; }
  };
  const json = async (path: string) => {
    const text = await read(path);
    if (text === undefined) return undefined;
    try { const value: unknown = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return object(value); }
    catch { warnings.push(`${relative(run, path)}: JSON破損`); return undefined; }
  };
  let names: string[] = [];
  try { await inside(run); names = await readdir(await inside(artifacts)); }
  catch { warnings.push("artifacts: 欠落・読取不能"); }
  for (const name of names) if (/\.(pending|tmp)$/.test(name)) warnings.push(`${name}: 未確定`);
  const state = await json(join(run, "state.json")) ?? {};
  if (state.runId !== undefined && state.runId !== runId) { warnings.push("state.json: run ID不一致（状態を採用しない）"); for (const key of Object.keys(state)) delete state[key]; }
  if (!githubStateSchema.safeParse(state).success) warnings.push("state.json: スキーマ不整合（取得できた保存値のみ表示）");
  const values = new Map<string, RecordValue>();
  for (const name of names.filter(n => /^(plan|validation-plan-[1-4]|validation-submission-[1-4]-[1-3]|implementation-\d+|verification-\d+(?:\.command-\d+)?|review-\d+|commit|report|submission|issue-context|dependency-evidence|repository-selection|restart|plan-(?:output|decision|start|session)-\d+)\.json$/.test(n)).sort()) {
    const value = await json(join(artifacts, name));
    if (value) {
      values.set(name, value);
      const kind = name.split(/[.-]/)[0] as keyof typeof schemas;
      if (schemas[kind] && !name.includes(".command-") && !name.startsWith("plan-") && !schemas[kind].safeParse(value).success) warnings.push(`${name}: スキーマ不整合（保存値を保持）`);
      const numbered = /^(verification|review)-(\d+)\.json$/.exec(name);
      if (numbered && value.attempt !== undefined && value.attempt !== Number(numbered[2])) warnings.push(`${name}: 保存された回数とファイル名が不一致`);
    }
  }
  // 一覧が読めない場合も、指定された既知の成果物を直接読む余地を残す。
  if (selected.phase && !["prepare", "start"].includes(selected.phase)) {
    const name = selection.phase === "plan" ? "plan.json" : fileFor(selected.phase, selected.attempt);
    if (!names.includes(name)) {
      const value = await json(join(artifacts, name));
      if (value) values.set(name, value);
    }
  }
  const events: RecordValue[] = [];
  const raw = await read(join(run, "events.jsonl"));
  if (raw !== undefined) {
    const rows = raw.split("\n");
    if (raw && !raw.endsWith("\n")) warnings.push("events.jsonl: 末尾未確定（完全なJSONのみ表示）");
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i]) continue;
      try {
        const event: unknown = JSON.parse(rows[i]!);
        if (!eventSchema.safeParse(event).success) warnings.push(`events.jsonl:${i + 1}: スキーマ不整合`);
        if (typeof object(event).type === "string" && typeof object(event).phase === "string") events.push(object(event));
      } catch { warnings.push(`events.jsonl:${i + 1}: JSON破損（この行は取得不能）`); }
    }
  }
  const phases: Phase[] = [];
  let active: Phase | undefined;
  const notices: string[] = [];
  const eventAttempts = new Map<RecordValue, number>();
  for (const event of events) {
    const data = object(event.data), phase = string(event.phase), type = string(event.type);
    const attempt = typeof data.attempt === "number" ? data.attempt : 1;
    eventAttempts.set(event, attempt);
    if (type === "phase.running") {
      if (!active || active.phase !== phase || active.attempt !== attempt || active.end) {
        active = { phase, attempt, start: typeof data.commandIndex === "number" ? undefined : typeof event.timestamp === "string" ? event.timestamp : undefined };
        phases.push(active);
      }
      if (data.commandStatus === "failed") notices.push(`${string(event.timestamp)} 検証失敗: ${string(data.commandId)}`);
    } else if (type === "phase.succeeded" || type === "phase.failed") {
      const target = active?.phase === phase && active.attempt === attempt ? active : undefined;
      if (target) { target.end = typeof event.timestamp === "string" ? event.timestamp : undefined; target.result = type.slice(6); }
      else phases.push({ phase, attempt, end: typeof event.timestamp === "string" ? event.timestamp : undefined, result: type.slice(6) });
    } else if (type === "phase.pending") active = undefined;
    if (type === "operation.retry") notices.push(`${string(event.timestamp)} 再試行: ${string(data.operation)} (${data.retryCount})`);
    if (type === "operation.failed") notices.push(`${string(event.timestamp)} 操作失敗: ${string(data.operation)} ${string(data.message)}`);
    if (type === "workflow.stopped") { notices.push(`${string(event.timestamp)} 停止: ${string(data.status)} ${string(data.message)}`); active = undefined; }
    if (type === "blocked.requested") notices.push(`${string(event.timestamp)} blocked要求: ${string(data.blockedReason)}`);
    if ((type === "operation.succeeded" || type === "operation.confirmed") && (data.operation === "report.submit")) notices.push(`${string(event.timestamp)} review提出${type === "operation.confirmed" ? "反映確認" : "処理成功"}: ${data.operation}`);
  }
  for (const name of new Set([...names, ...values.keys()])) {
    const match = /^(implementation|verification|review|commit|report|submission)(?:-(\d+))?\.json$/.exec(name);
    if (!match) continue;
    const number = Number(match[2] ?? 1), phase = match[1] === "implementation" && number > 1 ? "fix" : match[1]!;
    const attempt = phase === "fix" ? number - 1 : number;
    const target = phases.find(p => p.phase === phase && p.attempt === attempt);
    if (target) target.artifact = name;
    else phases.push({ phase, attempt, artifact: name });
  }
  // plan.jsonは正式採用内容であり、試行1の出力ではない。
  for (const name of names) {
    const match = /^plan-(?:output|decision|start|session)-(\d+)\.json$/.exec(name);
    if (!match) continue;
    const attempt = Number(match[1]);
    let target = phases.find(p => p.phase === "plan" && p.attempt === attempt);
    if (!target) { target = { phase: "plan", attempt }; phases.push(target); }
    if (values.has(`plan-output-${attempt}.json`)) target.artifact = `plan-output-${attempt}.json`;
  }
  const acceptedPlans = [...values.entries()].flatMap(([name, value]) => {
    const match = /^plan-decision-(\d+)\.json$/.exec(name);
    return match && value.accepted === true ? [Number(match[1])] : [];
  });
  for (const name of names) {
    const partial = /^verification-(\d+)\.command-\d+\.json$/.exec(name);
    if (partial && !phases.some(p => p.phase === "verification" && p.attempt === Number(partial[1]))) phases.push({ phase: "verification", attempt: Number(partial[1]) });
  }
  const verificationFor = (attempt: number) => {
    const final = values.get(`verification-${attempt}.json`);
    const complete = !!final && Array.isArray(final.commands);
    const partialNames = names.filter(name => new RegExp(`^verification-${attempt}\\.command-\\d+\\.json$`).test(name));
    const commands: unknown[] = complete ? final!.commands as unknown[] : [...values.entries()].filter(([name]) => name.startsWith(`verification-${attempt}.command-`)).sort(([a], [b]) => Number(a.match(/command-(\d+)/)?.[1]) - Number(b.match(/command-(\d+)/)?.[1])).map(([, value]) => value);
    const unavailable = commands.filter(c => !["passed", "failed", "skipped"].includes(string(object(c).status))).length
      + (complete ? 0 : partialNames.filter(name => !values.has(name)).length);
    return { commands, complete, unavailable };
  };
  const heading = [`run ID: ${runId}`, `対象: GitHub / ${string(object(state.issue).url)}`, `保存状態: ${string(state.status)}`, `保存フェーズ: ${string(state.phase)} (${string(state.phaseStatus)})`, `保存された停止理由: ${state.error ? render(state.error) : "記録なし"}`, "runningは現在の稼働を保証しません。completedはreview提出成功でありIssueのcloseではありません。", "保存済み記録のみ。AIによる要約・個別指摘の解消判定は行いません。"];
  heading.push(`実worktree: ${string(state.worktreePath)}`, `再利用元: ${state.previousRunId ?? "なし"}`);
  return { heading, phases, values, events, warnings, notices, acceptedPlans, verificationFor, read, names, artifacts, eventAttempts };
}

export async function retrospective(root: string, runId: string, selection: ShowSelection = {}, readText: (path: string) => Promise<string> = path => readFile(path, "utf8"), secrets: readonly string[] = []): Promise<string> {
  const selected = parseShowSelection(selection);
  const { heading, phases, values, events, warnings, notices, acceptedPlans, verificationFor, read, names, artifacts, eventAttempts } = await loadRetrospective(root, runId, selection, readText, secrets);
  const detailHint = (phase: string, attempt: number) => `harness show ${runId} --phase ${phase}:${attempt}`;
  let body: string;
  if (selected.phase) {
    const { phase, attempt } = selected;
    const name = selection.phase === "plan" ? "plan.json" : fileFor(phase, attempt);
    let value = values.get(name);
    if (phase === "verification") {
      const { commands, complete, unavailable } = verificationFor(attempt);
      if (!complete) warnings.push(`${name}: コマンド総件数不明（最終結果欠落・取得不能）`);
      if (unavailable) warnings.push(`${name}: status不正・取得不能な結果${unavailable}件`);
      if (!value && commands.length) warnings.push(`${name}: 最終結果なし。保存済みコマンド結果のみ表示`);
      value = value ? { ...value, ...(!complete && value.commands !== undefined ? { savedCommands: value.commands } : {}), commands } : commands.length ? { commands } : undefined;
      if (selection.log !== undefined) {
        const matches = commands.filter(c => object(object(c).definition).id === selection.log);
        if (matches.length !== 1) throw new ShowArgumentError(`検証コマンドID ${selection.log} は未保存または重複しています。`);
        body = `正式検証ログ: ${selection.log}\n`;
        for (const key of ["stdout", "stderr"] as const) {
          const stream = object(matches[0])[key];
          const { text, ...metadata } = object(stream);
          body += `\n## "${key}"\n${render(metadata)}\n${typeof stream === "string" ? stream : typeof text === "string" ? text : `本文欠落・取得不能（保存値: ${render(stream)}）`}\n`;
        }
        body += "保存済みの省略・[REDACTED]は復元できません。マスキング履歴がない場合は有無不明。";
      } else {
        body = "ハーネスの正式検証（エージェント自主検証とは別）\n" + render(value ? { ...value, commands: commands.map(c => {
          const command = object(c);
          const streams = Object.fromEntries(["stdout", "stderr"].map(key => { const { text: _text, ...metadata } = object(command[key]); return [key, { ...metadata, text: `本文は --log ${string(object(command.definition).id)} で表示` }]; }));
          return { ...command, ...streams, duration: duration(command.startedAt, command.endedAt) };
        }) } : { unavailable: `${name}: 欠落・取得不能` });
      }
    } else {
      body = `${selection.phase === "plan" ? "Plan全体（正式採用内容と各試行）" : `${phase}:${attempt}`}${phase === "implementation" || phase === "fix" ? "（validationはエージェント自主検証）" : ""}\n${name}\n${value ? render(value) : `${name}: 欠落・取得不能`}`;
      if (phase === "implementation" || phase === "fix") {
        const implementationAttempt = phase === "fix" ? attempt + 1 : 1;
        for (const [name, saved] of values) {
          if (name.startsWith(`validation-submission-${implementationAttempt}-`)) body += `\n${name}\n${render(saved)}`;
        }
      }
      if (phase === "plan") {
        body += `\n正式採用Planの回: ${acceptedPlans.length === 1 ? acceptedPlans[0] : "不明（採用判断の欠落・不整合）"}`;
        for (const [name, value] of values) {
          if (selection.phase === "plan" ? /^plan-/.test(name) : new RegExp(`^plan-(?:start|session|decision)-${attempt}\\.json$`).test(name)) body += `\n${name}\n${render(value)}`;
        }
      }
      if (selection.phase === "plan" && !value) {
        const markdown = await read(join(artifacts, "plan.md"));
        if (markdown !== undefined) body += `\nplan.md（構造化出力欠落時の保存済み本文）\n${markdown}`;
      }
      if (phase === "report") {
        const markdown = await read(join(artifacts, "report.md"));
        if (markdown !== undefined) {
          body += `\nreport.md\n${markdown}`;
          if (names.includes("report.md.sha256")) {
            const digest = await read(join(artifacts, "report.md.sha256"));
            if (digest !== undefined && digest !== diffId(markdown)) warnings.push("report.md: 保存済みハッシュと不一致（本文の整合性未確認）");
          } else warnings.push("report.md: 保存済みハッシュなし（本文の整合性未確認）");
        }
      }
      if (["prepare", "start"].includes(phase)) body = render(events.filter(e => e.phase === phase && eventAttempts.get(e) === attempt));
    }
  } else {
    const excerpt = (value: unknown, hint: string) => { const text = safe(redact(string(value), secrets)); return text.length > showLimits.excerpt ? `${text.slice(0, showLimits.excerpt)}… [省略: ${hint}]` : text; };
    const lines: string[] = ["工程（イベント順。イベントのない成果物は後段に表示）"];
    if (values.has("plan.json")) lines.push(`正式採用Plan: ${acceptedPlans.length === 1 ? `plan:${acceptedPlans[0]}（保存済み採用判断）` : "回数不明（採用判断の欠落・不整合）"}。harness show ${runId} --phase plan`);
    for (const p of phases.slice(0, showLimits.phases)) {
      const hint = detailHint(p.phase, p.attempt);
      const value = values.get(p.artifact ?? fileFor(p.phase, p.attempt));
      lines.push(`${p.phase}:${p.attempt} ${p.result ?? "終了記録なし"} ${duration(p.start, p.end)}${p.start ? " 開始=" + p.start : " 開始記録なし"}`);
      if (p.phase === "plan") {
        const decision = values.get(`plan-decision-${p.attempt}.json`);
        lines.push(`  保存済み採用判断: ${decision?.accepted === true ? "採用" : decision?.accepted === false ? "不採用" : "不明"} / 出力: ${fileFor("plan", p.attempt)}`);
      }
      if (p.phase === "review") {
        const findings = list(value?.findings);
        const verdict = events.filter(e => e.type === "review.assessed" && object(e.data).attempt === p.attempt).at(-1);
        lines.push(`  保存判定: ${string(object(verdict?.data).decision ?? value?.verdict)} ${Array.isArray(value?.findings) ? `critical=${findings.filter(f => object(f).severity === "critical").length} major=${findings.filter(f => object(f).severity === "major").length} minor=${findings.filter(f => object(f).severity === "minor").length}` : "指摘件数不明（findings欠落・取得不能）"}`);
        for (const f of findings.slice(0, showLimits.findings)) lines.push(`  ${string(object(f).severity)}: ${excerpt(object(f).description, hint)}`);
        if (findings.length > showLimits.findings) lines.push(`  指摘${findings.length - showLimits.findings}件省略: ${hint}`);
      }
      if (p.phase === "implementation" || p.phase === "fix") lines.push(`  変更要約: ${excerpt(value?.summary, hint)}`);
      if (p.phase === "verification") {
        const { commands, complete, unavailable } = verificationFor(p.attempt);
        if (!complete && !commands.length) lines.push(`  正式検証: 成功・失敗・未実施の件数不明（結果欠落・取得不能） 取得不能=${unavailable || "件数不明"}`);
        else lines.push(`  正式検証: ${!complete || unavailable ? "取得できた結果のみ " : ""}成功=${commands.filter(c => object(c).status === "passed").length} 失敗=${commands.filter(c => object(c).status === "failed").length} 未実施=${commands.filter(c => object(c).status === "skipped").length}${complete ? "" : "（最終結果未保存・部分記録）"}${unavailable ? ` 取得不能=${unavailable}（status不正・読取不能。全体の成功・失敗・未実施の内訳は不明）` : ""}${complete ? "" : " 総件数不明"}`);
      }
      if (!value && !["prepare", "start"].includes(p.phase)) lines.push(`  成果物欠落・取得不能: ${hint}`);
    }
    if (phases.length > showLimits.phases) lines.push(`工程${phases.length - showLimits.phases}件省略: ${detailHint(phases[showLimits.phases]!.phase, phases[showLimits.phases]!.attempt)}`);
    lines.push("主な出来事", ...notices.slice(0, showLimits.events));
    if (notices.length > showLimits.events) lines.push(`出来事${notices.length - showLimits.events}件省略。${detailHint("report", 1)}。全イベントはevents.jsonlを参照。`);
    if (!phases.length) lines.push("工程記録なし・取得不能");
    body = lines.join("\n");
  }
  if (selected.phase === "verification") {
    const resolution = values.get(`validation-plan-${selected.attempt}.json`);
    if (resolution) body += "\nコマンド開始前に確定した計画・更新履歴\n" + render(resolution);
  }
  if (selected.phase) body += "\n工程記録\n" + render(phases.filter(p => p.phase === selected.phase && (selection.phase === "plan" || p.attempt === selected.attempt)).map(p => ({ ...p, duration: duration(p.start, p.end) })));
  let output = safe(redact([...heading, body, ...warnings.map(w => `注意: ${w}`)].join("\n"), secrets));
  if (!selected.phase && output.length > showLimits.characters) {
    const lastPhase = [...output.slice(0, showLimits.characters - 300).matchAll(/^(plan|implementation|verification|review|fix|commit|report|push|comment|review_state|prepare|start):(\d+)/gm)].at(-1);
    const hint = lastPhase ? detailHint(lastPhase[1]!, Number(lastPhase[2])) : "保存状態の全文はstate.jsonを参照";
    const note = `\n[通常表示の文字数上限で省略。${hint}。出来事の全文はevents.jsonlを参照]\n`;
    output = output.slice(0, showLimits.characters - note.length) + note;
  }
  return output + "\n";
}

export type PagerOptions = { enabled: boolean; stdinIsTTY: boolean; stdoutIsTTY: boolean; lines?: number; pager?: (text: string) => Promise<void> };
/** lessにシェルを介さず渡す。端末上のq終了/EPIPEは正常な閲覧終了。 */
export async function pageRetrospective(text: string, options: PagerOptions, out: (text: string) => void, err: (text: string) => void) {
  if (!options.enabled || !options.stdinIsTTY || !options.stdoutIsTTY || text.split("\n").length < (options.lines ?? 24) && text.length < 4000) { out(text); return; }
  try {
    await (options.pager ?? (content => new Promise<void>((resolve, reject) => {
      const child = spawn("less", ["-F", "-X"], { stdio: ["pipe", "inherit", "inherit"], env: { PATH: process.env.PATH, TERM: process.env.TERM, LANG: process.env.LANG, LESSSECURE: "1", LESSHISTFILE: "-" } });
      child.on("error", reject);
      child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
      child.on("close", code => code === 0 ? resolve() : reject(new Error(`less終了: ${code}`)));
      child.stdin.end(content);
    })))(text);
  } catch { err("ページャーを利用できないため直接表示します。\n"); out(text); }
}
