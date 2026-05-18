/**
 * Run Record domain types.
 *
 * A Run is one attempt by the Conductor to take a Task (a Queued GitHub
 * Issue Board item) through the Implement, Review, and Finalize Phases.
 *
 * Run Records are the durable snapshot the Conductor keeps under
 * `<stateDir>/runs/` so that:
 *   - The worker can list what is currently active.
 *   - A human can inspect what happened after the fact.
 *   - Phase transcripts are linked from each Phase Record without
 *     requiring later Phases to read prior transcripts.
 *
 * See PRD #1 user stories 35-36 and Implementation Decisions ("Run
 * Records are small structured snapshots ...").
 *
 * Phase transcript file paths point at JSONL files under
 * `<stateDir>/transcripts/<runId>/<phaseName>.jsonl`. The Pi phase
 * runner appends one event per line; this module only knows the path.
 */

/** Stable identity for the Task this Run belongs to. */
export interface TaskRef {
  /** GitHub owner (user or organization) that owns the Issue's repo. */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Issue number within `repo`. */
  issueNumber: number;
}

/**
 * Lifecycle status for a Run as displayed on the Board.
 *
 * Pi Lot Board statuses collapse abnormal outcomes into "needs-human",
 * matching PRD #1 ("abnormal states collapse into Needs Human with
 * details in the Run Record").
 */
export type RunStatus =
  | "queued"
  | "running"
  | "ready-for-review"
  | "needs-human";

/** Lifecycle status for an individual Phase within a Run. */
export type PhaseStatus = "pending" | "running" | "succeeded" | "failed";

/** Canonical Phase names used by the MVP Pi Lot conductor. */
export type PhaseName = "implement" | "review" | "finalize";

/**
 * Minimal Terminal Report shape. The Finalize phase emits a fenced JSON
 * block whose decoded value is stored verbatim on the Run Record.
 *
 * We intentionally keep the type loose here: the Terminal Report parser
 * (separate concern) validates structure. This module just records what
 * the parser returned so it can be inspected later.
 */
export interface TerminalReport {
  status: "ready-for-review" | "needs-human";
  summary?: string;
  prUrl?: string;
  needsHumanReason?: string;
  /** Allow forward-compatible extra fields without losing them. */
  [extra: string]: unknown;
}

/** Per-Phase record stored on the Run. */
export interface PhaseRecord {
  name: PhaseName;
  status: PhaseStatus;
  /** ISO-8601 timestamp when the Phase started. */
  startedAt: string;
  /** ISO-8601 timestamp when the Phase ended; undefined while running. */
  endedAt?: string;
  /** Absolute path to the Phase's transcript JSONL file. */
  transcriptPath: string;
  /** Terminal Report payload (only meaningful for the Finalize phase). */
  terminalReport?: TerminalReport;
}

/** Durable Run Record snapshot. */
export interface Run {
  /** Run identifier; unique per Run, opaque to callers. */
  id: string;
  /** Task this Run belongs to. */
  taskRef: TaskRef;
  /** Board item node id (used for Board status updates by the Conductor). */
  boardItemId: string;
  /** Task Branch reused across Runs for this Issue. */
  taskBranch: string;
  /** Absolute path of the Task worktree on disk. */
  worktreePath: string;
  /** Overall Run lifecycle status. */
  status: RunStatus;
  /** ISO-8601 timestamp when the Run was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the Run reached a terminal status. */
  endedAt?: string;
  /** Phase records appended as the Run progresses. */
  phases: PhaseRecord[];
  /** Terminal Report from the Finalize phase, if recorded. */
  terminalReport?: TerminalReport;
}

/** Input to {@link RunStore.createRun}. */
export interface CreateRunInput {
  taskRef: TaskRef;
  boardItemId: string;
  taskBranch: string;
  worktreePath: string;
}
