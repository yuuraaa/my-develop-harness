/** このハーネスが使う構造化出力の制約を直接検査する。API全体の模倣ではない。 */
export function outputSchemaViolations(schema: unknown): string[] {
  const violations: string[] = [];
  function visit(value: unknown, path: string) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((item, i) => visit(item, `${path}[${i}]`)); return; }
    const node = value as Record<string, unknown>;
    if (node.type === "object" || node.properties) {
      if (node.additionalProperties !== false) violations.push(`${path}: additionalProperties must be false`);
      const keys = Object.keys((node.properties ?? {}) as object);
      const required = Array.isArray(node.required) ? node.required : [];
      for (const key of keys) if (!required.includes(key)) violations.push(`${path}: required missing ${key}`);
      for (const key of required) if (!keys.includes(String(key))) violations.push(`${path}: unknown required ${key}`);
    }
    for (const [key, child] of Object.entries(node)) visit(child, `${path}.${key}`);
  }
  const root = schema as Record<string, unknown> | undefined;
  if (root?.type !== "object" || root.anyOf) violations.push("$: root must be an object without anyOf");
  visit(schema, "$");
  return violations;
}
