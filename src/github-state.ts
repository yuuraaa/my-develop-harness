import { z } from "zod";
import { workspaceRunSchema } from "./github-workspace-store.js";
import { errorSchema } from "./schemas.js";

export const githubStateSchema = workspaceRunSchema.extend({
  issue: workspaceRunSchema.shape.issue.extend({ url: z.url() }),
  phase: z.enum(["prepare", "plan", "start", "implementation", "verification", "review", "fix", "commit", "report", "push", "comment", "review_state"]),
  status: z.enum(["running", "completed", "stopped", "blocked"]),
  phaseStatus: z.enum(["pending", "running", "succeeded", "failed"]), fixCount: z.number().int().min(0).max(3),
  retryCount: z.record(z.string().min(1), z.number().int().min(0).max(2)), codexThreadId: z.string().nullable(),
  reviewThreadIds: z.array(z.string()), resultCommits: z.array(z.string().regex(/^[a-f0-9]{40,64}$/)),
  reviewedTreeId: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), verificationArtifact: z.string().nullable(),
  submissionArtifact: z.string().nullable(), error: errorSchema.nullable(), updatedAt: z.iso.datetime(),
  startTransition: z.enum(["not_started", "in_flight", "succeeded", "failed", "unknown"]),
  stopReflection: z.object({ status: z.enum(["not_started", "succeeded", "failed", "unknown"]),
    message: z.string().nullable() }),
});
export type GitHubRunState = z.infer<typeof githubStateSchema>;
