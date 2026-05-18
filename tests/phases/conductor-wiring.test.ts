import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conductor } from "../../src/conductor/index.ts";
import {
  ImplementPhase,
  createImplementPhaseRunRunner,
} from "../../src/phases/index.ts";
import type {
  PiSession,
  PiSessionFactory,
  PiSessionInput,
} from "../../src/phases/index.ts";
import { FileSystemRunStore } from "../../src/runs/index.ts";
import type { GhRunner } from "../../src/board/index.ts";
import type { PiLotConfig } from "../../src/config/index.ts";

/**
 * Integration test: the Conductor's existing RunRunner injection point
 * can dispatch real Implement Phase work through the unchanged Scheduler.
 *
 * This exercises the end-to-end wiring required by issue #8 step 8 ("wire
 * into RunRunner so the Conductor can actually dispatch through Implement
 * Phase"). It does not call the real Pi SDK, real `gh`, or real git.
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

describe("Conductor wired with the Implement Phase RunRunner", () => {
  test("a single tick provisions, creates a Run, and runs the Implement Phase fresh session", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pilot-cond-impl-"));
    const store = new FileSystemRunStore({ stateDir });

    // Fake everything below the seam: gh poll, pi session factory,
    // board status updater, workspace provisioner.
    const gh: GhRunner = async () => ({
      exitCode: 0,
      stdout: projectStdoutWith([
        { number: 11, createdAt: "2026-01-01T00:00:00Z" },
      ]),
      stderr: "",
    });

    const piInputs: PiSessionInput[] = [];
    const piFactory: PiSessionFactory = (input) => {
      piInputs.push(input);
      const session: PiSession = {
        async run(handler) {
          await handler({ kind: "message", text: "starting" });
          return { exitCode: 0 };
        },
      };
      return session;
    };

    const statusCalls: string[] = [];
    const phase = new ImplementPhase({
      board: cfg().board,
      runStore: store,
      piSessionFactory: piFactory,
      boardStatusUpdater: async (req) => {
        statusCalls.push(req.statusValue);
      },
      issueContextLoader: async () => ({
        body: "issue body",
        labels: [],
        existingDraftPrUrl: undefined,
      }),
    });

    const runner = createImplementPhaseRunRunner({
      runStore: store,
      provisionWorkspace: async (task) => ({
        repoPath: `/tmp/projects/${task.repository.name}`,
        worktreePath: `${stateDir}/${task.repository.owner}/${task.repository.name}/${task.issueNumber}`,
        taskBranch: `pi-lot/${task.repository.owner}/${task.repository.name}/issue-${task.issueNumber}`,
        baseBranch: "main",
      }),
      implementPhase: phase,
    });

    const conductor = new Conductor(cfg(), { gh, runner });

    await conductor.tick();
    await conductor.idle();

    // The fresh session was started exactly once for the queued Task.
    expect(piInputs).toHaveLength(1);
    expect(piInputs[0]!.facts.issue.number).toBe(11);
    // Board status moved to Implementing before the session ran.
    expect(statusCalls).toEqual(["Implementing"]);
    // A Run Record was persisted with the Implement Phase completed.
    // The Run remains "running" because Review/Finalize are #9/#10 work
    // and have not closed the Run yet.
    const active = await store.listActiveRuns();
    expect(active).toHaveLength(1);
    const implementPhase = active[0]!.phases.find(
      (p) => p.name === "implement",
    );
    expect(implementPhase?.status).toBe("succeeded");
  });
});
