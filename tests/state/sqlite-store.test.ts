import { describe, expect, test } from "bun:test";
import {
  DuplicateClaimError,
  SqliteWorkflowStore,
} from "../../src/state/index.ts";
import type { RunRecord, WorkflowEvent } from "../../src/state/index.ts";

function newStore(): SqliteWorkflowStore {
  return new SqliteWorkflowStore({ path: ":memory:" });
}

describe("SqliteWorkflowStore construction", () => {
  test("opens and creates schema for an in-memory db without error", () => {
    expect(() => newStore()).not.toThrow();
  });
});

describe("SqliteWorkflowStore.appendEvent", () => {
  test("writes a single event row and returns a positive seq", () => {
    const store = newStore();

    const seq = store.appendEvent({
      ts: "2026-01-01T00:00:00.000Z",
      issueKey: "owner/repo#1",
      taskDefinition: "implement",
      kind: "claimed",
      payload: { runId: "run-1" },
    });
    expect(seq).toBeGreaterThan(0);

    const events = store.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.seq).toBe(seq);
    expect(events[0]!.ts).toBe("2026-01-01T00:00:00.000Z");
    expect(events[0]!.issueKey).toBe("owner/repo#1");
    expect(events[0]!.taskDefinition).toBe("implement");
    expect(events[0]!.kind).toBe("claimed");
    expect(events[0]!.payload).toEqual({ runId: "run-1" });
    store.close();
  });
});

describe("SqliteWorkflowStore.claimTask", () => {
  test("inserts a claimed event and projection row atomically", () => {
    const store = newStore();

    store.claimTask({
      issueKey: "owner/repo#1",
      taskDefinition: "implement",
      runId: "run-1",
      ts: "2026-01-01T00:00:00.000Z",
    });

    const events = store.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("claimed");
    expect(events[0]!.issueKey).toBe("owner/repo#1");
    expect(events[0]!.taskDefinition).toBe("implement");
    expect(events[0]!.payload).toEqual({ runId: "run-1" });

    const claims = store.listActiveClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toEqual({
      issueKey: "owner/repo#1",
      taskDefinition: "implement",
      runId: "run-1",
      claimedAt: "2026-01-01T00:00:00.000Z",
    });
    store.close();
  });

  test("throws DuplicateClaimError and leaves log and projection unchanged when the same key is already claimed", () => {
    const store = newStore();

    store.claimTask({
      issueKey: "owner/repo#1",
      taskDefinition: "implement",
      runId: "run-1",
      ts: "2026-01-01T00:00:00.000Z",
    });

    expect(() =>
      store.claimTask({
        issueKey: "owner/repo#1",
        taskDefinition: "implement",
        runId: "run-2",
        ts: "2026-01-01T00:00:05.000Z",
      }),
    ).toThrow(DuplicateClaimError);

    expect(store.listEvents()).toHaveLength(1);
    const claims = store.listActiveClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]!.runId).toBe("run-1");
    store.close();
  });

  test("permits claims on a different taskDefinition for the same issue", () => {
    const store = newStore();

    store.claimTask({
      issueKey: "owner/repo#1",
      taskDefinition: "implement",
      runId: "run-1",
      ts: "2026-01-01T00:00:00.000Z",
    });
    store.claimTask({
      issueKey: "owner/repo#1",
      taskDefinition: "review",
      runId: "run-2",
      ts: "2026-01-01T00:00:01.000Z",
    });

    expect(store.listActiveClaims()).toHaveLength(2);
    expect(store.listEvents()).toHaveLength(2);
    store.close();
  });
});

describe("SqliteWorkflowStore.completeClaim", () => {
  test("removes the projection row and appends a run_completed event", () => {
    const store = newStore();
    store.claimTask({
      issueKey: "owner/repo#1",
      taskDefinition: "implement",
      runId: "run-1",
      ts: "2026-01-01T00:00:00.000Z",
    });

    store.completeClaim({
      issueKey: "owner/repo#1",
      taskDefinition: "implement",
      ts: "2026-01-01T00:01:00.000Z",
    });

    expect(store.listActiveClaims()).toHaveLength(0);
    const events = store.listEvents();
    expect(events).toHaveLength(2);
    expect(events[1]!.kind).toBe("run_completed");
    expect(events[1]!.issueKey).toBe("owner/repo#1");
    expect(events[1]!.taskDefinition).toBe("implement");
    expect(events[1]!.ts).toBe("2026-01-01T00:01:00.000Z");
    store.close();
  });

  test("throws when no claim exists for the key", () => {
    const store = newStore();
    expect(() =>
      store.completeClaim({
        issueKey: "owner/repo#1",
        taskDefinition: "implement",
        ts: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
    store.close();
  });
});

describe("SqliteWorkflowStore Run records", () => {
  test("saveRun + getRun round-trips a Run record", () => {
    const store = newStore();
    const run: RunRecord = {
      runId: "run-1",
      issueKey: "owner/repo#1",
      taskDefinition: "implement",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    };

    store.saveRun(run);

    expect(store.getRun("run-1")).toEqual(run);
    store.close();
  });

  test("updateRunStatus flips status and stamps completedAt", () => {
    const store = newStore();
    store.saveRun({
      runId: "run-1",
      issueKey: "owner/repo#1",
      taskDefinition: "implement",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    store.updateRunStatus({
      runId: "run-1",
      status: "succeeded",
      completedAt: "2026-01-01T00:05:00.000Z",
    });

    const loaded = store.getRun("run-1");
    expect(loaded?.status).toBe("succeeded");
    expect(loaded?.completedAt).toBe("2026-01-01T00:05:00.000Z");
    store.close();
  });

  test("getRun returns null for unknown ids", () => {
    const store = newStore();
    expect(store.getRun("missing")).toBeNull();
    store.close();
  });
});

describe("SqliteWorkflowStore transcript events", () => {
  test("appends per-Run transcript events with monotonic seq, isolated across Runs", () => {
    const store = newStore();
    store.saveRun({
      runId: "run-1",
      issueKey: "owner/repo#1",
      taskDefinition: "implement",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    store.saveRun({
      runId: "run-2",
      issueKey: "owner/repo#2",
      taskDefinition: "implement",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    store.appendTranscriptEvent({
      runId: "run-1",
      ts: "2026-01-01T00:00:01.000Z",
      payload: { i: 1 },
    });
    store.appendTranscriptEvent({
      runId: "run-2",
      ts: "2026-01-01T00:00:02.000Z",
      payload: { i: "two" },
    });
    store.appendTranscriptEvent({
      runId: "run-1",
      ts: "2026-01-01T00:00:03.000Z",
      payload: { i: 2 },
    });
    store.appendTranscriptEvent({
      runId: "run-1",
      ts: "2026-01-01T00:00:04.000Z",
      payload: { i: 3 },
    });

    const r1 = store.listTranscriptEvents("run-1");
    expect(r1).toHaveLength(3);
    expect(r1.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(r1.map((e) => e.payload)).toEqual([
      { i: 1 },
      { i: 2 },
      { i: 3 },
    ]);

    const r2 = store.listTranscriptEvents("run-2");
    expect(r2).toHaveLength(1);
    expect(r2[0]!.seq).toBe(1);
    expect(r2[0]!.payload).toEqual({ i: "two" });
    store.close();
  });
});

describe("SqliteWorkflowStore.rebuildProjections", () => {
  test("derives the correct active claims from the event log alone", () => {
    const store = newStore();

    const claimed = (
      issueKey: string,
      taskDefinition: string,
      runId: string,
      ts: string,
    ): WorkflowEvent => ({
      ts,
      issueKey,
      taskDefinition,
      kind: "claimed",
      payload: { runId },
    });
    const completed = (
      issueKey: string,
      taskDefinition: string,
      ts: string,
    ): WorkflowEvent => ({
      ts,
      issueKey,
      taskDefinition,
      kind: "run_completed",
      payload: {},
    });

    // Populate only the event log (no projection writes).
    store.appendEvent(
      claimed("owner/repo#1", "implement", "run-1", "2026-01-01T00:00:00.000Z"),
    );
    store.appendEvent(
      completed("owner/repo#1", "implement", "2026-01-01T00:01:00.000Z"),
    );
    store.appendEvent(
      claimed("owner/repo#2", "implement", "run-2", "2026-01-01T00:02:00.000Z"),
    );
    store.appendEvent(
      claimed("owner/repo#3", "review", "run-3", "2026-01-01T00:03:00.000Z"),
    );

    // Projection is empty because we only used appendEvent.
    expect(store.listActiveClaims()).toHaveLength(0);

    store.rebuildProjections();

    const keys = store
      .listActiveClaims()
      .map((c) => `${c.issueKey}/${c.taskDefinition}=${c.runId}@${c.claimedAt}`)
      .sort();
    expect(keys).toEqual([
      "owner/repo#2/implement=run-2@2026-01-01T00:02:00.000Z",
      "owner/repo#3/review=run-3@2026-01-01T00:03:00.000Z",
    ]);
    store.close();
  });

  test("starts fresh: any stale projection rows are removed before replay", () => {
    const store = newStore();

    store.claimTask({
      issueKey: "owner/repo#1",
      taskDefinition: "implement",
      runId: "run-1",
      ts: "2026-01-01T00:00:00.000Z",
    });
    store.completeClaim({
      issueKey: "owner/repo#1",
      taskDefinition: "implement",
      ts: "2026-01-01T00:01:00.000Z",
    });

    // Manually re-add a stale projection row that the log no longer supports.
    store.appendEvent({
      ts: "2026-01-01T00:02:00.000Z",
      issueKey: "owner/repo#2",
      taskDefinition: "implement",
      kind: "claimed",
      payload: { runId: "run-2" },
    });

    store.rebuildProjections();

    const claims = store.listActiveClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]!.issueKey).toBe("owner/repo#2");
    expect(claims[0]!.runId).toBe("run-2");
    store.close();
  });
});
