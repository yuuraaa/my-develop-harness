/** Gitとworkflowの循環初期化を避ける共通エラー定義。 */
export type FailureClassification = "transient" | "fatal" | "business" | "validation" | "blocker" | "uncertain";
export class WorkflowError extends Error {
  constructor(public readonly classification: FailureClassification, message: string) {
    super(message); this.name = "WorkflowError";
  }
}
