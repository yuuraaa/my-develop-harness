import { z } from "zod";
import { runIdSchema, phaseSchema } from "./schemas.js";

const detailSchema = z.strictObject({
  name: z.string().optional(), message: z.string().optional(), code: z.union([z.string(), z.number()]).optional(),
  errno: z.union([z.string(), z.number()]).optional(), syscall: z.string().optional(),
  exitCode: z.number().int().optional(), signal: z.string().optional(),
});
export const codexDiagnosticSchema = z.strictObject({
  runId: runIdSchema, phase: phaseSchema, attempt: z.number().int().positive(), retryCount: z.number().int().min(0).max(2),
  operation: z.string().min(1), threadId: z.string().nullable(), timestamp: z.iso.datetime(),
  source: z.enum(["error", "turn.failed", "item.error", "mcp.error", "exception", "incomplete", "response"]),
  details: z.array(detailSchema).max(5), omitted: z.boolean(),
});
export type CodexDiagnostic = z.infer<typeof codexDiagnosticSchema>;
export type DiagnosticDetail = Pick<CodexDiagnostic, "source" | "details" | "omitted">;

/** 保存済みの文言をそのまま表示する。例外のcauseと終了情報も落とさない。 */
export function diagnosticMessage(diagnostic: CodexDiagnostic): string {
  return diagnostic.details.map(detail => [
    detail.message,
    ...(["code", "errno", "syscall", "exitCode", "signal"] as const)
      .filter(key => detail[key] !== undefined).map(key => `${key}: ${detail[key]}`),
  ].filter(value => value !== undefined && value !== "").join("\n")).filter(Boolean).join("\n");
}

/** 例外の列挙可能プロパティ・stack・環境・生イベントは保存しない。causeは循環と深さを制限する。 */
export function diagnosticDetail(source: DiagnosticDetail["source"], value: unknown): DiagnosticDetail {
  const details: CodexDiagnostic["details"] = [];
  const seen = new Set<unknown>();
  while (value !== undefined && value !== null && details.length < 5 && !seen.has(value)) {
    seen.add(value);
    if (typeof value === "string") { details.push({ message: value }); value = undefined; break; }
    if (typeof value !== "object") break;
    const object = value as Record<string, unknown>;
    const detail: z.infer<typeof detailSchema> = {};
    for (const key of ["name", "message", "syscall", "signal"] as const) {
      if (typeof object[key] === "string") detail[key] = object[key];
    }
    for (const key of ["code", "errno"] as const) {
      if (typeof object[key] === "string" || typeof object[key] === "number" && Number.isFinite(object[key])) detail[key] = object[key];
    }
    if (Number.isSafeInteger(object.exitCode)) detail.exitCode = object.exitCode as number;
    details.push(detail);
    value = object.cause;
  }
  return { source, details, omitted: value !== undefined && value !== null };
}
