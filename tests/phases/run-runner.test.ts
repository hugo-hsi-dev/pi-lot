import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createImplementPhaseRunRunner,
  ImplementPhase,
} from "../../src/phases/index.ts";
import type {
  PiSession,
  PiSessionFactory,
  PiSessionInput,
} from "../../src/phases/index.ts";
import { FileSystemRunStore } from "../../src/runs/index.ts";
import type { Task } from "../../src/board/index.ts";
import type { BoardConfig } from "../../src/config/index.ts";

/**
 * Tests for the Scheduler-shaped adapter that lets the Conductor dispatch
 * a Task through the Implement Phase using its existing RunRunner seam
 * (issue #8 wiring step).
 */

const BOARD_CONFIG: BoardConfig = {
  owner: "octocat",
  projectNumber: 1,
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
    issueNumber: 7,
    issueId: "I_7",
    title: "T7",
    url: "https://github.com/octocat/widget/issues/7",
    boardItemId: "PVTI_7",
    projectId: "PVT_X",
    statusFieldId: "PVTSSF_X",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function fakePiFactory(): {
  factory: PiSessionFactory;
  inputs: PiSessionInput[];
} {
  const inputs: PiSessionInput[] = [];
  const factory: PiSessionFactory = (input) => {
    inputs.push(input);
    const session: PiSession = {
      async run() {
        return { exitCode: 0 };
      },
    };
    return session;
  };
  return { factory, inputs };
}

describe("createImplementPhaseRunRunner", () => {
  test("returns a RunRunner that, when called with a Task, provisions a workspace and runs the Implement Phase", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pilot-runner-"));
    const store = new FileSystemRunStore({ stateDir });
    const { factory, inputs } = fakePiFactory();

    const statusUpdates: string[] = [];
    const phase = new ImplementPhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: async (req) => {
        statusUpdates.push(req.statusValue);
      },
      issueContextLoader: async () => ({
        body: "body",
        labels: [],
        existingDraftPrUrl: undefined,
      }),
    });

    const runner = createImplementPhaseRunRunner({
      runStore: store,
      provisionWorkspace: async (task) => ({
        repoPath: "/tmp/projects/widget",
        worktreePath: `/tmp/state/${task.repository.owner}/${task.repository.name}/${task.issueNumber}`,
        taskBranch: `pi-lot/${task.repository.owner}/${task.repository.name}/issue-${task.issueNumber}`,
        baseBranch: "main",
      }),
      implementPhase: phase,
    });

    const task = makeTask();
    await runner(task);

    // The Implement Phase ran with a fresh Pi session for this Task.
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.facts.issue.number).toBe(7);
    expect(inputs[0]!.cwd).toBe("/tmp/state/octocat/widget/7");
    // The Board status moved to Implementing.
    expect(statusUpdates).toEqual(["Implementing"]);
    // A Run Record was created with the right Task identity.
    const active = await store.listActiveRuns();
    expect(active).toHaveLength(1);
    expect(active[0]!.taskRef).toEqual({
      owner: "octocat",
      repo: "widget",
      issueNumber: 7,
    });
    expect(active[0]!.taskBranch).toBe("pi-lot/octocat/widget/issue-7");
  });

  test("skips the phase and does not create a Run when workspace provisioning is skipped (e.g. remote-mismatch)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pilot-runner-"));
    const store = new FileSystemRunStore({ stateDir });
    const { factory, inputs } = fakePiFactory();

    const statusUpdates: string[] = [];
    const phase = new ImplementPhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: async (req) => {
        statusUpdates.push(req.statusValue);
      },
      issueContextLoader: async () => ({
        body: "body",
        labels: [],
        existingDraftPrUrl: undefined,
      }),
    });

    const runner = createImplementPhaseRunRunner({
      runStore: store,
      provisionWorkspace: async () => null,
      implementPhase: phase,
    });

    await runner(makeTask());

    expect(inputs).toHaveLength(0);
    expect(statusUpdates).toEqual([]);
    expect(await store.listActiveRuns()).toEqual([]);
  });
});
