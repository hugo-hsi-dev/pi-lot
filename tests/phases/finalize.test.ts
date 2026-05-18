import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FinalizePhase } from "../../src/phases/index.ts";
import type {
  BoardStatusUpdater,
  IssueContext,
  IssueContextLoader,
  PiSession,
  PiSessionEvent,
  PiSessionFactory,
  PiSessionInput,
} from "../../src/phases/index.ts";
import type {
  DeleteWorktreeFn,
  PrTemplateLoader,
} from "../../src/phases/finalize.ts";
import {
  TERMINAL_REPORT_BEGIN,
  TERMINAL_REPORT_END,
} from "../../src/phases/terminal-report.ts";
import { FileSystemRunStore } from "../../src/runs/index.ts";
import type { Run } from "../../src/runs/index.ts";
import type { Task } from "../../src/board/index.ts";
import type { BoardConfig } from "../../src/config/index.ts";

/**
 * Tests for the Finalize Phase (issue #10).
 *
 * These tests exercise observable behavior only:
 *  - Before the agent runs, the Board status moves to "Finalizing".
 *  - A fresh Pi session is started, scoped to the Task worktree, with
 *    Issue / PR / branch / workspace / PR-template facts in scope (no
 *    prior phase transcripts).
 *  - The rendered prompt instructs the agent to ensure the PR is open,
 *    pushed, linked to the Issue, follows the available PR template, and
 *    is marked ready for review, then to emit a Terminal Report block.
 *  - The prompt does not mention Board / Project status.
 *  - A valid ready-for-review Terminal Report:
 *      - is recorded on the Run Record and the Phase Record,
 *      - moves the Board item to "Ready for Review",
 *      - deletes the Task worktree.
 *  - A missing / invalid Terminal Report:
 *      - is NOT treated as a successful handoff,
 *      - does NOT move the Board item to "Ready for Review",
 *      - does NOT delete the worktree.
 *  - Transcript events are appended to the Run Record.
 *
 * No real Pi SDK, gh, git, or filesystem deletion happens here.
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
  return mkdtempSync(join(tmpdir(), "pilot-finalize-"));
}

const VALID_REPORT_TEXT = [
  TERMINAL_REPORT_BEGIN,
  JSON.stringify({
    status: "ready-for-review",
    issue: { owner: "octocat", repo: "widget", number: 42 },
    prUrl: "https://github.com/octocat/widget/pull/19",
    summary: "PR opened, pushed, linked, marked ready for review.",
  }),
  TERMINAL_REPORT_END,
].join("\n");

interface RecordedSession {
  input: PiSessionInput;
  events: PiSessionEvent[];
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
      { kind: "message", text: VALID_REPORT_TEXT } satisfies PiSessionEvent,
    ];
    sessions.push({ input, events });
    const session: PiSession = {
      async run(handler) {
        if (opts.throwOnRun) throw opts.throwOnRun;
        for (const e of events) await handler(e);
        return { exitCode: opts.exitCode ?? 0 };
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

function recordingStatusUpdater(): RecordingStatusUpdater {
  const calls: RecordingStatusUpdater["calls"] = [];
  const updater: BoardStatusUpdater = async (req) => {
    calls.push({ ...req });
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

function fakeTemplateLoader(value: string | null): PrTemplateLoader {
  return async () => value;
}

interface RecordingDeleter {
  fn: DeleteWorktreeFn;
  calls: string[];
}

function recordingDeleter(opts: { throwOn?: string } = {}): RecordingDeleter {
  const calls: string[] = [];
  const fn: DeleteWorktreeFn = async (path) => {
    calls.push(path);
    if (opts.throwOn === path) throw new Error(`refusing to delete ${path}`);
  };
  return { fn, calls };
}

async function makeRun(stateDir: string, task: Task) {
  const store = new FileSystemRunStore({ stateDir });
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
  return { store, run };
}

const STANDARD_WORKSPACE = {
  repoPath: "/tmp/projects/widget",
  worktreePath: "/tmp/state/octocat/widget/42",
  taskBranch: "pi-lot/octocat/widget/issue-42",
  baseBranch: "main",
};

describe("FinalizePhase", () => {
  test("moves Board status to Finalizing before starting the Pi session", async () => {
    const stateDir = makeStateDir();
    const task = makeTask();
    const { store, run } = await makeRun(stateDir, task);

    const order: string[] = [];
    const { updater } = recordingStatusUpdater();
    const wrappedUpdater: BoardStatusUpdater = async (req) => {
      order.push(`status:${req.statusValue}`);
      await updater(req);
    };

    const { factory } = recordingPiSession();
    const wrappedFactory: PiSessionFactory = (input) => {
      const inner = factory(input);
      return {
        async run(handler) {
          order.push("pi-session-run");
          return inner.run(handler);
        },
      };
    };

    const phase = new FinalizePhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: wrappedFactory,
      boardStatusUpdater: wrappedUpdater,
      issueContextLoader: fakeIssueContextLoader(),
      prTemplateLoader: fakeTemplateLoader(null),
      deleteWorktree: recordingDeleter().fn,
    });

    await phase.run({ task, run, workspace: STANDARD_WORKSPACE });

    expect(order[0]).toBe("status:Finalizing");
    expect(order.includes("pi-session-run")).toBe(true);
    expect(order.indexOf("status:Finalizing")).toBeLessThan(
      order.indexOf("pi-session-run"),
    );
  });

  test("starts a fresh Pi session with the Task worktree as cwd and Issue/PR facts in scope", async () => {
    const stateDir = makeStateDir();
    const task = makeTask();
    const { store, run } = await makeRun(stateDir, task);

    const { factory, sessions } = recordingPiSession();
    const { updater } = recordingStatusUpdater();

    const phase = new FinalizePhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader({
        body: "Finalize frobnicator handoff.",
        existingDraftPrUrl: "https://github.com/octocat/widget/pull/19",
      }),
      prTemplateLoader: fakeTemplateLoader(null),
      deleteWorktree: recordingDeleter().fn,
    });

    await phase.run({ task, run, workspace: STANDARD_WORKSPACE });

    expect(sessions).toHaveLength(1);
    const input = sessions[0]!.input;
    expect(input.cwd).toBe(STANDARD_WORKSPACE.worktreePath);
    expect(input.facts.repository).toEqual({ owner: "octocat", name: "widget" });
    expect(input.facts.issue.number).toBe(42);
    expect(input.facts.issue.title).toBe("Add a frobnicator");
    expect(input.facts.issue.body).toBe("Finalize frobnicator handoff.");
    expect(input.facts.taskBranch).toBe(STANDARD_WORKSPACE.taskBranch);
    expect(input.facts.baseBranch).toBe("main");
    expect(input.facts.existingDraftPrUrl).toBe(
      "https://github.com/octocat/widget/pull/19",
    );
  });

  test("renders a Finalize prompt that instructs handoff responsibilities", async () => {
    const stateDir = makeStateDir();
    const task = makeTask();
    const { store, run } = await makeRun(stateDir, task);

    const { factory, sessions } = recordingPiSession();
    const { updater } = recordingStatusUpdater();

    const phase = new FinalizePhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
      prTemplateLoader: fakeTemplateLoader(null),
      deleteWorktree: recordingDeleter().fn,
    });

    await phase.run({ task, run, workspace: STANDARD_WORKSPACE });

    const prompt = sessions[0]!.input.prompt;
    expect(typeof prompt).toBe("string");
    const lower = prompt.toLowerCase();
    // Handoff responsibilities, per PRD #1 user story 28.
    expect(lower).toContain("pull request");
    expect(lower).toContain("ready for review");
    expect(lower).toContain("push");
    expect(lower).toContain("link");
    // Terminal Report instruction must reference the markers so the
    // parser and the agent stay aligned.
    expect(prompt).toContain(TERMINAL_REPORT_BEGIN);
    expect(prompt).toContain(TERMINAL_REPORT_END);
    // Issue facts must appear so the fresh session has context.
    expect(prompt).toContain("octocat/widget");
    expect(prompt).toContain("#42");
  });

  test("includes the PR template body in the prompt when one is available", async () => {
    const stateDir = makeStateDir();
    const task = makeTask();
    const { store, run } = await makeRun(stateDir, task);
    const { factory, sessions } = recordingPiSession();
    const { updater } = recordingStatusUpdater();

    const phase = new FinalizePhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
      prTemplateLoader: fakeTemplateLoader(
        "## Summary\n\n- describe the change\n\n## Test plan\n\n- [ ] add tests",
      ),
      deleteWorktree: recordingDeleter().fn,
    });

    await phase.run({ task, run, workspace: STANDARD_WORKSPACE });

    const prompt = sessions[0]!.input.prompt;
    expect(prompt).toContain("## Summary");
    expect(prompt).toContain("## Test plan");
  });

  test("omits PR template section when no template is available", async () => {
    const stateDir = makeStateDir();
    const task = makeTask();
    const { store, run } = await makeRun(stateDir, task);
    const { factory, sessions } = recordingPiSession();
    const { updater } = recordingStatusUpdater();

    const phase = new FinalizePhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
      prTemplateLoader: fakeTemplateLoader(null),
      deleteWorktree: recordingDeleter().fn,
    });

    await phase.run({ task, run, workspace: STANDARD_WORKSPACE });

    const prompt = sessions[0]!.input.prompt;
    // No template body, no markdown section markers leaking through.
    expect(prompt).not.toContain("## Summary");
  });

  test("prompt versioning is exposed so prompt template changes are reviewable", async () => {
    const stateDir = makeStateDir();
    const task = makeTask();
    const { store, run } = await makeRun(stateDir, task);
    const { factory, sessions } = recordingPiSession();
    const { updater } = recordingStatusUpdater();

    const phase = new FinalizePhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
      prTemplateLoader: fakeTemplateLoader(null),
      deleteWorktree: recordingDeleter().fn,
    });

    await phase.run({ task, run, workspace: STANDARD_WORKSPACE });

    expect(sessions[0]!.input.promptVersion).toMatch(/^finalize\/v\d+$/);
  });

  test("prompt does not instruct the agent about Board or Project status fields", async () => {
    const stateDir = makeStateDir();
    const task = makeTask();
    const { store, run } = await makeRun(stateDir, task);
    const { factory, sessions } = recordingPiSession();
    const { updater } = recordingStatusUpdater();

    const phase = new FinalizePhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
      prTemplateLoader: fakeTemplateLoader(null),
      deleteWorktree: recordingDeleter().fn,
    });

    await phase.run({ task, run, workspace: STANDARD_WORKSPACE });

    const prompt = sessions[0]!.input.prompt.toLowerCase();
    expect(prompt).not.toContain("board");
    expect(prompt).not.toContain("project status");
    expect(prompt).not.toContain("status field");
    expect(prompt).not.toContain("queued");
    expect(prompt).not.toContain("implementing");
    expect(prompt).not.toContain("reviewing");
    expect(prompt).not.toContain("finalizing");
    expect(prompt).not.toContain("needs human");
  });

  test("on a valid ready-for-review Terminal Report: records report, moves Board to Ready for Review, deletes worktree", async () => {
    const stateDir = makeStateDir();
    const task = makeTask();
    const { store, run } = await makeRun(stateDir, task);

    const { factory } = recordingPiSession({
      events: [
        { kind: "message", text: "doing finalize work" },
        { kind: "message", text: VALID_REPORT_TEXT },
      ],
    });
    const { updater, calls } = recordingStatusUpdater();
    const deleter = recordingDeleter();

    const phase = new FinalizePhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
      prTemplateLoader: fakeTemplateLoader(null),
      deleteWorktree: deleter.fn,
    });

    const outcome = await phase.run({
      task,
      run,
      workspace: STANDARD_WORKSPACE,
    });

    expect(outcome.status).toBe("succeeded");

    expect(calls.map((c) => c.statusValue)).toEqual([
      "Finalizing",
      "Ready for Review",
    ]);
    // The Ready-for-Review transition uses the Task's Board identifiers.
    const finalCall = calls[calls.length - 1]!;
    expect(finalCall.boardItemId).toBe(task.boardItemId);
    expect(finalCall.projectId).toBe(task.projectId);
    expect(finalCall.statusFieldId).toBe(task.statusFieldId);

    expect(deleter.calls).toEqual([STANDARD_WORKSPACE.worktreePath]);

    const reloaded = (await store.loadRun(run.id)) as Run;
    expect(reloaded.status).toBe("ready-for-review");
    expect(reloaded.terminalReport?.status).toBe("ready-for-review");
    expect(reloaded.terminalReport?.prUrl).toBe(
      "https://github.com/octocat/widget/pull/19",
    );
    expect(reloaded.terminalReport?.summary).toContain("ready for review");
    const phaseRecord = reloaded.phases.find((p) => p.name === "finalize");
    expect(phaseRecord).toBeDefined();
    expect(phaseRecord!.status).toBe("succeeded");
    expect(phaseRecord!.terminalReport?.status).toBe("ready-for-review");
    expect(phaseRecord!.transcriptPath).toMatch(/finalize\.jsonl$/);
  });

  test("on a missing Terminal Report: does NOT move Board to Ready for Review and does NOT delete the worktree", async () => {
    const stateDir = makeStateDir();
    const task = makeTask();
    const { store, run } = await makeRun(stateDir, task);

    const { factory } = recordingPiSession({
      events: [{ kind: "message", text: "agent forgot the terminal report" }],
    });
    const { updater, calls } = recordingStatusUpdater();
    const deleter = recordingDeleter();

    const phase = new FinalizePhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
      prTemplateLoader: fakeTemplateLoader(null),
      deleteWorktree: deleter.fn,
    });

    const outcome = await phase.run({
      task,
      run,
      workspace: STANDARD_WORKSPACE,
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toMatch(/terminal report/i);
    }
    // Board moved to Finalizing, but never to Ready for Review.
    expect(calls.map((c) => c.statusValue)).toEqual(["Finalizing"]);
    // Worktree must be preserved for debugging.
    expect(deleter.calls).toEqual([]);

    const reloaded = (await store.loadRun(run.id)) as Run;
    // The Run is not marked ready-for-review on bad output.
    expect(reloaded.status).not.toBe("ready-for-review");
    expect(reloaded.phases.find((p) => p.name === "finalize")?.status).toBe(
      "failed",
    );
  });

  test("on an invalid Terminal Report (missing prUrl): does NOT move Board to Ready for Review and does NOT delete the worktree", async () => {
    const stateDir = makeStateDir();
    const task = makeTask();
    const { store, run } = await makeRun(stateDir, task);

    const invalidBlock = [
      TERMINAL_REPORT_BEGIN,
      JSON.stringify({
        status: "ready-for-review",
        issue: { owner: "octocat", repo: "widget", number: 42 },
        summary: "no pr url here",
      }),
      TERMINAL_REPORT_END,
    ].join("\n");

    const { factory } = recordingPiSession({
      events: [{ kind: "message", text: invalidBlock }],
    });
    const { updater, calls } = recordingStatusUpdater();
    const deleter = recordingDeleter();

    const phase = new FinalizePhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
      prTemplateLoader: fakeTemplateLoader(null),
      deleteWorktree: deleter.fn,
    });

    const outcome = await phase.run({
      task,
      run,
      workspace: STANDARD_WORKSPACE,
    });

    expect(outcome.status).toBe("failed");
    expect(calls.map((c) => c.statusValue)).toEqual(["Finalizing"]);
    expect(deleter.calls).toEqual([]);
  });

  test("on a Pi session non-zero exit: phase fails and does not move Board to Ready for Review", async () => {
    const stateDir = makeStateDir();
    const task = makeTask();
    const { store, run } = await makeRun(stateDir, task);

    const { factory } = recordingPiSession({
      events: [{ kind: "message", text: VALID_REPORT_TEXT }],
      exitCode: 2,
    });
    const { updater, calls } = recordingStatusUpdater();
    const deleter = recordingDeleter();

    const phase = new FinalizePhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
      prTemplateLoader: fakeTemplateLoader(null),
      deleteWorktree: deleter.fn,
    });

    const outcome = await phase.run({
      task,
      run,
      workspace: STANDARD_WORKSPACE,
    });

    expect(outcome.status).toBe("failed");
    expect(calls.map((c) => c.statusValue)).toEqual(["Finalizing"]);
    expect(deleter.calls).toEqual([]);
    const reloaded = (await store.loadRun(run.id)) as Run;
    expect(reloaded.phases.find((p) => p.name === "finalize")?.status).toBe(
      "failed",
    );
  });

  test("on a Pi session that throws fatally: phase fails and does not move Board to Ready for Review", async () => {
    const stateDir = makeStateDir();
    const task = makeTask();
    const { store, run } = await makeRun(stateDir, task);

    const { factory } = recordingPiSession({
      throwOnRun: new Error("boom"),
    });
    const { updater, calls } = recordingStatusUpdater();
    const deleter = recordingDeleter();

    const phase = new FinalizePhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
      prTemplateLoader: fakeTemplateLoader(null),
      deleteWorktree: deleter.fn,
    });

    const outcome = await phase.run({
      task,
      run,
      workspace: STANDARD_WORKSPACE,
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("boom");
    }
    expect(calls.map((c) => c.statusValue)).toEqual(["Finalizing"]);
    expect(deleter.calls).toEqual([]);
  });

  test("if worktree deletion throws, the Run is still recorded ready-for-review (cleanup is best-effort)", async () => {
    const stateDir = makeStateDir();
    const task = makeTask();
    const { store, run } = await makeRun(stateDir, task);

    const { factory } = recordingPiSession({
      events: [{ kind: "message", text: VALID_REPORT_TEXT }],
    });
    const { updater, calls } = recordingStatusUpdater();
    const deleter = recordingDeleter({
      throwOn: STANDARD_WORKSPACE.worktreePath,
    });

    const phase = new FinalizePhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
      prTemplateLoader: fakeTemplateLoader(null),
      deleteWorktree: deleter.fn,
    });

    const outcome = await phase.run({
      task,
      run,
      workspace: STANDARD_WORKSPACE,
    });

    // Terminal Report is the source of truth: the Run handed off
    // successfully even if local cleanup hit a snag.
    expect(outcome.status).toBe("succeeded");
    expect(calls.map((c) => c.statusValue)).toEqual([
      "Finalizing",
      "Ready for Review",
    ]);
    expect(deleter.calls).toEqual([STANDARD_WORKSPACE.worktreePath]);
    const reloaded = (await store.loadRun(run.id)) as Run;
    expect(reloaded.status).toBe("ready-for-review");
  });

  test("records transcript events to the Run's finalize transcript file", async () => {
    const stateDir = makeStateDir();
    const task = makeTask();
    const { store, run } = await makeRun(stateDir, task);

    const { factory } = recordingPiSession({
      events: [
        { kind: "message", text: "preparing handoff" },
        { kind: "tool_use", name: "gh" },
        { kind: "message", text: VALID_REPORT_TEXT },
      ],
    });
    const { updater } = recordingStatusUpdater();

    const phase = new FinalizePhase({
      board: BOARD_CONFIG,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
      prTemplateLoader: fakeTemplateLoader(null),
      deleteWorktree: recordingDeleter().fn,
    });

    await phase.run({ task, run, workspace: STANDARD_WORKSPACE });

    const reloaded = (await store.loadRun(run.id)) as Run;
    const phaseRecord = reloaded.phases.find((p) => p.name === "finalize");
    expect(phaseRecord).toBeDefined();
    expect(phaseRecord!.transcriptPath).toMatch(/finalize\.jsonl$/);
  });

  test("uses the Board config's Finalizing/Ready for Review labels (not hardcoded strings)", async () => {
    const stateDir = makeStateDir();
    const task = makeTask();
    const { store, run } = await makeRun(stateDir, task);
    const { factory } = recordingPiSession();
    const { updater, calls } = recordingStatusUpdater();

    const customBoard: BoardConfig = {
      ...BOARD_CONFIG,
      statusValues: {
        ...BOARD_CONFIG.statusValues,
        finalizing: "Wrap-up",
        readyForReview: "Hand to Human",
      },
    };

    const phase = new FinalizePhase({
      board: customBoard,
      runStore: store,
      piSessionFactory: factory,
      boardStatusUpdater: updater,
      issueContextLoader: fakeIssueContextLoader(),
      prTemplateLoader: fakeTemplateLoader(null),
      deleteWorktree: recordingDeleter().fn,
    });

    await phase.run({ task, run, workspace: STANDARD_WORKSPACE });

    expect(calls.map((c) => c.statusValue)).toEqual([
      "Wrap-up",
      "Hand to Human",
    ]);
  });
});
