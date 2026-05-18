import { describe, expect, test } from "bun:test";
import { Conductor } from "../../src/conductor/index.ts";
import type { GhRunner } from "../../src/board/index.ts";
import type { Task } from "../../src/board/index.ts";
import type { RunRunner } from "../../src/conductor/scheduler.ts";
import type { PiLotConfig } from "../../src/config/index.ts";

/**
 * Tick-level integration test: pollOnce produces Tasks, and a single
 * scheduling tick dispatches them through an injected RunRunner.
 *
 * This is the observable contract we promise issue #4: given a Board
 * snapshot, the Conductor calls the runner for the right Tasks, in the
 * right order, respecting the concurrency limit.
 */

function cfg(overrides: Partial<PiLotConfig> = {}): PiLotConfig {
  return {
    board: {
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
    },
    projectsDir: "/tmp/projects",
    stateDir: "/tmp/state",
    pollIntervalMs: 30000,
    concurrency: 5,
    ...overrides,
  };
}

function projectStdoutWith(
  issues: Array<{ number: number; createdAt: string }>,
): string {
  return JSON.stringify({
    data: {
      organization: {
        projectV2: {
          id: "PVT_x",
          field: { id: "PVTSSF_x", name: "Status" },
          items: {
            nodes: issues.map((i) => ({
              id: `PVTI_${i.number}`,
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
                number: i.number,
                id: `I_${i.number}`,
                title: `T${i.number}`,
                url: `https://example.com/${i.number}`,
                createdAt: i.createdAt,
                repository: { owner: { login: "octocat" }, name: "widget" },
              },
            })),
          },
        },
      },
    },
  });
}

function manualRunner(): {
  runner: RunRunner;
  started: Task[];
  releaseAll: () => void;
} {
  const started: Task[] = [];
  const resolvers: Array<() => void> = [];
  const runner: RunRunner = (t) => {
    started.push(t);
    return new Promise<void>((resolve) => {
      resolvers.push(resolve);
    });
  };
  return {
    runner,
    started,
    releaseAll: () => {
      for (const r of resolvers.splice(0)) r();
    },
  };
}

describe("Conductor.tick", () => {
  test("dispatches polled Tasks to the runner oldest-first within the concurrency limit", async () => {
    const gh: GhRunner = async () => ({
      exitCode: 0,
      stdout: projectStdoutWith([
        { number: 2, createdAt: "2026-03-01T00:00:00Z" },
        { number: 1, createdAt: "2026-01-01T00:00:00Z" },
        { number: 3, createdAt: "2026-02-01T00:00:00Z" },
        { number: 4, createdAt: "2026-04-01T00:00:00Z" },
      ]),
      stderr: "",
    });

    const { runner, started, releaseAll } = manualRunner();
    const conductor = new Conductor(cfg({ concurrency: 2 }), {
      gh,
      runner,
    });

    await conductor.tick();

    expect(started.map((t) => t.issueNumber)).toEqual([1, 3]);

    releaseAll();
    await conductor.idle();
  });

  test("does not re-dispatch a Task still active from a prior tick", async () => {
    const gh: GhRunner = async () => ({
      exitCode: 0,
      stdout: projectStdoutWith([
        { number: 1, createdAt: "2026-01-01T00:00:00Z" },
      ]),
      stderr: "",
    });

    const { runner, started, releaseAll } = manualRunner();
    const conductor = new Conductor(cfg(), { gh, runner });

    await conductor.tick();
    await conductor.tick();
    await conductor.tick();

    expect(started.map((t) => t.issueNumber)).toEqual([1]);

    releaseAll();
    await conductor.idle();
  });
});
