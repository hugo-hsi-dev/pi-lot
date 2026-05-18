import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileSystemRunStore,
  phaseTranscriptPath,
  runRecordPath,
  runsDir,
} from "../../src/runs/index.ts";
import type { CreateRunInput, Run } from "../../src/runs/index.ts";

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "pilot-runs-"));
}

function sampleCreateInput(
  overrides: Partial<CreateRunInput> = {},
): CreateRunInput {
  return {
    taskRef: {
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      issueNumber: 5,
    },
    boardItemId: "PVTI_lADO",
    taskBranch: "pi-lot/hugo-hsi-dev/pi-lot/issue-5",
    worktreePath: "/tmp/state/hugo-hsi-dev/pi-lot/5",
    ...overrides,
  };
}

describe("FileSystemRunStore.createRun", () => {
  test("creates a Run with task identity, board item, branch, worktree, status, and timestamp", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });

    const run = await store.createRun(sampleCreateInput());

    expect(run.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(run.taskRef).toEqual({
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      issueNumber: 5,
    });
    expect(run.boardItemId).toBe("PVTI_lADO");
    expect(run.taskBranch).toBe("pi-lot/hugo-hsi-dev/pi-lot/issue-5");
    expect(run.worktreePath).toBe("/tmp/state/hugo-hsi-dev/pi-lot/5");
    expect(run.status).toBe("queued");
    expect(new Date(run.createdAt).toString()).not.toBe("Invalid Date");
    expect(run.phases).toEqual([]);
  });

  test("persists the Run as JSON under <stateDir>/runs/ with Task identity in the filename", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });

    const run = await store.createRun(sampleCreateInput());

    const expectedFile = runRecordPath(stateDir, run.taskRef, run.id);
    expect(expectedFile).toBe(
      join(stateDir, "runs", `hugo-hsi-dev__pi-lot__5__${run.id}.json`),
    );
    expect(existsSync(expectedFile)).toBe(true);

    const persisted = JSON.parse(readFileSync(expectedFile, "utf8")) as Run;
    expect(persisted.id).toBe(run.id);
    expect(persisted.status).toBe("queued");
    expect(persisted.taskRef.issueNumber).toBe(5);
  });

  test("assigns distinct ids to concurrent createRun calls on the same Task", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });

    const a = await store.createRun(sampleCreateInput());
    const b = await store.createRun(sampleCreateInput());

    expect(b.id).not.toBe(a.id);
    const files = readdirSync(runsDir(stateDir));
    expect(files.length).toBe(2);
  });
});

describe("FileSystemRunStore.appendPhaseEvent", () => {
  test("creates a JSONL transcript file under <stateDir>/transcripts/<runId>/<phaseName>.jsonl", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const run = await store.createRun(sampleCreateInput());

    await store.appendPhaseEvent(run.id, "implement", {
      kind: "message",
      text: "hello",
    });
    await store.appendPhaseEvent(run.id, "implement", {
      kind: "tool_use",
      name: "bash",
    });

    const expected = phaseTranscriptPath(stateDir, run.id, "implement");
    expect(expected).toBe(
      join(stateDir, "transcripts", run.id, "implement.jsonl"),
    );
    expect(existsSync(expected)).toBe(true);

    const lines = readFileSync(expected, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ kind: "message", text: "hello" });
    expect(JSON.parse(lines[1]!)).toEqual({ kind: "tool_use", name: "bash" });
  });

  test("appends a Phase record with status running on first event, pointing at the transcript file", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const run = await store.createRun(sampleCreateInput());

    await store.appendPhaseEvent(run.id, "implement", { kind: "message" });

    const reloaded = await store.loadRun(run.id);
    expect(reloaded?.phases).toHaveLength(1);
    const phase = reloaded?.phases[0]!;
    expect(phase.name).toBe("implement");
    expect(phase.status).toBe("running");
    expect(phase.transcriptPath).toBe(
      phaseTranscriptPath(stateDir, run.id, "implement"),
    );
    expect(new Date(phase.startedAt).toString()).not.toBe("Invalid Date");
    expect(phase.endedAt).toBeUndefined();
  });

  test("flips Run status from queued to running on first phase event", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const run = await store.createRun(sampleCreateInput());
    expect(run.status).toBe("queued");

    await store.appendPhaseEvent(run.id, "implement", { kind: "message" });

    const reloaded = await store.loadRun(run.id);
    expect(reloaded?.status).toBe("running");
  });

  test("does not duplicate the Phase record across multiple events", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const run = await store.createRun(sampleCreateInput());

    await store.appendPhaseEvent(run.id, "review", { kind: "message", i: 1 });
    await store.appendPhaseEvent(run.id, "review", { kind: "message", i: 2 });
    await store.appendPhaseEvent(run.id, "review", { kind: "message", i: 3 });

    const reloaded = await store.loadRun(run.id);
    const reviewPhases = reloaded?.phases.filter((p) => p.name === "review") ?? [];
    expect(reviewPhases).toHaveLength(1);
  });

  test("keeps Phase records independent across Phases", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const run = await store.createRun(sampleCreateInput());

    await store.appendPhaseEvent(run.id, "implement", { kind: "message" });
    await store.appendPhaseEvent(run.id, "review", { kind: "message" });
    await store.appendPhaseEvent(run.id, "finalize", { kind: "message" });

    const reloaded = await store.loadRun(run.id);
    const names = reloaded?.phases.map((p) => p.name).sort() ?? [];
    expect(names).toEqual(["finalize", "implement", "review"]);
    const paths = new Set(reloaded?.phases.map((p) => p.transcriptPath));
    expect(paths.size).toBe(3);
  });
});

describe("FileSystemRunStore.completePhase", () => {
  test("marks the Phase succeeded with an endedAt timestamp", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const run = await store.createRun(sampleCreateInput());
    await store.appendPhaseEvent(run.id, "implement", { kind: "message" });

    await store.completePhase(run.id, "implement", { status: "succeeded" });

    const reloaded = await store.loadRun(run.id);
    const phase = reloaded?.phases.find((p) => p.name === "implement")!;
    expect(phase.status).toBe("succeeded");
    expect(new Date(phase.endedAt!).toString()).not.toBe("Invalid Date");
  });

  test("stores a Terminal Report on the Finalize Phase record when provided", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const run = await store.createRun(sampleCreateInput());
    await store.appendPhaseEvent(run.id, "finalize", { kind: "message" });

    await store.completePhase(run.id, "finalize", {
      status: "succeeded",
      terminalReport: {
        status: "ready-for-review",
        summary: "All good",
        prUrl: "https://github.com/hugo-hsi-dev/pi-lot/pull/99",
      },
    });

    const reloaded = await store.loadRun(run.id);
    const finalize = reloaded?.phases.find((p) => p.name === "finalize")!;
    expect(finalize.terminalReport?.status).toBe("ready-for-review");
    expect(finalize.terminalReport?.prUrl).toBe(
      "https://github.com/hugo-hsi-dev/pi-lot/pull/99",
    );
  });

  test("records a failed Phase even when no transcript event was ever appended", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const run = await store.createRun(sampleCreateInput());

    await store.completePhase(run.id, "implement", { status: "failed" });

    const reloaded = await store.loadRun(run.id);
    const phase = reloaded?.phases.find((p) => p.name === "implement")!;
    expect(phase.status).toBe("failed");
    expect(phase.endedAt).toBeDefined();
    // Transcript path is still recorded so a debugger knows where logs would have lived.
    expect(phase.transcriptPath).toBe(
      phaseTranscriptPath(stateDir, run.id, "implement"),
    );
  });
});

describe("FileSystemRunStore.completeRun", () => {
  test("flips a Run to ready-for-review and records the Terminal Report on the Run", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const run = await store.createRun(sampleCreateInput());

    await store.completeRun(run.id, {
      status: "ready-for-review",
      terminalReport: {
        status: "ready-for-review",
        summary: "shipped",
        prUrl: "https://github.com/x/y/pull/1",
      },
    });

    const reloaded = await store.loadRun(run.id);
    expect(reloaded?.status).toBe("ready-for-review");
    expect(reloaded?.endedAt).toBeDefined();
    expect(reloaded?.terminalReport?.summary).toBe("shipped");
  });

  test("flips a Run to needs-human and preserves prior phase records", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const run = await store.createRun(sampleCreateInput());
    await store.appendPhaseEvent(run.id, "implement", { kind: "message" });
    await store.completePhase(run.id, "implement", { status: "failed" });

    await store.completeRun(run.id, {
      status: "needs-human",
      terminalReport: {
        status: "needs-human",
        needsHumanReason: "implement phase crashed",
      },
    });

    const reloaded = await store.loadRun(run.id);
    expect(reloaded?.status).toBe("needs-human");
    expect(reloaded?.phases.find((p) => p.name === "implement")?.status).toBe(
      "failed",
    );
    expect(reloaded?.terminalReport?.needsHumanReason).toBe(
      "implement phase crashed",
    );
  });
});

describe("FileSystemRunStore.loadRun", () => {
  test("returns null for an unknown Run id", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    expect(await store.loadRun("does-not-exist")).toBeNull();
  });
});

describe("FileSystemRunStore.listActiveRuns", () => {
  test("returns only Runs whose status is queued or running", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });

    const queued = await store.createRun(sampleCreateInput());
    const running = await store.createRun(
      sampleCreateInput({ taskRef: { owner: "o", repo: "r", issueNumber: 7 } }),
    );
    await store.appendPhaseEvent(running.id, "implement", { kind: "message" });

    const ready = await store.createRun(
      sampleCreateInput({ taskRef: { owner: "o", repo: "r", issueNumber: 8 } }),
    );
    await store.completeRun(ready.id, { status: "ready-for-review" });

    const needsHuman = await store.createRun(
      sampleCreateInput({ taskRef: { owner: "o", repo: "r", issueNumber: 9 } }),
    );
    await store.completeRun(needsHuman.id, { status: "needs-human" });

    const active = await store.listActiveRuns();
    const ids = active.map((r) => r.id).sort();
    expect(ids).toEqual([queued.id, running.id].sort());
  });

  test("returns an empty list when no Runs have been created yet", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    expect(await store.listActiveRuns()).toEqual([]);
  });
});

describe("FileSystemRunStore deterministic injection", () => {
  test("uses injected newId and now for reproducible Runs", async () => {
    const stateDir = makeStateDir();
    let counter = 0;
    const store = new FileSystemRunStore({
      stateDir,
      now: () => new Date("2025-01-01T00:00:00Z"),
      newId: () => `run-${++counter}`,
    });

    const run = await store.createRun(sampleCreateInput());
    expect(run.id).toBe("run-1");
    expect(run.createdAt).toBe("2025-01-01T00:00:00.000Z");

    const file = runRecordPath(stateDir, run.taskRef, "run-1");
    expect(existsSync(file)).toBe(true);
  });
});
