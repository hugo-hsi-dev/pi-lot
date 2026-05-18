import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewPhase } from "../../src/phases/index.ts";
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
 * Tests for the Review Phase (issue #9).
 *
 * These tests exercise the observable contract of the Review Phase:
 *  - Before the phase agent runs, the Board status moves to Reviewing.
 *  - A fresh Pi session is started, scoped to the Task worktree, with
 *    repository / Issue / Task Branch / worktree / PR diff facts only
 *    (no prior phase transcripts).
 *  - The rendered prompt instructs the agent to review the Issue and PR
 *    diff, make a single-pass review, fix problems within Task scope,
 *    commit, and push the Task Branch.
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
  return mkdtempSync(join(tmpdir(), "pilot-review-"));
}

interface RecordedSession {
  input: PiSessionInput;
  events: PiSessionEvent[];
  exitCode: number;
}

interface RecordingPiOptions {
  events?: PiSessionEvent[];
  exitCode?: number;
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
    existingDraftPrUrl: "https://github.com/octocat/widget/pull/19",
    ...overrides,
  });
}

describe("ReviewPhase", () => {
  test("moves Board status to Reviewing before starting the Pi session", async () => {
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

    const phase = new ReviewPhase({
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

    expect(order[0]).toBe("status:Reviewing");
    expect(order.includes("pi-session-run")).toBe(true);
    expect(order.indexOf("status:Reviewing")).toBeLessThan(
      order.indexOf("pi-session-run"),
    );
  });

  test("starts a fresh Pi session per invocation with the Task worktree as cwd and Issue/PR facts in scope", async () => {
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

    const phase = new ReviewPhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader({
        body: "Implement frobnicator support.",
        existingDraftPrUrl: "https://github.com/octocat/widget/pull/19",
      }),
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
    expect(sessions[1]!.input).not.toBe(first.input);
  });

  test("renders a Review prompt that instructs the agent on Review Phase responsibilities", async () => {
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

    const phase = new ReviewPhase({
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
    const lower = prompt.toLowerCase();
    expect(lower).toContain("review");
    expect(lower).toContain("issue");
    expect(lower).toContain("pr diff");
    expect(lower).toContain("commit");
    expect(lower).toContain("push");
    // Single-pass review boundary must be communicated explicitly.
    expect(lower).toContain("one pass");
    // Issue facts must appear in the prompt so the fresh session has context.
    expect(prompt).toContain("octocat/widget");
    expect(prompt).toContain("#42");
    expect(prompt).toContain("pi-lot/octocat/widget/issue-42");
    // The PR URL is included so the agent can fetch the diff via gh.
    expect(prompt).toContain("https://github.com/octocat/widget/pull/19");
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

    const phase = new ReviewPhase({
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

    expect(sessions[0]!.input.promptVersion).toMatch(/^review\/v\d+$/);
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

    const phase = new ReviewPhase({
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
    // The label "reviewing" (verb form) is the Board status name; the
    // prompt should describe the verb "review" without mentioning the
    // status label explicitly.
    expect(prompt).not.toContain("status: reviewing");
    expect(prompt).not.toContain("finalizing");
    expect(prompt).not.toContain("ready for review");
    expect(prompt).not.toContain("needs human");
  });

  test("prompt enforces a single-pass review bounded to Task scope", async () => {
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

    const phase = new ReviewPhase({
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
    // Single pass: explicit instruction not to iterate.
    expect(prompt).toContain("one pass");
    // Task scope: explicit instruction to stay within issue scope.
    expect(prompt).toContain("scope");
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

    const phase = new ReviewPhase({
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
    const phaseRecord = reloaded.phases.find((p) => p.name === "review");
    expect(phaseRecord).toBeDefined();
    expect(phaseRecord!.status).toBe("succeeded");
    expect(phaseRecord!.transcriptPath).toMatch(/review\.jsonl$/);
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

    const phase = new ReviewPhase({
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
    expect(reloaded.phases.find((p) => p.name === "review")?.status).toBe(
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

    const phase = new ReviewPhase({
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
    expect(reloaded.phases.find((p) => p.name === "review")?.status).toBe(
      "failed",
    );
  });

  test("uses the Board config's Reviewing status label, not a hardcoded string", async () => {
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
        reviewing: "In Progress (Reviewing)",
      },
    };

    const phase = new ReviewPhase({
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
      "In Progress (Reviewing)",
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

    // Pretend the Implement Phase already wrote a transcript. The Review
    // Phase must not pass it into the fresh review session.
    await store.appendPhaseEvent(run.id, "implement", {
      kind: "message",
      text: "implement phase artifact",
    });

    const { factory, sessions } = recordingPiSession();
    const { updater } = recordingStatusUpdater();

    const phase = new ReviewPhase({
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
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain("implement phase artifact");
  });
});
