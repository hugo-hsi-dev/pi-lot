import { Database } from "bun:sqlite";
import type {
  ActiveClaim,
  AppendTranscriptEventInput,
  ClaimTaskInput,
  CompleteClaimInput,
  RunRecord,
  RunStatus,
  SqliteWorkflowStoreOptions,
  StoredWorkflowEvent,
  TranscriptEvent,
  UpdateRunStatusInput,
  WorkflowEvent,
  WorkflowEventKind,
} from "./types.ts";

/**
 * Thrown by {@link SqliteWorkflowStore.claimTask} when an active claim
 * already exists for the same (issueKey, taskDefinition).
 */
export class DuplicateClaimError extends Error {
  public readonly issueKey: string;
  public readonly taskDefinition: string;
  constructor(issueKey: string, taskDefinition: string) {
    super(`Task already claimed: ${issueKey} / ${taskDefinition}`);
    this.name = "DuplicateClaimError";
    this.issueKey = issueKey;
    this.taskDefinition = taskDefinition;
  }
}

/**
 * SQLite-backed Workflow State Store.
 *
 * Persists the Conductor's workflow as an append-only event log plus a
 * small set of projections (active claims, run headers, transcripts)
 * that summarise current truth for fast reads. Projections can be
 * rebuilt from the event log at any time.
 *
 * The schema is created on construction and is idempotent: opening an
 * existing database is a no-op aside from setting pragmas.
 */
export class SqliteWorkflowStore {
  private readonly db: Database;

  constructor(opts: SqliteWorkflowStoreOptions) {
    this.db = new Database(opts.path);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.createSchema();
  }

  /** Release the underlying SQLite handle. */
  public close(): void {
    this.db.close();
  }

  /**
   * Append one event to the workflow log.
   *
   * Returns the auto-assigned `seq` so callers can correlate the row
   * they just wrote with later log reads.
   */
  public appendEvent(event: WorkflowEvent): number {
    const stmt = this.db.prepare(
      `INSERT INTO workflow_events (ts, issue_key, task_definition, kind, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const res = stmt.run(
      event.ts,
      event.issueKey,
      event.taskDefinition,
      event.kind,
      JSON.stringify(event.payload),
    );
    return Number(res.lastInsertRowid);
  }

  /**
   * Atomically claim a Task for a Run.
   *
   * Appends a `claimed` event and inserts the active-claim projection
   * row in a single transaction. If another Run already holds the same
   * `(issueKey, taskDefinition)`, throws {@link DuplicateClaimError}
   * and leaves both the event log and the projection unchanged.
   */
  public claimTask(input: ClaimTaskInput): void {
    const existing = this.db
      .query(
        `SELECT run_id as runId FROM active_claims
         WHERE issue_key = ? AND task_definition = ?`,
      )
      .get(input.issueKey, input.taskDefinition) as
      | { runId: string }
      | undefined;
    if (existing) {
      throw new DuplicateClaimError(input.issueKey, input.taskDefinition);
    }

    const tx = this.db.transaction((data: ClaimTaskInput) => {
      this.db
        .prepare(
          `INSERT INTO workflow_events (ts, issue_key, task_definition, kind, payload_json)
           VALUES (?, ?, ?, 'claimed', ?)`,
        )
        .run(
          data.ts,
          data.issueKey,
          data.taskDefinition,
          JSON.stringify({ runId: data.runId }),
        );
      this.db
        .prepare(
          `INSERT INTO active_claims (issue_key, task_definition, run_id, claimed_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(data.issueKey, data.taskDefinition, data.runId, data.ts);
    });
    tx(input);
  }

  /**
   * Release a claim a Run was holding.
   *
   * Appends a `run_completed` event and removes the projection row in
   * a single transaction. Throws if no claim currently exists for the
   * given `(issueKey, taskDefinition)`.
   */
  public completeClaim(input: CompleteClaimInput): void {
    const existing = this.db
      .query(
        `SELECT run_id as runId FROM active_claims
         WHERE issue_key = ? AND task_definition = ?`,
      )
      .get(input.issueKey, input.taskDefinition) as
      | { runId: string }
      | undefined;
    if (!existing) {
      throw new Error(
        `No active claim for ${input.issueKey} / ${input.taskDefinition}`,
      );
    }

    const tx = this.db.transaction((data: CompleteClaimInput, runId: string) => {
      this.db
        .prepare(
          `INSERT INTO workflow_events (ts, issue_key, task_definition, kind, payload_json)
           VALUES (?, ?, ?, 'run_completed', ?)`,
        )
        .run(
          data.ts,
          data.issueKey,
          data.taskDefinition,
          JSON.stringify({ runId }),
        );
      this.db
        .prepare(
          `DELETE FROM active_claims WHERE issue_key = ? AND task_definition = ?`,
        )
        .run(data.issueKey, data.taskDefinition);
    });
    tx(input, existing.runId);
  }

  /** Return all currently-held claims. */
  public listActiveClaims(): ActiveClaim[] {
    return this.db
      .query(
        `SELECT issue_key as issueKey, task_definition as taskDefinition,
                run_id as runId, claimed_at as claimedAt
         FROM active_claims
         ORDER BY issue_key, task_definition`,
      )
      .all() as ActiveClaim[];
  }

  /**
   * Insert or replace a Run header row.
   *
   * Idempotent: re-saving the same `runId` overwrites the row. Pi Lot
   * uses this both for initial Run creation and for snapshotting Run
   * progress on retry.
   */
  public saveRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, issue_key, task_definition, status, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           issue_key = excluded.issue_key,
           task_definition = excluded.task_definition,
           status = excluded.status,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at`,
      )
      .run(
        run.runId,
        run.issueKey,
        run.taskDefinition,
        run.status,
        run.startedAt,
        run.completedAt ?? null,
      );
  }

  /** Update the lifecycle status of an existing Run. */
  public updateRunStatus(input: UpdateRunStatusInput): void {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, completed_at = ? WHERE run_id = ?`,
      )
      .run(input.status, input.completedAt ?? null, input.runId);
  }

  /** Fetch a Run header by id, or `null` if not present. */
  public getRun(runId: string): RunRecord | null {
    const row = this.db
      .query(
        `SELECT run_id as runId, issue_key as issueKey,
                task_definition as taskDefinition, status,
                started_at as startedAt, completed_at as completedAt
         FROM runs WHERE run_id = ?`,
      )
      .get(runId) as
      | {
          runId: string;
          issueKey: string;
          taskDefinition: string;
          status: RunStatus;
          startedAt: string;
          completedAt: string | null;
        }
      | undefined;
    if (!row) return null;
    const out: RunRecord = {
      runId: row.runId,
      issueKey: row.issueKey,
      taskDefinition: row.taskDefinition,
      status: row.status,
      startedAt: row.startedAt,
    };
    if (row.completedAt !== null) out.completedAt = row.completedAt;
    return out;
  }

  /**
   * Append one transcript event for a Run.
   *
   * `seq` is assigned per-Run: the first event for a Run gets `seq=1`,
   * the next `seq=2`, and so on. Assignment happens inside a
   * transaction so concurrent appenders cannot collide on `(run_id, seq)`.
   */
  public appendTranscriptEvent(input: AppendTranscriptEventInput): number {
    const tx = this.db.transaction((data: AppendTranscriptEventInput) => {
      const row = this.db
        .query(
          `SELECT COALESCE(MAX(seq), 0) as maxSeq FROM transcript_events WHERE run_id = ?`,
        )
        .get(data.runId) as { maxSeq: number };
      const next = row.maxSeq + 1;
      this.db
        .prepare(
          `INSERT INTO transcript_events (run_id, seq, ts, payload_json)
           VALUES (?, ?, ?, ?)`,
        )
        .run(data.runId, next, data.ts, JSON.stringify(data.payload));
      return next;
    });
    return tx(input);
  }

  /** Return all transcript events for a Run, in `seq` order. */
  public listTranscriptEvents(runId: string): TranscriptEvent[] {
    const rows = this.db
      .query(
        `SELECT run_id as runId, seq, ts, payload_json as payloadJson
         FROM transcript_events WHERE run_id = ? ORDER BY seq ASC`,
      )
      .all(runId) as Array<{
      runId: string;
      seq: number;
      ts: string;
      payloadJson: string;
    }>;
    return rows.map((r) => ({
      runId: r.runId,
      seq: r.seq,
      ts: r.ts,
      payload: JSON.parse(r.payloadJson),
    }));
  }

  /**
   * Rebuild the active-claim projection from the event log.
   *
   * Truncates the projection table and replays every `claimed` /
   * `run_completed` event in `seq` order. Used as a recovery / repair
   * step when the projection is suspected to be out of sync with the
   * authoritative log.
   */
  public rebuildProjections(): void {
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM active_claims");

      const events = this.db
        .query(
          `SELECT seq, ts, issue_key as issueKey, task_definition as taskDefinition,
                  kind, payload_json as payloadJson
           FROM workflow_events ORDER BY seq ASC`,
        )
        .all() as Array<{
        seq: number;
        ts: string;
        issueKey: string;
        taskDefinition: string;
        kind: WorkflowEventKind;
        payloadJson: string;
      }>;

      const upsert = this.db.prepare(
        `INSERT INTO active_claims (issue_key, task_definition, run_id, claimed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(issue_key, task_definition) DO UPDATE SET
           run_id = excluded.run_id,
           claimed_at = excluded.claimed_at`,
      );
      const del = this.db.prepare(
        `DELETE FROM active_claims WHERE issue_key = ? AND task_definition = ?`,
      );

      for (const row of events) {
        if (row.kind === "claimed") {
          const payload = JSON.parse(row.payloadJson) as { runId?: string };
          const runId = payload.runId;
          if (!runId) continue;
          upsert.run(row.issueKey, row.taskDefinition, runId, row.ts);
        } else if (row.kind === "run_completed") {
          del.run(row.issueKey, row.taskDefinition);
        }
      }
    });
    tx();
  }

  /** Return every event in the log, in `seq` order. */
  public listEvents(): StoredWorkflowEvent[] {
    const rows = this.db
      .query(
        `SELECT seq, ts, issue_key as issueKey, task_definition as taskDefinition,
                kind, payload_json as payloadJson
         FROM workflow_events ORDER BY seq ASC`,
      )
      .all() as Array<{
      seq: number;
      ts: string;
      issueKey: string;
      taskDefinition: string;
      kind: WorkflowEventKind;
      payloadJson: string;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      issueKey: r.issueKey,
      taskDefinition: r.taskDefinition,
      kind: r.kind,
      payload: JSON.parse(r.payloadJson),
    }));
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        issue_key TEXT NOT NULL,
        task_definition TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS active_claims (
        issue_key TEXT NOT NULL,
        task_definition TEXT NOT NULL,
        run_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY (issue_key, task_definition)
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        issue_key TEXT NOT NULL,
        task_definition TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS transcript_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );
    `);
  }
}
