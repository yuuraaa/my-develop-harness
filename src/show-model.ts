import { join } from "node:path";
import { loadRetrospective, duration } from "./retrospective.js";
import { redact, diffId } from "./state.js";

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === "string" ? v : "不明";
const json = (v: unknown) => JSON.stringify(v, null, 2) ?? "null";
const clean = (v: string, secrets: readonly string[]) => redact(v, secrets).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "�");
export type ShowPhase = { name: string; result: string; duration: string; assessment: string; detail: string };
export type ShowModel = { heading: string[]; phases: ShowPhase[] };
// 保存した文字列は改行を保って表示。未知項目・不正型も捨てない。
function fields(value: unknown, prefix = ""): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.map((v, i) => `${prefix}[${i + 1}]\n${fields(v, prefix + "  ")}`).join("\n");
  if (value && typeof value === "object") return Object.keys(value).length === 0 ? "{}" : Object.entries(value).map(([k, v]) => `${prefix}${k}:\n${fields(v, prefix + "  ")}`).join("\n");
  return json(value);
}
export async function loadShowModel(root: string, runId: string, secrets: readonly string[] = []): Promise<ShowModel> {
  const m = await loadRetrospective(root, runId, {}, undefined, secrets);
  const phases: ShowPhase[] = [];
  // 正式Planの全文へ到達できる。
  if (!m.phases.some(p => p.phase === "plan") && m.values.has("plan.json")) m.phases.push({ phase: "plan", attempt: 1 });
  for (const p of m.phases) {
    const name = p.artifact ?? (["push", "comment", "review_state"].includes(p.phase) ? "submission.json" : p.phase === "fix" ? `implementation-${p.attempt + 1}.json`
      : p.phase === "plan" ? `plan-output-${p.attempt}.json`
      : ["implementation", "review", "verification"].includes(p.phase) ? `${p.phase}-${p.attempt}.json` : `${p.phase}.json`);
    const saved = m.values.get(name);
    let assessment = "—";
    if (p.phase === "plan") assessment = `採用判断: ${m.values.get(`plan-decision-${p.attempt}.json`)?.accepted === true ? "採用" : m.values.get(`plan-decision-${p.attempt}.json`)?.accepted === false ? "不採用" : "不明"}`;
    if (p.phase === "review") {
      const decision = m.events.filter(e => e.type === "review.assessed" && object(e.data).attempt === p.attempt).at(-1);
      const findings = Array.isArray(saved?.findings) ? saved.findings : undefined;
      assessment = `${text(object(decision?.data).decision ?? saved?.verdict)} / ${findings ? `指摘${findings.length} major ${findings.filter(f => object(f).severity === "major").length}` : "指摘件数不明"}`;
    }
    if (p.phase === "verification") {
      const v = m.verificationFor(p.attempt);
      assessment = !v.complete && !v.commands.length ? "検証件数不明" : `成功${v.commands.filter(c => object(c).status === "passed").length}/失敗${v.commands.filter(c => object(c).status === "failed").length}/未実施${v.commands.filter(c => object(c).status === "skipped").length}${!v.complete || v.unavailable ? "（部分記録・総件数/内訳不明）" : ""}`;
    }
    const parts = [["ハーネス固定情報", `${p.phase}:${p.attempt} / 工程処理: ${p.result ?? "終了記録なし"} / 所要時間: ${duration(p.start, p.end)}`, assessment,
      m.heading[4] ?? "停止理由不明", "保存時の省略・[REDACTED]等のマスキングは復元できません。履歴がなければ有無不明。"].join("\n")];
    if (saved) {
      const { summary, findings, ...rest } = saved;
      if (summary !== undefined) parts.push(`${["verification", "commit"].includes(p.phase) ? "ハーネス保存情報" : "エージェント出力"} · ${p.phase === "implementation" || p.phase === "fix" ? "変更要約" : "要約"}`, fields(summary));
      if (Array.isArray(findings) && findings.length === 0) parts.push("エージェント出力 · 指摘0件", "[]");
      if (Array.isArray(findings)) findings.forEach((f, i) => parts.push(`エージェント出力 · 指摘 ${i + 1}/${findings.length} · ${text(object(f).severity)}`, fields(f)));
      else if (findings !== undefined) parts.push("エージェント出力 · 指摘（形式不明）", fields(findings));
      parts.push(p.phase === "verification" || p.phase === "commit" ? "ハーネス保存情報 · 全項目" : "エージェント出力 · その他の保存項目", fields(rest));
    } else if (!["prepare", "start"].includes(p.phase)) parts.push(`${name}: 欠落・取得不能`);
    if (p.phase === "verification") {
      const v = m.verificationFor(p.attempt);
      if (!v.complete) parts.push("ハーネス正式検証 · 保存済み部分結果（総件数不明）", fields(v.commands));
      const resolution = m.values.get(`validation-plan-${p.attempt}.json`);
      if (resolution) parts.push("ハーネス固定情報 · 検証計画と更新履歴", fields(resolution));
    }
    if (p.phase === "plan") {
      for (const [n, v] of m.values) if (n === "plan.json" || new RegExp(`^plan-(?:start|session|decision)-${p.attempt}\\.json$`).test(n)) parts.push(`${n === "plan.json" ? "エージェント出力 · 正式採用Plan" : "ハーネス固定情報"} · ${n}`, fields(v));
      if (!m.values.has("plan.json")) {
        const md = await m.read(join(m.artifacts, "plan.md"));
        if (md !== undefined) parts.push("エージェント出力 · plan.md（保存済み本文）", md);
      }
    }
    if (p.phase === "implementation" || p.phase === "fix") for (const [n, v] of m.values) {
      if (n.startsWith(`validation-submission-${p.phase === "fix" ? p.attempt + 1 : 1}-`)) parts.push(`保存情報 · ${n}`, fields(v));
    }
    if (p.phase === "report") {
      const md = await m.read(join(m.artifacts, "report.md"));
      if (md !== undefined) {
        parts.push("エージェント出力 · report.md", md);
        const hash = m.names.includes("report.md.sha256") ? await m.read(join(m.artifacts, "report.md.sha256")) : undefined;
        if (hash !== diffId(md)) parts.push("注意: report.mdの保存済みハッシュなし・不一致（本文の整合性未確認）");
      }
    }
    parts.push("ハーネス固定情報 · 実行概要", m.heading.join("\n"), "ハーネス固定情報 · 工程記録", fields(p), "ハーネス固定情報 · 保存イベント", fields(m.events.filter(e => e.phase === p.phase && m.eventAttempts.get(e) === p.attempt)));
    phases.push({ name: `${p.phase}:${p.attempt}`, result: p.result ?? "終了記録なし", duration: duration(p.start, p.end), assessment, detail: parts.join("\n\n") });
  }
  const warnings = m.warnings.map(w => `注意: ${w}`).join("\n");
  for (const p of phases) { p.detail = clean(`${p.detail}\n\n${warnings}`, secrets); p.assessment = clean(p.assessment, secrets); p.name = clean(p.name, secrets); p.result = clean(p.result, secrets); }
  if (!phases.length) phases.push({ name: "記録なし", result: "不明", duration: "不明", assessment: "工程記録なし・取得不能", detail: clean([...m.heading, warnings].join("\n"), secrets) });
  return { heading: m.heading.map(h => clean(h, secrets)), phases };
}
