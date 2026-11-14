import { issueReportDraftSchema } from "../src/github-report.js";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { planOutputSchema, implementationOutputSchema, validationRepairSchema, implementationSchema } from "../src/schemas.js";
import { outputSchemaViolations } from "./helpers/output-schema.js";

describe("構造化出力スキーマのAPI制約", () => {
  it("Plan候補の必須nullableを含む全階層にrequired漏れ・追加キー許可がない", () => {
    const schema = z.toJSONSchema(planOutputSchema, { target: "draft-7" });
    expect(outputSchemaViolations(schema)).toEqual([]);
    expect(schema.required).toEqual(["plan", "branchName"]);
  });

  it("Implementationと再提出のAPI schemaは全階層strictでID removeだけを受理", () => {
    for (const schema of [implementationOutputSchema, validationRepairSchema]) {
      expect(outputSchemaViolations(z.toJSONSchema(schema, { target: "draft-7" }))).toEqual([]);
    }
    const remove = { operation: "remove", id: "prepare-image", reason: "実行順変更" };
    expect(validationRepairSchema.safeParse({ validationPlanUpdates: [remove] }).success).toBe(true);
    expect(validationRepairSchema.safeParse({ validationPlanUpdates: [{ ...remove, definition: {} }] }).success).toBe(false);
  });
});
