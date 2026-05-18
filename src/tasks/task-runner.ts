import type { Candidate } from "../board/index.ts";
import type { BoardTransitionService } from "../github/index.ts";
import type { SqliteWorkflowStore } from "../state/index.ts";
import type { TaskDefinition, WorkflowGraph } from "../workflow/index.ts";
import { renderPrompt } from "../workflow/index.ts";
import type {
  IssueContextLoader,
  PiSessionFactory,
  PrTemplateLoader,
} from "./types.ts";

/**
 * Minimal logger surface used by the {@link TaskRunner}.
 */
export interface TaskRunnerLogger {
  log: (msg: string) => void;
  error: (msg: string) => void;
  warn?: (msg: string) => void;
}

/**
 * Subset of {@link WorkspaceProvisioner} the Task Runner uses. Kept as a
 * structural type so tests can inject a tiny fake without depending on
 * the production provisioner's git plumbing.
 */
export interface TaskWorkspaceProvisioner {
  provision(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    expectedRemote: string;
  }): Promise<
    | {
        kind: "provisioned";
        repoPath: string;
        worktreePath: string;
        taskBranch: string;
        baseBranch: string;
      }
    | { kind: "skipped"; reason: string }
  >;
}

/**
 * Worktree cleanup hook. The POC TaskRunner does not touch the worktree
 * itself on success (the Pi session is the agent that ran the work).
 * The handle exists for future failure-path policies; we accept it as a
 * dep so the Orchestrator can supply a single cleanup instance.
 */
export interface TaskWorktreeCleanup {
  deleteWorktree(worktreePath: string): Promise<void>;
  preserveWorktree(worktreePath: string): Promise<void>;
}

/**
 * Subset of {@link BoardTransitionService} the Task Runner uses. Kept
 * structural so tests can drop in a recording fake.
 */
export interface TaskTransitionService {
  applyTransition(input: {
    projectItemId: string;
    toStatus: string;
  }): Promise<void>;
}

export interface TaskRunnerDeps {
  workflowGraph: WorkflowGraph;
  workspaceProvisioner: TaskWorkspaceProvisioner;
  issueContextLoader: IssueContextLoader;
  piSessionFactory: PiSessionFactory;
  transitionService: TaskTransitionService;
  store: SqliteWorkflowStore;
  /** Optional. Only used if a Task Definition prompt references a PR template placeholder. */
  prTemplateLoader?: PrTemplateLoader;
  /** Optional worktree cleanup hook. Not invoked on the POC happy path. */
  cleanup?: TaskWorktreeCleanup;
  /** Derive the expected git remote for a Candidate's repo. */
  expectedRemoteFor: (candidate: Candidate) => string;
  /** Process env the Pi session inherits. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  logger: TaskRunnerLogger;
  /** Clock supplying ISO-8601 timestamps. Defaults to `new Date()`. */
  clock?: () => string;
}

export interface RunTaskInput {
  candidate: Candidate;
  runId: string;
  taskDefinition: TaskDefinition;
  projectItemId: string;
}

/**
 * Owns the execution of one Task Definition for one GitHub Issue.
 *
 * Lifecycle of `runTask`:
 *   1. Save a Run record + append `run_started` event.
 *   2. Provision the workspace (worktree).
 *   3. Load Issue context (body, labels) from GitHub.
 *   4. Render the Task Definition prompt body with placeholders from
 *      candidate / issue / workspace / run identity.
 *   5. Spawn ONE fresh Pi session, streaming every emitted event into
 *      `store.appendTranscriptEvent`.
 *   6. On Pi success (exitCode === 0): mark Run succeeded, ask the
 *      BoardTransitionService to move the Board item to
 *      `taskDefinition.next`, and release the SQLite claim. If `next`
 *      is terminal (no matching Task Definition), log a terminal
 *      notification.
 *   7. On Pi failure (non-zero exit OR thrown error): mark Run failed,
 *      append `run_failed`, do NOT advance the Board, do NOT release
 *      the claim (operator resolves manually).
 */
export class TaskRunner {
  private readonly deps: TaskRunnerDeps;

  constructor(deps: TaskRunnerDeps) {
    this.deps = deps;
  }

  public async runTask(input: RunTaskInput): Promise<void> {
    const { candidate, runId, taskDefinition, projectItemId } = input;
    const { store, logger, workflowGraph } = this.deps;
    const issueKey = candidateIssueKey(candidate);
    const clock = this.deps.clock ?? (() => new Date().toISOString());

    const startedAt = clock();
    store.saveRun({
      runId,
      issueKey,
      taskDefinition: taskDefinition.queue,
      status: "running",
      startedAt,
    });
    store.appendEvent({
      ts: startedAt,
      issueKey,
      taskDefinition: taskDefinition.queue,
      kind: "run_started",
      payload: { runId, projectItemId, status: candidate.status },
    });

    let workspace: Awaited<
      ReturnType<TaskWorkspaceProvisioner["provision"]>
    >;
    try {
      workspace = await this.deps.workspaceProvisioner.provision({
        owner: candidate.repository.owner,
        repo: candidate.repository.name,
        issueNumber: candidate.issueNumber,
        expectedRemote: this.deps.expectedRemoteFor(candidate),
      });
    } catch (e) {
      this.failRun(runId, issueKey, taskDefinition, clock(), e);
      return;
    }
    if (workspace.kind !== "provisioned") {
      this.failRun(
        runId,
        issueKey,
        taskDefinition,
        clock(),
        new Error(`workspace not provisioned: ${workspace.reason}`),
      );
      return;
    }

    let issueContext;
    try {
      issueContext = await this.deps.issueContextLoader({
        owner: candidate.repository.owner,
        repo: candidate.repository.name,
        issueNumber: candidate.issueNumber,
      });
    } catch (e) {
      this.failRun(runId, issueKey, taskDefinition, clock(), e);
      return;
    }

    const placeholders: Record<string, string> = {
      REPO_OWNER: candidate.repository.owner,
      REPO_NAME: candidate.repository.name,
      ISSUE_NUMBER: String(candidate.issueNumber),
      ISSUE_TITLE: candidate.title,
      ISSUE_URL: candidate.url,
      ISSUE_BODY: issueContext.body,
      TASK_BRANCH: workspace.taskBranch,
      BASE_BRANCH: workspace.baseBranch,
      WORKTREE_PATH: workspace.worktreePath,
      RUN_ID: runId,
      TASK_DEFINITION_NAME: taskDefinition.queue,
    };

    let rendered: string;
    try {
      rendered = renderPrompt(taskDefinition.promptBody, placeholders);
    } catch (e) {
      this.failRun(runId, issueKey, taskDefinition, clock(), e);
      return;
    }

    const session = this.deps.piSessionFactory({
      prompt: rendered,
      taskDefinitionName: taskDefinition.queue,
      cwd: workspace.worktreePath,
      env: this.deps.env ?? process.env,
    });

    let exitCode: number;
    try {
      const result = await session.run(async (event) => {
        const ts = clock();
        store.appendTranscriptEvent({ runId, ts, payload: event });
      });
      exitCode = result.exitCode;
    } catch (e) {
      this.failRun(runId, issueKey, taskDefinition, clock(), e);
      return;
    }

    if (exitCode !== 0) {
      this.failRun(
        runId,
        issueKey,
        taskDefinition,
        clock(),
        new Error(`pi session exited with code ${exitCode}`),
      );
      return;
    }

    // Happy path.
    const completedAt = clock();
    store.updateRunStatus({ runId, status: "succeeded", completedAt });
    store.appendEvent({
      ts: completedAt,
      issueKey,
      taskDefinition: taskDefinition.queue,
      kind: "run_completed",
      payload: { runId },
    });

    try {
      await this.deps.transitionService.applyTransition({
        projectItemId,
        toStatus: taskDefinition.next,
      });
      store.appendEvent({
        ts: clock(),
        issueKey,
        taskDefinition: taskDefinition.queue,
        kind: "transitioned",
        payload: { projectItemId, toStatus: taskDefinition.next },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(
        `Task Runner: Board transition to '${taskDefinition.next}' failed for ${issueKey}: ${msg}`,
      );
    }

    // Release the claim now that the Run finished. Tolerate "no active
    // claim" — the Orchestrator might not have claimed (tests do this).
    try {
      store.completeClaim({
        issueKey,
        taskDefinition: taskDefinition.queue,
        ts: clock(),
      });
    } catch {
      // No active claim to release. Acceptable for tests that drive the
      // TaskRunner directly without going through the Orchestrator.
    }

    if (workflowGraph.terminalStatuses.has(taskDefinition.next)) {
      logger.log(
        `Pi Lot: ${issueKey} reached terminal status '${taskDefinition.next}'. ` +
          "No further automation will run for this Issue.",
      );
    }
  }

  private failRun(
    runId: string,
    issueKey: string,
    taskDefinition: TaskDefinition,
    ts: string,
    cause: unknown,
  ): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.deps.store.updateRunStatus({
      runId,
      status: "failed",
      completedAt: ts,
    });
    this.deps.store.appendEvent({
      ts,
      issueKey,
      taskDefinition: taskDefinition.queue,
      kind: "run_failed",
      payload: { runId, reason: message },
    });
    this.deps.logger.error(
      `Task Runner: Run ${runId} for ${issueKey} (${taskDefinition.queue}) failed: ${message}`,
    );
  }
}

/** Stable Issue key used as the SQLite primary identifier for an Issue. */
function candidateIssueKey(c: Candidate): string {
  return `${c.repository.owner}/${c.repository.name}#${c.issueNumber}`;
}
