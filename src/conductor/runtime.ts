/**
 * Conductor runtime composition root (issue #12).
 *
 * The Conductor, the Scheduler, the Board gateway, the Phase classes, the
 * RunStore, the Workspace provisioner, and the worktree cleanup policy
 * are each independent modules with their own tests. This file is the
 * thin assembly layer that wires them into a single RunRunner the
 * Scheduler can dispatch:
 *
 *   Task --(provision)--> Workspace
 *        --(createRun)--> Run
 *        --(Implement)--> PhaseOutcome
 *        --(Review)----->  PhaseOutcome
 *        --(Finalize)---> PhaseOutcome (+ Terminal Report)
 *        --(apply)------> Board status + worktree retention + Run status
 *
 * Production wires real implementations; the e2e tests in
 * `tests/e2e/full-run.test.ts` wire fakes through the same seam.
 *
 * Design notes
 * ------------
 *   - This module does not own any phase business logic. Each Phase class
 *     remains responsible for its own session, prompt, transcript, and
 *     Board status update at Phase start.
 *   - The Finalize Phase already moves the Board to "Ready for Review"
 *     and deletes the worktree on a valid ready-for-review report. The
 *     Needs-Human outcome handler (`applyRunOutcome`) is therefore only
 *     invoked here for failure paths (failed PhaseOutcome, thrown error,
 *     or Needs-Human Terminal Report). This keeps Board state machine
 *     transitions linear: no Phase ever sees a status it didn't issue.
 *   - Workspace `expectedRemoteFor` is injected so tests can supply a
 *     deterministic remote URL without coding in a single GitHub host
 *     convention. Production wires it to the standard
 *     `https://github.com/<owner>/<repo>.git` form.
 */
import type { Task } from "../board/index.ts";
import type { PiLotConfig } from "../config/index.ts";
import {
  FinalizePhase,
  ImplementPhase,
  ReviewPhase,
  type BoardStatusUpdater,
  type IssueContextLoader,
  type PhaseOutcome,
  type PiSessionFactory,
  type PrTemplateLoader,
  type WorkspaceFacts,
} from "../phases/index.ts";
import type { Run, RunStore } from "../runs/index.ts";
import type { WorkspaceProvisioner } from "../workspace/index.ts";
import type { WorktreeCleanup } from "../workspace/cleanup.ts";
import type { RunRunner } from "./scheduler.ts";
import { applyRunOutcome } from "./needs-human.ts";

/** Hook that derives the expected `origin` URL for a Task's repository. */
export type ExpectedRemoteForFn = (task: Task) => string;

export interface AssembleRuntimeInput {
  config: PiLotConfig;
  runStore: RunStore;
  provisioner: WorkspaceProvisioner;
  piSessionFactory: PiSessionFactory;
  boardStatusUpdater: BoardStatusUpdater;
  issueContextLoader: IssueContextLoader;
  prTemplateLoader: PrTemplateLoader;
  cleanup: WorktreeCleanup;
  /**
   * Derive the expected `origin` URL for a Task's repository. Production
   * wires this to the standard `https://github.com/<owner>/<repo>.git`
   * form; tests inject a fake so the FakeGitRunner matches.
   */
  expectedRemoteFor: ExpectedRemoteForFn;
  /**
   * Process environment forwarded to each fresh Pi session. Defaults to
   * `process.env` (PRD #1 user story 38). Tests inject `{}` so they never
   * leak real credentials into assertions.
   */
  env?: NodeJS.ProcessEnv;
}

export interface PiLotRuntime {
  runner: RunRunner;
}

/**
 * Build the production RunRunner from concrete module instances.
 *
 * The returned runner provisions the workspace, creates the Run Record,
 * runs Implement → Review → Finalize, and applies the Needs-Human policy
 * on any failure (including fatal throws). On the ready-for-review happy
 * path the Finalize Phase's own bookkeeping (Board status + worktree
 * cleanup + Run completion) is authoritative; the outcome handler runs
 * only for non-happy outcomes to avoid double-flipping the Board.
 */
export function assemblePiLotRuntime(input: AssembleRuntimeInput): PiLotRuntime {
  const phaseDeps = {
    board: input.config.board,
    runStore: input.runStore,
    piSessionFactory: input.piSessionFactory,
    boardStatusUpdater: input.boardStatusUpdater,
    issueContextLoader: input.issueContextLoader,
    env: input.env,
  };
  const implementPhase = new ImplementPhase(phaseDeps);
  const reviewPhase = new ReviewPhase(phaseDeps);
  const finalizePhase = new FinalizePhase({
    ...phaseDeps,
    prTemplateLoader: input.prTemplateLoader,
    // Finalize's `deleteWorktree` hook handles the happy-path worktree
    // cleanup. Route it through the same WorktreeCleanup the outcome
    // handler uses so tests can observe both branches via one recorder.
    deleteWorktree: (path) => input.cleanup.deleteWorktree(path),
  });

  const runner: RunRunner = async (task: Task) => {
    const workspace = await provisionOrSkip(input, task);
    if (!workspace) return;

    const run = await input.runStore.createRun({
      taskRef: {
        owner: task.repository.owner,
        repo: task.repository.name,
        issueNumber: task.issueNumber,
      },
      boardItemId: task.boardItemId,
      taskBranch: workspace.taskBranch,
      worktreePath: workspace.worktreePath,
    });

    try {
      const implementOutcome = await implementPhase.run({
        task,
        run,
        workspace,
      });
      if (implementOutcome.status === "failed") {
        await routeFailure(input, task, run, "implement", implementOutcome);
        return;
      }

      const reviewOutcome = await reviewPhase.run({ task, run, workspace });
      if (reviewOutcome.status === "failed") {
        await routeFailure(input, task, run, "review", reviewOutcome);
        return;
      }

      const finalizeOutcome = await finalizePhase.run({
        task,
        run,
        workspace,
      });
      if (finalizeOutcome.status === "failed") {
        await routeFailure(input, task, run, "finalize", finalizeOutcome);
        return;
      }

      // On a Finalize success, FinalizePhase has already:
      //   - written the Terminal Report to the Phase Record,
      //   - moved the Board to Ready for Review (when the report says so),
      //   - completed the Run, and
      //   - deleted the worktree.
      //
      // But if the report said "needs-human" instead, FinalizePhase will
      // have left the Run in a non-terminal state. We translate that
      // into a Needs-Human outcome here using the recorded Terminal
      // Report so the Conductor remains the single owner of the
      // needs-human transition.
      const persistedReport = await readFinalizeReport(input.runStore, run.id);
      if (persistedReport && persistedReport.status === "needs-human") {
        await applyRunOutcome({
          task,
          run,
          phaseName: "finalize",
          outcome: finalizeOutcome,
          terminalReport: persistedReport,
          deps: {
            runStore: input.runStore,
            boardStatusUpdater: input.boardStatusUpdater,
            board: input.config.board,
            cleanup: input.cleanup,
          },
        });
      }
    } catch (e) {
      // A Phase threw before it could record its own failure. Route the
      // raw error through the outcome handler so the Board flips to
      // Needs Human and the worktree is preserved.
      const err = e instanceof Error ? e : new Error(String(e));
      await applyRunOutcome({
        task,
        run,
        phaseName: "implement", // best-effort: the throw happened somewhere in the pipeline
        outcome: err,
        deps: {
          runStore: input.runStore,
          boardStatusUpdater: input.boardStatusUpdater,
          board: input.config.board,
          cleanup: input.cleanup,
        },
      });
    }
  };

  return { runner };
}

async function provisionOrSkip(
  input: AssembleRuntimeInput,
  task: Task,
): Promise<WorkspaceFacts | null> {
  const outcome = await input.provisioner.provision({
    owner: task.repository.owner,
    repo: task.repository.name,
    issueNumber: task.issueNumber,
    expectedRemote: input.expectedRemoteFor(task),
  });
  if (outcome.kind !== "provisioned") return null;
  return {
    repoPath: outcome.repoPath,
    worktreePath: outcome.worktreePath,
    taskBranch: outcome.taskBranch,
    baseBranch: outcome.baseBranch,
  };
}

async function routeFailure(
  input: AssembleRuntimeInput,
  task: Task,
  run: Run,
  phaseName: "implement" | "review" | "finalize",
  outcome: PhaseOutcome,
): Promise<void> {
  await applyRunOutcome({
    task,
    run,
    phaseName,
    outcome,
    deps: {
      runStore: input.runStore,
      boardStatusUpdater: input.boardStatusUpdater,
      board: input.config.board,
      cleanup: input.cleanup,
    },
  });
}

async function readFinalizeReport(
  store: RunStore,
  runId: string,
): Promise<Run["terminalReport"]> {
  const reloaded = await store.loadRun(runId);
  if (!reloaded) return undefined;
  const phase = reloaded.phases.find((p) => p.name === "finalize");
  return phase?.terminalReport;
}
