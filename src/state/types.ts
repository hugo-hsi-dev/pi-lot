/**
 * Workflow state store domain types.
 *
 * The SqliteWorkflowStore persists the Conductor's workflow as an
 * append-only event log plus a small set of projections that summarise
 * "current truth" for fast reads.
 *
 * - {@link WorkflowEvent}s are the source of truth. Each event records a
 *   single moment in the lifecycle of one (issue, taskDefinition) pair.
 * - {@link ActiveClaim} is a projection: at most one row per
 *   (issueKey, taskDefinition), live while a Run holds the claim.
 * - {@link RunRecord} is a Run header keyed by `runId`.
 * - {@link TranscriptEvent} is the per-Run streaming transcript, with a
 *   monotonic `seq` *within* a Run.
 *
 * `issueKey` is an opaque string like "owner/repo#123"; the store does
 * not parse it.
 */

/** Kinds of workflow events the Conductor records. */
export type WorkflowEventKind =
  | "claimed"
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "transcript"
  | "transitioned";

/** Input shape for appending a workflow event. */
export interface WorkflowEvent {
  /** ISO-8601 timestamp string supplied by the caller. */
  ts: string;
  /** Stable key identifying the Issue, e.g. "owner/repo#123". */
  issueKey: string;
  /** Caller-defined task identifier, e.g. "implement", "review". */
  taskDefinition: string;
  /** Discriminator describing what happened. */
  kind: WorkflowEventKind;
  /** Free-form structured payload. Stored as JSON. */
  payload: unknown;
}

/** A workflow event as returned by the store, with its assigned `seq`. */
export interface StoredWorkflowEvent extends WorkflowEvent {
  /** Globally monotonic sequence number assigned at insert time. */
  seq: number;
}

/** Projection: a Task currently held by a Run. */
export interface ActiveClaim {
  issueKey: string;
  taskDefinition: string;
  runId: string;
  /** ISO-8601 timestamp when the claim was taken. */
  claimedAt: string;
}

/** Run lifecycle status. The store does not interpret this string. */
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

/** Run header record. */
export interface RunRecord {
  runId: string;
  issueKey: string;
  taskDefinition: string;
  status: RunStatus;
  /** ISO-8601 timestamp when the Run started. */
  startedAt: string;
  /** ISO-8601 timestamp when the Run reached a terminal status. */
  completedAt?: string;
}

/** Per-Run transcript event. `seq` is monotonic within a Run. */
export interface TranscriptEvent {
  runId: string;
  seq: number;
  ts: string;
  payload: unknown;
}

/** Input for claiming a Task. */
export interface ClaimTaskInput {
  issueKey: string;
  taskDefinition: string;
  runId: string;
  ts: string;
}

/** Input for completing an existing claim. */
export interface CompleteClaimInput {
  issueKey: string;
  taskDefinition: string;
  ts: string;
}

/** Input for {@link SqliteWorkflowStore.updateRunStatus}. */
export interface UpdateRunStatusInput {
  runId: string;
  status: RunStatus;
  completedAt?: string;
}

/** Input for {@link SqliteWorkflowStore.appendTranscriptEvent}. */
export interface AppendTranscriptEventInput {
  runId: string;
  ts: string;
  payload: unknown;
}

/** Options for opening a {@link SqliteWorkflowStore}. */
export interface SqliteWorkflowStoreOptions {
  /** SQLite path. Use ":memory:" for an in-memory database. */
  path: string;
}
