import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImplementPhase } from "../../src/phases/index.ts";
import type {
  PiSession,
  PiSessionEvent,
  PiSessionFactory,
  PiSessionInput,
} from "../../src/phases/index.ts";
import type {
  IssueContext,
  IssueContextLoader,
} from "../../src/phases/index.ts";
import type { BoardStatusUpdater } from "../../src/phases/index.ts";
import { FileSystemRunStore } from "../../src/runs/index.ts";
import type { Run } from "../../src/runs/index.ts";
import type { Task } from "../../src/board/index.ts";
import type { BoardConfig } from "../../src/config/index.ts";

/**
 * Tests for the Implement Phase (issue #8).
 *
 * These tests exercise the observable contract of the Implement Phase:
 *  - Before the phase agent runs, the Board status moves Queued -> Implementing.
 *  - A fresh Pi session is started, scoped to the Task worktree, with
 *    repository / Issue / Task Branch / worktree / PR lookup facts only
 *    (no prior phase transcripts).
 *  - The rendered prompt instructs the agent to read the Issue, change
 *    code within Task scope, run relevant checks when practical, commit,
 *    push, and create or update a draft Pull Request.
 *  - The prompt does NOT mention the Board / GitHub Project status.
 *  - The phase records its events + outcome on the Run Record.
 *
 * No real Pi SDK, gh, or git calls happen here.
 */

const BOARD_CONFIG: BoardConfig = {
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
  return mkdtempSync(join(tmpdir(), "pilot-impl-"));
}

interface RecordedSession {
  input: PiSessionInput;
  events: PiSessionEvent[];
  exitCode: number;
}

interface RecordingPiOptions {
  /** Events the fake session should emit on `run()`. */
  events?: PiSessionEvent[];
  /** Exit code returned by `run()`. Defaults to 0 (success). */
  exitCode?: number;
  /** Throw inside `run()` to simulate a fatal session failure. */
  throwOnRun?: Error;
}

function recordingPiSession(opts: RecordingPiOptions = {}): {
  factory: PiSessionFactory;
  sessions: RecordedSession[];
} {
  const sessions: RecordedSession[] = [];
  const factory: PiSessionFactory = (input) => {
    const events = opts.events ?? [
      { kind: "message", text: "ok" } satisfies PiSessionEvent,
    ];
    const exitCode = opts.exitCode ?? 0;
    const record: RecordedSession = { input, events, exitCode };
    sessions.push(record);
    const session: PiSession = {
      async run(handler) {
        if (opts.throwOnRun) throw opts.throwOnRun;
        for (const e of events) {
          await handler(e);
        }
        return { exitCode };
      },
    };
    return session;
  };
  return { factory, sessions };
}

interface RecordingStatusUpdater {
  updater: BoardStatusUpdater;
  calls: Array<{
    projectId: string;
    statusFieldId: string;
    boardItemId: string;
    statusValue: string;
  }>;
}

function recordingStatusUpdater(
  opts: { throwOn?: string } = {},
): RecordingStatusUpdater {
  const calls: RecordingStatusUpdater["calls"] = [];
  const updater: BoardStatusUpdater = async (req) => {
    calls.push({ ...req });
    if (opts.throwOn && opts.throwOn === req.statusValue) {
      throw new Error(`fake updater rejected status ${req.statusValue}`);
    }
  };
  return { updater, calls };
}

function fakeIssueContextLoader(
  overrides: Partial<IssueContext> = {},
): IssueContextLoader {
  return async () => ({
    body: "Issue body explaining the request.",
    labels: ["ready-for-agent"],
    existingDraftPrUrl: undefined,
    ...overrides,
  });
}

describe("ImplementPhase", () => {
  test("moves Board status from Queued to Implementing before starting the Pi session", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await store.createRun({
      taskRef: {
        owner: task.repository.owner,
        repo: task.repository.name,
        issueNumber: task.issueNumber,
      },
      boardItemId: task.boardItemId,
      taskBranch: "pi-lot/octocat/widget/issue-42",
      worktreePath: "/tmp/state/octocat/widget/42",
    });

    const order: string[] = [];
    const { updater } = recordingStatusUpdater();
    const wrappedUpdater: BoardStatusUpdater = async (req) => {
      order.push(`status:${req.statusValue}`);
      await updater(req);
    };

    const { factory } = recordingPiSession({
      events: [{ kind: "message", text: "started" }],
    });
    const wrappedFactory: PiSessionFactory = (input) => {
      const inner = factory(input);
      return {
        async run(handler) {
          order.push("pi-session-run");
          return inner.run(handler);
        },
      };
    };

    const phase = new ImplementPhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: wrappedFactory,
      boardStatusUpdater: wrappedUpdater,
      issueContextLoader: fakeIssueContextLoader(),
    });

    await phase.run({
      task,
      run,
      workspace: {
        repoPath: "/tmp/projects/widget",
        worktreePath: "/tmp/state/octocat/widget/42",
        taskBranch: "pi-lot/octocat/widget/issue-42",
        baseBranch: "main",
      },
    });

    expect(order[0]).toBe("status:Implementing");
    expect(order.includes("pi-session-run")).toBe(true);
    expect(order.indexOf("status:Implementing")).toBeLessThan(
      order.indexOf("pi-session-run"),
    );
  });

  test("starts a fresh Pi session per invocation with the Task worktree as cwd and Issue/branch/PR facts in scope", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await store.createRun({
      taskRef: {
        owner: task.repository.owner,
        repo: task.repository.name,
        issueNumber: task.issueNumber,
      },
      boardItemId: task.boardItemId,
      taskBranch: "pi-lot/octocat/widget/issue-42",
      worktreePath: "/tmp/state/octocat/widget/42",
    });

    const { factory, sessions } = recordingPiSession();
    const { updater } = recordingStatusUpdater();

    const phase = new ImplementPhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader({
        body: "Implement frobnicator support.",
        existingDraftPrUrl: "https://github.com/octocat/widget/pull/19",
      }),
    });

    // Invoke twice; we should see two independent sessions (no shared state).
    await phase.run({
      task,
      run,
      workspace: {
        repoPath: "/tmp/projects/widget",
        worktreePath: "/tmp/state/octocat/widget/42",
        taskBranch: "pi-lot/octocat/widget/issue-42",
        baseBranch: "main",
      },
    });
    await phase.run({
      task,
      run,
      workspace: {
        repoPath: "/tmp/projects/widget",
        worktreePath: "/tmp/state/octocat/widget/42",
        taskBranch: "pi-lot/octocat/widget/issue-42",
        baseBranch: "main",
      },
    });

    expect(sessions).toHaveLength(2);
    const first = sessions[0]!;
    expect(first.input.cwd).toBe("/tmp/state/octocat/widget/42");
    expect(first.input.facts.repository).toEqual({
      owner: "octocat",
      name: "widget",
    });
    expect(first.input.facts.issue.number).toBe(42);
    expect(first.input.facts.issue.title).toBe("Add a frobnicator");
    expect(first.input.facts.issue.body).toBe("Implement frobnicator support.");
    expect(first.input.facts.issue.url).toBe(
      "https://github.com/octocat/widget/issues/42",
    );
    expect(first.input.facts.taskBranch).toBe(
      "pi-lot/octocat/widget/issue-42",
    );
    expect(first.input.facts.baseBranch).toBe("main");
    expect(first.input.facts.worktreePath).toBe(
      "/tmp/state/octocat/widget/42",
    );
    expect(first.input.facts.existingDraftPrUrl).toBe(
      "https://github.com/octocat/widget/pull/19",
    );
    // Each session is independent; the same factory was called per invocation.
    expect(sessions[1]!.input).not.toBe(first.input);
  });

  test("renders an Implement prompt that instructs the agent on Implement Phase responsibilities", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await store.createRun({
      taskRef: {
        owner: task.repository.owner,
        repo: task.repository.name,
        issueNumber: task.issueNumber,
      },
      boardItemId: task.boardItemId,
      taskBranch: "pi-lot/octocat/widget/issue-42",
      worktreePath: "/tmp/state/octocat/widget/42",
    });
    const { factory, sessions } = recordingPiSession();
    const { updater } = recordingStatusUpdater();

    const phase = new ImplementPhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
    });

    await phase.run({
      task,
      run,
      workspace: {
        repoPath: "/tmp/projects/widget",
        worktreePath: "/tmp/state/octocat/widget/42",
        taskBranch: "pi-lot/octocat/widget/issue-42",
        baseBranch: "main",
      },
    });

    const prompt = sessions[0]!.input.prompt;
    expect(typeof prompt).toBe("string");
    // The prompt instructs the agent on each Implement Phase responsibility.
    expect(prompt.toLowerCase()).toContain("read");
    expect(prompt.toLowerCase()).toContain("issue");
    expect(prompt.toLowerCase()).toContain("commit");
    expect(prompt.toLowerCase()).toContain("push");
    expect(prompt.toLowerCase()).toContain("draft pull request");
    // Issue facts must appear in the prompt so the fresh session has context.
    expect(prompt).toContain("octocat/widget");
    expect(prompt).toContain("#42");
    expect(prompt).toContain("pi-lot/octocat/widget/issue-42");
  });

  test("prompt versioning is exposed so prompt template changes are reviewable", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await store.createRun({
      taskRef: {
        owner: task.repository.owner,
        repo: task.repository.name,
        issueNumber: task.issueNumber,
      },
      boardItemId: task.boardItemId,
      taskBranch: "pi-lot/octocat/widget/issue-42",
      worktreePath: "/tmp/state/octocat/widget/42",
    });
    const { factory, sessions } = recordingPiSession();
    const { updater } = recordingStatusUpdater();

    const phase = new ImplementPhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
    });

    await phase.run({
      task,
      run,
      workspace: {
        repoPath: "/tmp/projects/widget",
        worktreePath: "/tmp/state/octocat/widget/42",
        taskBranch: "pi-lot/octocat/widget/issue-42",
        baseBranch: "main",
      },
    });

    expect(sessions[0]!.input.promptVersion).toMatch(/^implement\/v\d+$/);
  });

  test("prompt does not instruct the agent to manage Board or Project status", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await store.createRun({
      taskRef: {
        owner: task.repository.owner,
        repo: task.repository.name,
        issueNumber: task.issueNumber,
      },
      boardItemId: task.boardItemId,
      taskBranch: "pi-lot/octocat/widget/issue-42",
      worktreePath: "/tmp/state/octocat/widget/42",
    });
    const { factory, sessions } = recordingPiSession();
    const { updater } = recordingStatusUpdater();

    const phase = new ImplementPhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
    });

    await phase.run({
      task,
      run,
      workspace: {
        repoPath: "/tmp/projects/widget",
        worktreePath: "/tmp/state/octocat/widget/42",
        taskBranch: "pi-lot/octocat/widget/issue-42",
        baseBranch: "main",
      },
    });

    const prompt = sessions[0]!.input.prompt.toLowerCase();
    expect(prompt).not.toContain("board");
    expect(prompt).not.toContain("project status");
    expect(prompt).not.toContain("status field");
    expect(prompt).not.toContain("queued");
    expect(prompt).not.toContain("implementing");
    expect(prompt).not.toContain("reviewing");
    expect(prompt).not.toContain("finalizing");
    expect(prompt).not.toContain("ready for review");
    expect(prompt).not.toContain("needs human");
  });

  test("records phase events and a transcript path on the Run Record", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await store.createRun({
      taskRef: {
        owner: task.repository.owner,
        repo: task.repository.name,
        issueNumber: task.issueNumber,
      },
      boardItemId: task.boardItemId,
      taskBranch: "pi-lot/octocat/widget/issue-42",
      worktreePath: "/tmp/state/octocat/widget/42",
    });

    const { factory } = recordingPiSession({
      events: [
        { kind: "message", text: "start" },
        { kind: "tool_use", name: "bash" },
        { kind: "message", text: "done" },
      ],
    });
    const { updater } = recordingStatusUpdater();

    const phase = new ImplementPhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
    });

    const outcome = await phase.run({
      task,
      run,
      workspace: {
        repoPath: "/tmp/projects/widget",
        worktreePath: "/tmp/state/octocat/widget/42",
        taskBranch: "pi-lot/octocat/widget/issue-42",
        baseBranch: "main",
      },
    });

    expect(outcome.status).toBe("succeeded");

    const reloaded = (await store.loadRun(run.id)) as Run;
    const phaseRecord = reloaded.phases.find((p) => p.name === "implement");
    expect(phaseRecord).toBeDefined();
    expect(phaseRecord!.status).toBe("succeeded");
    expect(phaseRecord!.transcriptPath).toMatch(/implement\.jsonl$/);
    expect(phaseRecord!.endedAt).toBeDefined();
    expect(outcome.transcriptPath).toBe(phaseRecord!.transcriptPath);
  });

  test("records a failed Phase outcome when the Pi session exits non-zero", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await store.createRun({
      taskRef: {
        owner: task.repository.owner,
        repo: task.repository.name,
        issueNumber: task.issueNumber,
      },
      boardItemId: task.boardItemId,
      taskBranch: "pi-lot/octocat/widget/issue-42",
      worktreePath: "/tmp/state/octocat/widget/42",
    });
    const { factory } = recordingPiSession({ exitCode: 2 });
    const { updater } = recordingStatusUpdater();

    const phase = new ImplementPhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
    });

    const outcome = await phase.run({
      task,
      run,
      workspace: {
        repoPath: "/tmp/projects/widget",
        worktreePath: "/tmp/state/octocat/widget/42",
        taskBranch: "pi-lot/octocat/widget/issue-42",
        baseBranch: "main",
      },
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toMatch(/exit/);
    }
    const reloaded = (await store.loadRun(run.id)) as Run;
    expect(reloaded.phases.find((p) => p.name === "implement")?.status).toBe(
      "failed",
    );
  });

  test("records a failed Phase outcome when the Pi session throws fatally", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await store.createRun({
      taskRef: {
        owner: task.repository.owner,
        repo: task.repository.name,
        issueNumber: task.issueNumber,
      },
      boardItemId: task.boardItemId,
      taskBranch: "pi-lot/octocat/widget/issue-42",
      worktreePath: "/tmp/state/octocat/widget/42",
    });
    const { factory } = recordingPiSession({
      throwOnRun: new Error("boom"),
    });
    const { updater } = recordingStatusUpdater();

    const phase = new ImplementPhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
    });

    const outcome = await phase.run({
      task,
      run,
      workspace: {
        repoPath: "/tmp/projects/widget",
        worktreePath: "/tmp/state/octocat/widget/42",
        taskBranch: "pi-lot/octocat/widget/issue-42",
        baseBranch: "main",
      },
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("boom");
    }
    const reloaded = (await store.loadRun(run.id)) as Run;
    expect(reloaded.phases.find((p) => p.name === "implement")?.status).toBe(
      "failed",
    );
  });

  test("uses the Board config's Implementing status label, not a hardcoded string", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await store.createRun({
      taskRef: {
        owner: task.repository.owner,
        repo: task.repository.name,
        issueNumber: task.issueNumber,
      },
      boardItemId: task.boardItemId,
      taskBranch: "pi-lot/octocat/widget/issue-42",
      worktreePath: "/tmp/state/octocat/widget/42",
    });
    const { factory } = recordingPiSession();
    const { updater, calls } = recordingStatusUpdater();

    const customBoard: BoardConfig = {
      ...BOARD_CONFIG,
      statusValues: {
        ...BOARD_CONFIG.statusValues,
        implementing: "In Progress (Implementing)",
      },
    };

    const phase = new ImplementPhase({
      board: customBoard,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
    });

    await phase.run({
      task,
      run,
      workspace: {
        repoPath: "/tmp/projects/widget",
        worktreePath: "/tmp/state/octocat/widget/42",
        taskBranch: "pi-lot/octocat/widget/issue-42",
        baseBranch: "main",
      },
    });

    expect(calls.map((c) => c.statusValue)).toEqual([
      "In Progress (Implementing)",
    ]);
    expect(calls[0]!.projectId).toBe("PVT_X");
    expect(calls[0]!.statusFieldId).toBe("PVTSSF_X");
    expect(calls[0]!.boardItemId).toBe("PVTI_42");
  });

  test("does not pass prior phase transcripts to the fresh Pi session", async () => {
    const stateDir = makeStateDir();
    const store = new FileSystemRunStore({ stateDir });
    const task = makeTask();
    const run = await store.createRun({
      taskRef: {
        owner: task.repository.owner,
        repo: task.repository.name,
        issueNumber: task.issueNumber,
      },
      boardItemId: task.boardItemId,
      taskBranch: "pi-lot/octocat/widget/issue-42",
      worktreePath: "/tmp/state/octocat/widget/42",
    });

    // Pretend a prior phase already wrote a transcript (e.g., from a
    // previous Run attempt). The Implement Phase must not pass it in.
    await store.appendPhaseEvent(run.id, "implement", {
      kind: "message",
      text: "previous attempt artifact",
    });

    const { factory, sessions } = recordingPiSession();
    const { updater } = recordingStatusUpdater();

    const phase = new ImplementPhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
    });

    const freshRun = (await store.loadRun(run.id)) as Run;
    await phase.run({
      task,
      run: freshRun,
      workspace: {
        repoPath: "/tmp/projects/widget",
        worktreePath: "/tmp/state/octocat/widget/42",
        taskBranch: "pi-lot/octocat/widget/issue-42",
        baseBranch: "main",
      },
    });

    const input = sessions[0]!.input;
    // The fresh session must not be given prior transcripts in any shape.
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain("previous attempt artifact");
  });
});
