/**
 * Needs-Human outcome handler for the Conductor (issue #11).
 *
 * Pi Lot collapses every abnormal Run ending into a single Board status
 * ("Needs Human") and stores the specific reason on the Run Record
 * rather than expanding the Board status taxonomy (PRD #1 user stories
 * 32, 33, 44).
 *
 * This module is the seam between a Phase returning a {@link PhaseOutcome}
 * (or throwing fatally) and the Conductor-owned side-effects:
 *
 *   - Board status transition to Ready for Review or Needs Human.
 *   - Run Record terminal status + reason persistence.
 *   - Worktree retention policy: delete on Ready for Review, preserve on
 *     Needs Human (PRD #1 user stories 33/34).
 *   - No automatic retries: the Run is moved to a terminal status, which
 *     both removes it from `listActiveRuns` and prevents the next poll
 *     cycle from re-selecting the same Task (its Board status has left
 *     "Queued").
 *
 * The handler deliberately consumes the existing {@link PhaseOutcome}
 * shape from `src/phases/` so it can be wired in without modifying
 * any Phase business logic. The Implement, Review, and Finalize phase
 * implementations themselves remain ignorant of Board transitions and
 * worktree cleanup.
 */
import type { BoardConfig } from "../config/index.ts";
import type { Task } from "../board/index.ts";
import type {
  PhaseName,
  Run,
  RunStore,
  TerminalReport,
} from "../runs/index.ts";
import type { BoardStatusUpdater, PhaseOutcome } from "../phases/index.ts";
import type { WorktreeCleanup } from "../workspace/cleanup.ts";

/** Conductor-side dependencies the outcome handler needs to apply policy. */
export interface ConductedRunDeps {
  runStore: RunStore;
  boardStatusUpdater: BoardStatusUpdater;
  board: BoardConfig;
  cleanup: WorktreeCleanup;
}

/**
 * Inputs to {@link applyRunOutcome}.
 *
 * `outcome` is either a {@link PhaseOutcome} returned by the Phase, or a
 * thrown {@link Error} caught by the caller. Both shapes are accepted so
 * the Conductor's wiring layer can hand whatever it observed without
 * normalizing first.
 *
 * `terminalReport` is supplied only when the Finalize Phase parsed a
 * fenced Terminal Report from the agent transcript. Implement and Review
 * never produce one; their fatal failures route through `outcome.status
 * === "failed"` instead.
 */
export interface ApplyRunOutcomeInput {
  task: Task;
  run: Run;
  phaseName: PhaseName;
  outcome: PhaseOutcome | Error;
  /** Parsed Terminal Report from the Finalize Phase, if present. */
  terminalReport?: TerminalReport;
  deps: ConductedRunDeps;
}

/**
 * Apply the Needs-Human / Ready-for-Review policy to a single Run.
 *
 * Decision tree (matches issue #11 acceptance criteria):
 *
 *   1. `outcome` is an Error          -> Needs Human, reason = error message.
 *   2. `outcome.status === "failed"`  -> Needs Human, reason = outcome.reason.
 *   3. `terminalReport.status === "needs-human"` -> Needs Human, reason from report.
 *   4. `terminalReport.status === "ready-for-review"` -> Ready for Review.
 *   5. Phase succeeded with no Terminal Report (Implement/Review happy
 *      path) -> no terminal transition; the Conductor's next Phase in
 *      the chain takes over. This branch is a no-op here so callers can
 *      invoke `applyRunOutcome` after every Phase without special-casing.
 *
 * On a Needs Human outcome the worktree is preserved; on Ready for
 * Review it is deleted. The Board status is always updated *before* the
 * Run Record is closed, so a crash mid-handler leaves the Run mid-flight
 * rather than orphaned in a terminal local state with a stale Board.
 */
export async function applyRunOutcome(input: ApplyRunOutcomeInput): Promise<void> {
  const { task, run, phaseName, outcome, terminalReport, deps } = input;

  const decision = decideOutcome(phaseName, outcome, terminalReport);
  if (decision.kind === "continue") return;

  await deps.boardStatusUpdater({
    projectId: task.projectId,
    statusFieldId: task.statusFieldId,
    boardItemId: task.boardItemId,
    statusValue:
      decision.kind === "needs-human"
        ? deps.board.statusValues.needsHuman
        : deps.board.statusValues.readyForReview,
  });

  const report: TerminalReport =
    decision.kind === "needs-human"
      ? buildNeedsHumanReport(decision.reason, terminalReport)
      : buildReadyForReviewReport(terminalReport);

  await deps.runStore.completeRun(run.id, {
    status: decision.kind === "needs-human" ? "needs-human" : "ready-for-review",
    terminalReport: report,
  });

  if (decision.kind === "needs-human") {
    await deps.cleanup.preserveWorktree(run.worktreePath);
  } else {
    await deps.cleanup.deleteWorktree(run.worktreePath);
  }
}

type Decision =
  | { kind: "needs-human"; reason: string }
  | { kind: "ready-for-review" }
  | { kind: "continue" };

function decideOutcome(
  phaseName: PhaseName,
  outcome: PhaseOutcome | Error,
  terminalReport: TerminalReport | undefined,
): Decision {
  if (outcome instanceof Error) {
    return {
      kind: "needs-human",
      reason: `${phaseName} phase threw: ${outcome.message}`,
    };
  }
  if (outcome.status === "failed") {
    return {
      kind: "needs-human",
      reason: `${phaseName} phase failed: ${outcome.reason}`,
    };
  }
  if (terminalReport) {
    if (terminalReport.status === "needs-human") {
      return {
        kind: "needs-human",
        reason:
          terminalReport.needsHumanReason ??
          `${phaseName} phase reported needs-human`,
      };
    }
    if (terminalReport.status === "ready-for-review") {
      return { kind: "ready-for-review" };
    }
  }
  return { kind: "continue" };
}

function buildNeedsHumanReport(
  reason: string,
  existing: TerminalReport | undefined,
): TerminalReport {
  // Preserve any fields the Finalize parser already captured (prUrl,
  // summary) while normalising status and reason for downstream readers.
  const base: TerminalReport = existing ? { ...existing } : { status: "needs-human" };
  base.status = "needs-human";
  base.needsHumanReason = reason;
  return base;
}

function buildReadyForReviewReport(
  existing: TerminalReport | undefined,
): TerminalReport {
  const base: TerminalReport = existing
    ? { ...existing }
    : { status: "ready-for-review" };
  base.status = "ready-for-review";
  return base;
}
