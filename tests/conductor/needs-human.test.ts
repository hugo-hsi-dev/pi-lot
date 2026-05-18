import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRunOutcome,
  type ConductedRunDeps,
} from "../../src/conductor/needs-human.ts";
import { FileSystemRunStore } from "../../src/runs/index.ts";
import type { Run } from "../../src/runs/index.ts";
import type { Task } from "../../src/board/index.ts";
import type { BoardConfig } from "../../src/config/index.ts";
import type { PhaseOutcome } from "../../src/phases/index.ts";
import type { BoardStatusUpdater } from "../../src/phases/index.ts";
import type { WorktreeCleanup } from "../../src/workspace/cleanup.ts";

/**
 * Tests for the Needs Human outcome handler (issue #11).
 *
 * The handler is the seam between a Phase returning a {@link PhaseOutcome}
 * (or throwing fatally) and the Conductor-owned side-effects: Board
 * status transitions, Run Record reason persistence, and worktree
 * retention policy.
 *
 * These tests exercise the observable contract only; the phase business
 * logic itself is owned by `src/phases/` and is not modified here.
 */

const BOARD: BoardConfig = {
  owner: "octocat",
  projectNumber: 7,
  statusField: "Status",
  statusValues: {
    queued: "Queued",
    implementing: "Implementing",
    reviewing: "Reviewing",
    finalizing: "Finalizing",
    readyForReview: "Ready for Review",
    needsHuman: "Needs Human",
  },
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    repository: { owner: "octocat", name: "widget" },
    issueNumber: 42,
    issueId: "I_42",
    title: "Add a frobnicator",
    url: "https://github.com/octocat/widget/issues/42",
    boardItemId: "PVTI_42",
    projectId: "PVT_X",
    statusFieldId: "PVTSSF_X",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "pilot-nh-"));
}

interface StatusUpdate {
  projectId: string;
  statusFieldId: string;
  boardItemId: string;
  statusValue: string;
}

function recordingStatusUpdater(): {
  updater: BoardStatusUpdater;
  calls: StatusUpdate[];
} {
  const calls: StatusUpdate[] = [];
  const updater: BoardStatusUpdater = async (req) => {
    calls.push({ ...req });
  };
  return { updater, calls };
}

interface RecordingCleanup {
  cleanup: WorktreeCleanup;
  deleted: string[];
  preserved: string[];
}

function recordingCleanup(): RecordingCleanup {
  const deleted: string[] = [];
  const preserved: string[] = [];
  const cleanup: WorktreeCleanup = {
    async deleteWorktree(path) {
      deleted.push(path);
    },
    async preserveWorktree(path) {
      preserved.push(path);
    },
  };
  return { cleanup, deleted, preserved };
}

async function makeQueuedRun(
  store: FileSystemRunStore,
  task: Task,
  worktreePath: string,
): Promise<Run> {
  return store.createRun({
    taskRef: {
      owner: task.repository.owner,
      repo: task.repository.name,
      issueNumber: task.issueNumber,
    },
    boardItemId: task.boardItemId,
    taskBranch: `pi-lot/${task.repository.owner}/${task.repository.name}/issue-${task.issueNumber}`,
    worktreePath,
  });
}

function makeDeps(
  store: FileSystemRunStore,
  updater: BoardStatusUpdater,
  cleanup: WorktreeCleanup,
): ConductedRunDeps {
  return {
    runStore: store,
    boardStatusUpdater: updater,
    board: BOARD,
    cleanup,
  };
}

describe("applyRunOutcome — fatal Phase failure routes to Needs Human", () => {
  test("a failed Phase outcome moves the Board item to Needs Human", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await makeQueuedRun(store, task, "/tmp/wt/42");
    const { updater, calls } = recordingStatusUpdater();
    const { cleanup } = recordingCleanup();

    const failure: PhaseOutcome = {
      status: "failed",
      reason: "pi session exited with code 2",
      transcriptPath: "/tmp/transcripts/implement.jsonl",
    };

    await applyRunOutcome({
      task,
      run,
      phaseName: "implement",
      outcome: failure,
      deps: makeDeps(store, updater, cleanup),
    });

    expect(calls.map((c) => c.statusValue)).toEqual(["Needs Human"]);
    expect(calls[0]!.projectId).toBe("PVT_X");
    expect(calls[0]!.statusFieldId).toBe("PVTSSF_X");
    expect(calls[0]!.boardItemId).toBe("PVTI_42");
  });

  test("the failure reason is persisted on the Run Record's terminal report", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await makeQueuedRun(store, task, "/tmp/wt/42");
    const { updater } = recordingStatusUpdater();
    const { cleanup } = recordingCleanup();

    const failure: PhaseOutcome = {
      status: "failed",
      reason: "pi session threw: boom",
      transcriptPath: "/tmp/transcripts/implement.jsonl",
    };

    await applyRunOutcome({
      task,
      run,
      phaseName: "implement",
      outcome: failure,
      deps: makeDeps(store, updater, cleanup),
    });

    const reloaded = (await store.loadRun(run.id)) as Run;
    expect(reloaded.status).toBe("needs-human");
    expect(reloaded.terminalReport).toBeDefined();
    expect(reloaded.terminalReport!.status).toBe("needs-human");
    expect(reloaded.terminalReport!.needsHumanReason).toContain("boom");
    expect(reloaded.terminalReport!.needsHumanReason).toContain("implement");
    expect(reloaded.endedAt).toBeDefined();
  });

  test("the failed Task's worktree is preserved, not deleted", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await makeQueuedRun(store, task, "/tmp/wt/42");
    const { updater } = recordingStatusUpdater();
    const { cleanup, deleted, preserved } = recordingCleanup();

    const failure: PhaseOutcome = {
      status: "failed",
      reason: "fatal: anything",
      transcriptPath: "/tmp/transcripts/review.jsonl",
    };

    await applyRunOutcome({
      task,
      run,
      phaseName: "review",
      outcome: failure,
      deps: makeDeps(store, updater, cleanup),
    });

    expect(deleted).toEqual([]);
    expect(preserved).toContain(run.worktreePath);
  });

  test("the failing Phase name is part of the recorded reason for debuggability", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await makeQueuedRun(store, task, "/tmp/wt/42");
    const { updater } = recordingStatusUpdater();
    const { cleanup } = recordingCleanup();

    await applyRunOutcome({
      task,
      run,
      phaseName: "finalize",
      outcome: {
        status: "failed",
        reason: "pi session exited with code 1",
        transcriptPath: "/tmp/transcripts/finalize.jsonl",
      },
      deps: makeDeps(store, updater, cleanup),
    });

    const reloaded = (await store.loadRun(run.id)) as Run;
    expect(reloaded.terminalReport!.needsHumanReason).toMatch(/finalize/i);
  });

  test("a thrown error from a Phase routes to Needs Human with the error message in the reason", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await makeQueuedRun(store, task, "/tmp/wt/42");
    const { updater, calls } = recordingStatusUpdater();
    const { cleanup, deleted } = recordingCleanup();

    const err = new Error("Board status update failed: HTTP 500");

    await applyRunOutcome({
      task,
      run,
      phaseName: "implement",
      outcome: err,
      deps: makeDeps(store, updater, cleanup),
    });

    expect(calls.map((c) => c.statusValue)).toEqual(["Needs Human"]);
    const reloaded = (await store.loadRun(run.id)) as Run;
    expect(reloaded.status).toBe("needs-human");
    expect(reloaded.terminalReport!.needsHumanReason).toContain("HTTP 500");
    expect(deleted).toEqual([]);
  });
});

describe("applyRunOutcome — Finalize Needs Human Terminal Report", () => {
  test("a Needs Human Terminal Report moves the Board item to Needs Human and records the reason", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await makeQueuedRun(store, task, "/tmp/wt/42");
    const { updater, calls } = recordingStatusUpdater();
    const { cleanup, deleted, preserved } = recordingCleanup();

    const outcome: PhaseOutcome = {
      status: "succeeded",
      transcriptPath: "/tmp/transcripts/finalize.jsonl",
    };

    await applyRunOutcome({
      task,
      run,
      phaseName: "finalize",
      outcome,
      terminalReport: {
        status: "needs-human",
        needsHumanReason: "PR template absent; cannot finalize handoff",
        prUrl: "https://github.com/octocat/widget/pull/9",
        summary: "Finalize aborted",
      },
      deps: makeDeps(store, updater, cleanup),
    });

    expect(calls.map((c) => c.statusValue)).toEqual(["Needs Human"]);
    const reloaded = (await store.loadRun(run.id)) as Run;
    expect(reloaded.status).toBe("needs-human");
    expect(reloaded.terminalReport!.status).toBe("needs-human");
    expect(reloaded.terminalReport!.needsHumanReason).toBe(
      "PR template absent; cannot finalize handoff",
    );
    expect(reloaded.terminalReport!.prUrl).toBe(
      "https://github.com/octocat/widget/pull/9",
    );
    expect(deleted).toEqual([]);
    expect(preserved).toContain(run.worktreePath);
  });
});

describe("applyRunOutcome — Ready for Review", () => {
  test("a Ready for Review Terminal Report moves the Board item to Ready for Review and deletes the worktree", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await makeQueuedRun(store, task, "/tmp/wt/42");
    const { updater, calls } = recordingStatusUpdater();
    const { cleanup, deleted, preserved } = recordingCleanup();

    const outcome: PhaseOutcome = {
      status: "succeeded",
      transcriptPath: "/tmp/transcripts/finalize.jsonl",
    };

    await applyRunOutcome({
      task,
      run,
      phaseName: "finalize",
      outcome,
      terminalReport: {
        status: "ready-for-review",
        summary: "Implemented, reviewed, and ready",
        prUrl: "https://github.com/octocat/widget/pull/9",
      },
      deps: makeDeps(store, updater, cleanup),
    });

    expect(calls.map((c) => c.statusValue)).toEqual(["Ready for Review"]);
    const reloaded = (await store.loadRun(run.id)) as Run;
    expect(reloaded.status).toBe("ready-for-review");
    expect(reloaded.terminalReport!.status).toBe("ready-for-review");
    expect(reloaded.terminalReport!.prUrl).toBe(
      "https://github.com/octocat/widget/pull/9",
    );
    expect(deleted).toContain(run.worktreePath);
    expect(preserved).toEqual([]);
  });
});

describe("applyRunOutcome — no automatic retry policy", () => {
  test("after a fatal failure, the Run Record's status is terminal and not 'queued' or 'running'", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await makeQueuedRun(store, task, "/tmp/wt/42");
    const { updater } = recordingStatusUpdater();
    const { cleanup } = recordingCleanup();

    await applyRunOutcome({
      task,
      run,
      phaseName: "implement",
      outcome: new Error("boom"),
      deps: makeDeps(store, updater, cleanup),
    });

    // The PRD says "no automatic retries". The observable contract: the
    // Run reached a terminal status (so listActiveRuns no longer returns
    // it), and the Board status moved off Queued so the next poll cycle
    // does not produce the same Task again.
    const active = await store.listActiveRuns();
    expect(active.find((r) => r.id === run.id)).toBeUndefined();

    const reloaded = (await store.loadRun(run.id)) as Run;
    expect(reloaded.status).toBe("needs-human");
  });
});

describe("applyRunOutcome — Conductor wiring through a custom RunRunner", () => {
  test("the Conductor's RunRunner seam can route a thrown Phase error to Needs Human end-to-end", async () => {
    const { Conductor } = await import("../../src/conductor/index.ts");
    const { applyRunOutcome: apply } = await import(
      "../../src/conductor/needs-human.ts"
    );
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const { updater, calls } = recordingStatusUpdater();
    const { cleanup, deleted, preserved } = recordingCleanup();

    // Pretend the Implement Phase threw inside the RunRunner. The
    // RunRunner is responsible for catching the throw, creating a Run
    // Record so the failure has somewhere to land, and routing the
    // outcome through `applyRunOutcome`.
    const runner = async (task: Task) => {
      const run = await makeQueuedRun(store, task, "/tmp/wt/77");
      const err = new Error("simulated fatal");
      await apply({
        task,
        run,
        phaseName: "implement",
        outcome: err,
        deps: { runStore: store, boardStatusUpdater: updater, board: BOARD, cleanup },
      });
    };

    const conductor = new Conductor(
      {
        board: BOARD,
        projectsDir: "/tmp/projects",
        stateDir,
        pollIntervalMs: 1000,
        concurrency: 1,
      },
      {
        gh: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            data: {
              organization: {
                projectV2: {
                  id: "PVT_X",
                  field: { id: "PVTSSF_X", name: "Status" },
                  items: {
                    nodes: [
                      {
                        id: "PVTI_77",
                        type: "ISSUE",
                        fieldValues: {
                          nodes: [
                            {
                              __typename: "ProjectV2ItemFieldSingleSelectValue",
                              name: "Queued",
                              field: { name: "Status" },
                            },
                          ],
                        },
                        content: {
                          __typename: "Issue",
                          number: 77,
                          id: "I_77",
                          title: "T77",
                          url: "https://example.com/77",
                          createdAt: "2026-01-01T00:00:00Z",
                          repository: {
                            owner: { login: "octocat" },
                            name: "widget",
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
          stderr: "",
        }),
        runner,
      },
    );

    await conductor.tick();
    await conductor.idle();

    expect(calls.map((c) => c.statusValue)).toEqual(["Needs Human"]);
    expect(deleted).toEqual([]);
    expect(preserved.length).toBeGreaterThan(0);
    const active = await store.listActiveRuns();
    expect(active).toEqual([]);
  });
});

describe("WorktreeCleanup default implementation", () => {
  test("deleteWorktree removes the worktree directory from disk", async () => {
    const { defaultWorktreeCleanup } = await import(
      "../../src/workspace/cleanup.ts"
    );
    const stateDir = makeStateDir();
    const wt = join(stateDir, "octocat", "widget", "42");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "marker.txt"), "x", "utf8");
    expect(existsSync(wt)).toBe(true);

    const cleanup = defaultWorktreeCleanup();
    await cleanup.deleteWorktree(wt);

    expect(existsSync(wt)).toBe(false);
  });

  test("preserveWorktree leaves the worktree directory in place", async () => {
    const { defaultWorktreeCleanup } = await import(
      "../../src/workspace/cleanup.ts"
    );
    const stateDir = makeStateDir();
    const wt = join(stateDir, "octocat", "widget", "42");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "marker.txt"), "x", "utf8");

    const cleanup = defaultWorktreeCleanup();
    await cleanup.preserveWorktree(wt);

    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(wt, "marker.txt"))).toBe(true);
  });

  test("deleteWorktree is idempotent: missing directory is not an error", async () => {
    const { defaultWorktreeCleanup } = await import(
      "../../src/workspace/cleanup.ts"
    );
    const stateDir = makeStateDir();
    const wt = join(stateDir, "does-not-exist");
    const cleanup = defaultWorktreeCleanup();
    await cleanup.deleteWorktree(wt); // no throw
    expect(existsSync(wt)).toBe(false);
  });
});
