import { describe, expect, test } from "bun:test";
import { Scheduler } from "../../src/conductor/scheduler.ts";
import type { RunRunner } from "../../src/conductor/scheduler.ts";
import type { Task } from "../../src/board/index.ts";

/**
 * Tests for the Conductor scheduling logic (issue #4).
 *
 * These tests exercise scheduling as observable behavior: which Tasks
 * the Scheduler chooses to dispatch to the RunRunner given a snapshot
 * of Queued Tasks and the set of Tasks already active in this process.
 *
 * The RunRunner is a fake; no Phase work is performed.
 */

function task(overrides: Partial<Task> & { issueNumber: number; createdAt: string }): Task {
  const { issueNumber, createdAt, ...rest } = overrides;
  return {
    repository: { owner: "octocat", name: "widget" },
    issueNumber,
    issueId: `I_${issueNumber}`,
    title: `T${issueNumber}`,
    url: `https://example.com/${issueNumber}`,
    boardItemId: `PVTI_${issueNumber}`,
    projectId: "PVT_x",
    statusFieldId: "PVTSSF_x",
    createdAt,
    ...rest,
  };
}

/**
 * Build a RunRunner whose runs hang on a manual gate so the test can
 * observe which Tasks were dispatched while none have completed yet.
 */
function manualRunner(): {
  runner: RunRunner;
  started: Task[];
  release: (task: Task) => void;
  releaseAll: () => void;
} {
  const started: Task[] = [];
  const gates = new Map<string, () => void>();
  const runner: RunRunner = (t: Task) => {
    started.push(t);
    return new Promise<void>((resolve) => {
      gates.set(keyOf(t), resolve);
    });
  };
  return {
    runner,
    started,
    release: (t: Task) => {
      const g = gates.get(keyOf(t));
      if (g) {
        gates.delete(keyOf(t));
        g();
      }
    },
    releaseAll: () => {
      for (const [, g] of gates) g();
      gates.clear();
    },
  };
}

function keyOf(t: Task): string {
  return `${t.repository.owner}/${t.repository.name}#${t.issueNumber}`;
}

describe("Scheduler", () => {
  test("starts Queued Tasks oldest-first by Issue createdAt", async () => {
    const { runner, started, releaseAll } = manualRunner();
    const scheduler = new Scheduler({ concurrency: 5, runner });

    const newer = task({ issueNumber: 2, createdAt: "2026-03-01T00:00:00Z" });
    const older = task({ issueNumber: 1, createdAt: "2026-01-01T00:00:00Z" });
    const middle = task({ issueNumber: 3, createdAt: "2026-02-01T00:00:00Z" });

    // Intentionally pass in non-chronological order to prove the
    // Scheduler does the ordering itself.
    scheduler.schedule([newer, older, middle]);

    expect(started.map((t) => t.issueNumber)).toEqual([1, 3, 2]);

    releaseAll();
    await scheduler.idle();
  });

  test("starts no more than `concurrency` Runs at once", async () => {
    const { runner, started, releaseAll } = manualRunner();
    const scheduler = new Scheduler({ concurrency: 5, runner });

    const tasks: Task[] = [];
    for (let i = 1; i <= 8; i++) {
      tasks.push(
        task({
          issueNumber: i,
          createdAt: `2026-01-0${i}T00:00:00Z`,
        }),
      );
    }

    scheduler.schedule(tasks);

    expect(started).toHaveLength(5);
    expect(started.map((t) => t.issueNumber)).toEqual([1, 2, 3, 4, 5]);

    releaseAll();
    await scheduler.idle();
  });

  test("does not re-dispatch a Task that is already active in this process", async () => {
    const { runner, started, releaseAll } = manualRunner();
    const scheduler = new Scheduler({ concurrency: 5, runner });

    const t1 = task({ issueNumber: 1, createdAt: "2026-01-01T00:00:00Z" });

    // First tick starts the Task.
    scheduler.schedule([t1]);
    expect(started).toHaveLength(1);

    // The Board still reports it as Queued on the next tick — the
    // Conductor must not dispatch it again while it is still active.
    scheduler.schedule([t1]);
    expect(started).toHaveLength(1);

    releaseAll();
    await scheduler.idle();
  });

  test("frees up a slot once a Run completes, so the next tick can start a new Task", async () => {
    const { runner, started, release, releaseAll } = manualRunner();
    const scheduler = new Scheduler({ concurrency: 1, runner });

    const t1 = task({ issueNumber: 1, createdAt: "2026-01-01T00:00:00Z" });
    const t2 = task({ issueNumber: 2, createdAt: "2026-02-01T00:00:00Z" });

    scheduler.schedule([t1, t2]);
    expect(started.map((t) => t.issueNumber)).toEqual([1]);

    // Complete the first Run; the slot should free up.
    release(t1);
    // Drain microtasks so the .finally handler removes t1 from active.
    await Promise.resolve();
    await Promise.resolve();

    scheduler.schedule([t2]);
    expect(started.map((t) => t.issueNumber)).toEqual([1, 2]);

    releaseAll();
    await scheduler.idle();
  });

  test("ignores stale active Run Records from a prior process on startup (MVP)", async () => {
    // PRD #1 user story 37 / issue #4 AC: stale active Run Records from
    // a previous Conductor process must not block MVP scheduling.
    //
    // We have no Run Record store in this slice (#5 owns that), so the
    // observable contract here is: a freshly constructed Scheduler
    // treats every Queued Task as eligible — there is no hidden
    // "already-active" set inherited from disk.
    const { runner, started, releaseAll } = manualRunner();
    const scheduler = new Scheduler({ concurrency: 5, runner });

    // The Board reports a Task that, in a prior process, *was* active
    // and may have left behind a stale Run Record. The MVP Scheduler
    // does not look at that — it just starts the Task.
    const t1 = task({ issueNumber: 99, createdAt: "2026-01-01T00:00:00Z" });

    scheduler.schedule([t1]);

    expect(started.map((t) => t.issueNumber)).toEqual([99]);

    releaseAll();
    await scheduler.idle();
  });
});
