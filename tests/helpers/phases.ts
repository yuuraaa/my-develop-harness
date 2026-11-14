import { CodexPhases } from "../../src/codex.js";
import type { IssueInput } from "../../src/schemas.js";
import type { DevelopmentControl } from "../../src/workflow.js";
export class TestPhases extends CodexPhases {
  private readonly testControl: DevelopmentControl;
  constructor(options: ConstructorParameters<typeof CodexPhases>[0]) { super(options); this.testControl = options.control; }
  async plan(context: IssueInput) {
    return this.testControl.execute({ operation: "plan.accept", run: async () => {
    if (this.testControl.snapshot().codexThreadId) throw new Error("Planは採用済みです");
    const output = await this.issuePlan(context, { attempt: 1, branchName: this.testControl.snapshot().branchName,
      reason: null, managementContent: context, namingInstruction: "確定済みブランチを使う", restart: null });
    const plan = await this.testControl.store.savePlan(output.plan);
    await this.testControl.recordCodexSession(output.threadId, false);
    await this.testControl.recordPhase("plan", "succeeded");
    return plan;
    }, confirmRetry: async () => ({ outcome: "uncertain" }) });
  }
}
