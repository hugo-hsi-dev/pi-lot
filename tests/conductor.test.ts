import { describe, expect, test } from "bun:test";
import { Conductor } from "../src/conductor/index.ts";
import type { PiLotConfig } from "../src/config/index.ts";

function fakeConfig(): PiLotConfig {
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

describe("Conductor (scaffold)", () => {
  test("start logs readiness and returns without polling", async () => {
    const lines: string[] = [];
    const logger = {
      log: (msg: string) => lines.push(msg),
      error: (msg: string) => lines.push(msg),
    };
    const conductor = new Conductor(fakeConfig(), logger);
    await conductor.start();
    expect(lines.some((l) => l.includes("Pi Lot Conductor ready"))).toBe(true);
    expect(lines.some((l) => l.includes("no-op"))).toBe(true);
  });
});
