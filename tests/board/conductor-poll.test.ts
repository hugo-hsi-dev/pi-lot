import { describe, expect, test } from "bun:test";
import { Conductor } from "../../src/conductor/index.ts";
import type { GhResult, GhRunner } from "../../src/board/index.ts";
import type { PiLotConfig } from "../../src/config/index.ts";

function cfg(): PiLotConfig {
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
  };
}

function gh(result: GhResult): { runner: GhRunner; calls: number } {
  const state = { runner: (async () => result) as GhRunner, calls: 0 };
  state.runner = (async () => {
    state.calls++;
    return result;
  }) as GhRunner;
  return state;
}

function queuedIssueStdout(issueNumber: number, createdAt: string): string {
  return JSON.stringify({
    data: {
      organization: {
        projectV2: {
          id: "PVT_x",
          field: { id: "PVTSSF_x", name: "Status" },
          items: {
            nodes: [
              {
                id: `PVTI_${issueNumber}`,
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
                  number: issueNumber,
                  id: `I_${issueNumber}`,
                  title: `T${issueNumber}`,
                  url: `https://example.com/${issueNumber}`,
                  createdAt,
                  repository: { owner: { login: "octocat" }, name: "widget" },
                },
              },
            ],
          },
        },
      },
    },
  });
}

describe("Conductor.pollOnce", () => {
  test("returns Tasks reported by the Board gateway", async () => {
    const runner: GhRunner = async () => ({
      exitCode: 0,
      stdout: queuedIssueStdout(42, "2026-04-01T00:00:00Z"),
      stderr: "",
    });
    const conductor = new Conductor(cfg(), { gh: runner });

    const tasks = await conductor.pollOnce();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.issueNumber).toBe(42);
  });

  test("logs and returns [] when the Board gateway reports a permission error", async () => {
    const errors: string[] = [];
    const runner: GhRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "GraphQL: missing project scope on token",
    });
    const conductor = new Conductor(cfg(), {
      gh: runner,
      logger: {
        log: () => {},
        error: (m: string) => errors.push(m),
      },
    });

    const tasks = await conductor.pollOnce();
    expect(tasks).toEqual([]);
    expect(errors.some((m) => m.includes("permission"))).toBe(true);
    expect(errors.some((m) => m.includes("gh auth refresh -s project"))).toBe(
      true,
    );
  });

  test("logs and returns [] when gh returns malformed JSON", async () => {
    const errors: string[] = [];
    const runner: GhRunner = async () => ({
      exitCode: 0,
      stdout: "not json",
      stderr: "",
    });
    const conductor = new Conductor(cfg(), {
      gh: runner,
      logger: {
        log: () => {},
        error: (m: string) => errors.push(m),
      },
    });

    const tasks = await conductor.pollOnce();
    expect(tasks).toEqual([]);
    expect(errors.some((m) => m.includes("malformed"))).toBe(true);
  });
});
