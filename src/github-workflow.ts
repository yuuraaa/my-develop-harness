import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CodexPhases, createCodexConnection, type PhaseConnection } from "./codex.js";
import { GitHubClient, githubRunRecorder } from "./github.js";
import { githubTokens, type GitHubConfig } from "./github-config.js";
import { fetchIssueContext, evaluateIssueEligibility, localCommitFiles, saveIssueContext, type IssueContext } from "./github-context.js";
import { normalizeIssueReference, type Issue, type IssueApi } from "./github-issue.js";
import { acquireIssueRepository, inspectIssueRepository, repositoryTransport, workspaceGit, type RepositoryTransport } from "./github-repository.js";
import { prepareIssueWorkspace, planIssueBranch, type PreparedIssueWorkspace } from "./github-workspace.js";
import type { WorkspaceIdentity } from "./github-workspace-store.js";
import { GitHubControl, GitHubWorkflowStopped, githubFailure } from "./github-control.js";
import type { IssueWriteApi } from "./github-labels.js";
import type { GitHubRunState } from "./github-state.js";
import { reviewImplementation } from "./review.js";
import { environmentSecrets, redact, type RunStore } from "./state.js";
import { WorkflowError } from "./workflow.js";
import { issueInputSchema } from "./schemas.js";
import { verifyResultCommits, type GitCommand } from "./git.js";
import { submitIssueResult } from "./github-submission.js";

export type IssueRunOptions = {
  store: RunStore; config: GitHubConfig; issue: string; repositoryPath?: string; env?: NodeJS.ProcessEnv;
  api?: IssueWriteApi; git?: GitCommand; transport?: RepositoryTransport;
  connection?: (worktree: string) => Promise<PhaseConnection>;
  onStopped?: (stopped: GitHubWorkflowStopped) => void;
};
const identity = (issue: Issue): WorkspaceIdentity => ({ host: "github.com", repositoryId: issue.repositoryId,
  repository: issue.repository, issueId: issue.id, number: issue.number });

/** 開始文脈の二段階取得（関係→開始SHAの資料）で、Issue本文を途中で差し替えない。 */
function contextSnapshot(api: IssueApi): IssueApi {
  const single = new Map<string, Promise<unknown>>(), pages = new Map<string, Promise<unknown[]>>();
  return {
    async get<T>(endpoint: string): Promise<T> {
      if (!single.has(endpoint)) single.set(endpoint, api.get(endpoint));
      return structuredClone(await single.get(endpoint)) as T;
    },
    async getPages<T>(endpoint: string): Promise<T[]> {
      if (!pages.has(endpoint)) pages.set(endpoint, api.getPages(endpoint));
      return structuredClone(await pages.get(endpoint)) as T[];
    },
  };
}
async function restartInputs(restart: PreparedIssueWorkspace["restart"]): Promise<IssueContext["previousInputs"]> {
  if (!restart) return [];
  const result = [{ source: "restart.diff", body: restart.cumulativeDiff }, { source: "restart.instructions", body: restart.instructionDiff }];
  for (const path of restart.previousRuns) {
    result.push({ source: join(path, "state.json"), body: await readFile(join(path, "state.json"), "utf8") });
    for (const name of await readdir(join(path, "artifacts"))) {
      if (/^(?:plan(?:-(?:output|decision)-[1-3])?|implementation-[1-4]|verification-[1-4]|review-[1-4]|commit)\.json$/.test(name))
        result.push({ source: join(path, "artifacts", name), body: await readFile(join(path, "artifacts", name), "utf8") });
    }
  }
  return result;
}

/** 手動Issue run。正式検証・独立Review・コミット後に三段階で提出する。 */
export async function runIssueWorkflow(options: IssueRunOptions): Promise<GitHubRunState["status"]> {
  const reference = normalizeIssueReference(options.issue), { store, config } = options;
  const tokens = githubTokens(config, options.env), secrets = [...environmentSecrets(options.env), tokens.write, tokens.read];
  store.protectSecrets(secrets);
  await store.initializeGitHub();
  let control: GitHubControl | undefined;
  try {
    await store.saveJson("prepare-input.json", { ...reference, repositoryPath: options.repositoryPath ?? null });
    const api = options.api ?? await GitHubClient.create(config, { ...(options.env ? { env: options.env } : {}),
      record: event => githubRunRecorder(store, control?.githubSnapshot().phase as "prepare" | undefined)(event) });
    const frozen = contextSnapshot(api);
    let context = await fetchIssueContext(frozen, config, reference.url);
    const issue = { ...identity(context.target.issue), url: context.target.issue.url };
    const state: GitHubRunState = { schemaVersion: 2, backend: "github", runId: store.runId, issue,
      managementIssue: identity(context.managementIssue), repositoryPath: null, worktreePath: null,
      previousRunId: null, worktreeOriginRunId: store.runId, branchName: null, workBranchName: null, branchRecordPath: null,
      baseCommit: null, restartHead: null, remoteStartCommit: null, phase: "prepare", status: "running", phaseStatus: "running",
      fixCount: 0, retryCount: {}, codexThreadId: null, reviewThreadIds: [], resultCommits: [], reviewedTreeId: null,
      verificationArtifact: null, submissionArtifact: null, error: null, updatedAt: new Date().toISOString(),
      startTransition: "not_started", stopReflection: { status: "not_started", message: null } };
    await store.saveGitHubState(state);
    control = new GitHubControl(store, state, api, config, secrets);
    const flow = control;
    return await flow.execute({ operation: "github.run", confirmRetry: async () => ({ outcome: "uncertain" }), run: async () => {
      await flow.recordPhase("prepare", "running");
      const basic = await evaluateIssueEligibility(frozen, config, { ...context, dependencies: [], sourcesComplete: true });
      if (basic.status !== "ready") {
        await saveIssueContext(store.artifactsPath, context, basic, secrets);
        throw new WorkflowError("business", basic.reasons.join("\n"));
      }
      const login = z.object({ login: z.string().min(1) }).parse(await api.get("/user")).login;
      const git = options.git ?? await workspaceGit({ ...(options.env ? { env: options.env } : {}), secrets });
      const selection = await inspectIssueRepository(reference.repository, config, git, options.repositoryPath);
      await store.saveJson("repository-selection.json", selection);
      const transport = options.transport ?? repositoryTransport({ repository: reference.repository, token: tokens.write,
        ...(options.env ? { env: options.env } : {}), record: githubRunRecorder(store) });
      const path = await acquireIssueRepository(selection, git, transport);
      const management = context.managementIssue;
      const managementContent = { title: management.title, body: management.body,
        comments: (context.ancestors.find(d => d.issue.id === management.id && d.issue.repositoryId === management.repositoryId) ?? context.target).comments.map(c => c.body) };
      const savePrepared = async (p: PreparedIssueWorkspace) => {
        await flow.patch({ repositoryPath: p.repositoryPath, worktreePath: p.worktreePath, previousRunId: p.previousRunId,
          worktreeOriginRunId: p.worktreeOriginRunId, branchName: p.branchName, workBranchName: p.workBranchName,
          branchRecordPath: p.branchRecordPath, baseCommit: p.baseCommit, restartHead: p.restartHead, remoteStartCommit: p.remoteStartCommit });
        if (p.warnings.length) await store.appendEvent({ timestamp: new Date().toISOString(), type: "workspace.warnings", phase: "prepare", data: { warnings: p.warnings } });
      };
      let prepared = await prepareIssueWorkspace({ root: store.root, runId: store.runId, issue, managementIssue: identity(management),
        managementContent, repositoryPath: path, pushRemote: selection.pushRemote, git, transport, savePrepared,
        redact: text => redact(text, secrets), confirmStart: async (startCommit, checkInclusion, restart) => {
          context = await fetchIssueContext(frozen, config, reference.url, { startCommit, commitFiles: localCommitFiles(path, git), previousInputs: await restartInputs(restart) });
          const eligibility = await evaluateIssueEligibility(frozen, config, context, { harnessLogin: login, checkInclusion });
          await saveIssueContext(store.artifactsPath, context, eligibility, secrets);
          if (eligibility.status !== "ready") throw new WorkflowError("business", eligibility.reasons.join("\n"));
        } });
      await flow.recordPhase("prepare", "succeeded");
      if (prepared.restart) await store.saveJson("restart.json", prepared.restart);
      const input = issueInputSchema.parse({ issue: { ...context.target.issue, id: issue.issueId,
        description: context.target.issue.body ?? "", acceptanceCriteria: "Issue本文の要件・完了条件を基準とする。特定の見出しを必須にしない。",
        comments: context.target.comments, issueContext: context },
        repositoryInstructions: context.files.filter(f => f.appliesTo !== null).map(f => `${f.source}\n適用先: ${f.appliesTo}\n${f.body}`) });
      await store.saveArtifact("issue-input", input);
      const execution = config.execution;
      const connection = await (options.connection ? options.connection(prepared.worktreePath) : createCodexConnection({ worktreePath: prepared.worktreePath,
        github: config, ...(execution?.codexHome ? { codexHome: execution.codexHome } : {}),
        ...(execution?.model ? { model: execution.model } : {}), ...(options.env ? { env: options.env } : {}) }));
      const phases = new CodexPhases({ control: flow, connection, git, ...(execution?.gitIdentity ? { gitIdentity: execution.gitIdentity } : {}), block: flow.block });
      let accepted: Awaited<ReturnType<CodexPhases["issuePlan"]>> | undefined;
      prepared = await planIssueBranch(prepared, { root: store.root, git, transport, savePrepared, managementContent,
        plan: async request => {
          accepted = await phases.issuePlan(input, { ...request, restart: prepared.restart });
          return accepted.branchName;
        } });
      if (!accepted) throw new WorkflowError("fatal", "採用するPlanがありません");
      await store.savePlan(accepted.plan);
      await flow.recordCodexSession(accepted.threadId, false);
      await flow.recordPhase("plan", "succeeded");
      await flow.start();
      // CodexPhasesの実装開始条件へ戻す。外部への着手確認はstate/eventsに保持済み。
      await flow.recordPhase("plan", "succeeded");
      await phases.implementation(input);
      await reviewImplementation({ control: flow, phases, block: flow.block });
      await phases.commit();
      const commits = await verifyResultCommits(flow.snapshot(), git);
      if (JSON.stringify(commits) !== JSON.stringify(flow.githubSnapshot().resultCommits)) throw new WorkflowError("fatal", "保存済み成果コミットが不一致です");
      await phases.issueReport();
      return submitIssueResult({ control: flow, api, config, prepared, pushRemote: selection.pushRemote, transport, git });
    } });
  } catch (error) {
    if (error instanceof GitHubWorkflowStopped) { options.onStopped?.(error); return error.state.status; }
    if (control) {
      try { await control.stop(error, "github.run"); } catch (stopped) { if (stopped instanceof GitHubWorkflowStopped) { options.onStopped?.(stopped); return stopped.state.status; } throw stopped; }
    }
    await store.saveJson("prepare-failure.json", { error: githubFailure(error).message, status: "stopped", issue: reference });
    return "stopped";
  }
}
