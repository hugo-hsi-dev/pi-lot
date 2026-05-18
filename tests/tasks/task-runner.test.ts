import { describe, expect, test } from "bun:test";
import { TaskRunner } from "../../src/tasks/task-runner.ts";
import type {
  IssueContextLoader,
  PiSession,
  PiSessionFactory,
  PiSessionInput,
} from "../../src/tasks/types.ts";
import { SqliteWorkflowStore } from "../../src/state/index.ts";
import { buildWorkflowGraph } from "../../src/workflow/index.ts";
import type { TaskDefinition } from "../../src/workflow/index.ts";
import type { Candidate } from "../../src/board/index.ts";

interface FakeTransitionCall {
  projectItemId: string;
  toStatus: string;
}

function makeTransitionService(): {
  applyTransition: (input: FakeTransitionCall) => Promise<void>;
  calls: FakeTransitionCall[];
} {
  const calls: FakeTransitionCall[] = [];
  return {
    calls,
    applyTransition: async (input) => {
      calls.push({ ...input });
    },
  };
}

function makeProvisioner(opts: {
  worktreePath?: string;
  taskBranch?: string;
  baseBranch?: string;
  repoPath?: string;
} = {}): {
  provision: (input: {
    owner: string;
    repo: string;
    issueNumber: number;
    expectedRemote: string;
  }) => Promise<{
    kind: "provisioned";
    repoPath: string;
    worktreePath: string;
    taskBranch: string;
    baseBranch: string;
  }>;
  calls: Array<{ owner: string; repo: string; issueNumber: number; expectedRemote: string }>;
} {
  const calls: Array<{ owner: string; repo: string; issueNumber: number; expectedRemote: string }> = [];
  return {
    calls,
    provision: async (input) => {
      calls.push({ ...input });
      return {
        kind: "provisioned",
        repoPath: opts.repoPath ?? `/repos/${input.owner}/${input.repo}`,
        worktreePath:
          opts.worktreePath ?? `/state/${input.owner}/${input.repo}/${input.issueNumber}`,
        taskBranch: opts.taskBranch ?? `pi-lot/${input.owner}/${input.repo}/issue-${input.issueNumber}`,
        baseBranch: opts.baseBranch ?? "main",
      };
    },
  };
}

function fakeIssueContextLoader(
  ctx: { body?: string; labels?: string[] } = {},
): IssueContextLoader {
  return async () => ({
    body: ctx.body ?? "Issue body explaining the request.",
    labels: ctx.labels ?? [],
  });
}

interface RecordedSession {
  input: PiSessionInput;
  emittedEvents: Array<Record<string, unknown>>;
}

function recordingPiFactory(opts: {
  exitCode?: number;
  events?: Array<Record<string, unknown>>;
  throwOnRun?: Error;
} = {}): {
  factory: PiSessionFactory;
  sessions: RecordedSession[];
} {
  const sessions: RecordedSession[] = [];
  const factory: PiSessionFactory = (input) => {
    const record: RecordedSession = { input, emittedEvents: [] };
    sessions.push(record);
    const events = opts.events ?? [{ kind: "message", text: "ok" }];
    const exitCode = opts.exitCode ?? 0;
    const session: PiSession = {
      async run(handler) {
        if (opts.throwOnRun) throw opts.throwOnRun;
        for (const e of events) {
          record.emittedEvents.push(e);
          await handler(e);
        }
        return { exitCode };
      },
    };
    return session;
  };
  return { factory, sessions };
}

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    repository: { owner: "octocat", name: "widget" },
    issueNumber: 42,
    title: "Add a frobnicator",
    url: "https://github.com/octocat/widget/issues/42",
    status: "Implement",
    createdAt: "2026-01-01T00:00:00Z",
    projectItemId: "PVTI_42",
    ...overrides,
  };
}

function makeGraph(opts: { knownStatuses?: string[] } = {}) {
  const implementDef: TaskDefinition = {
    queue: "Implement",
    next: "Review",
    promptBody: [
      "# Implement {{ISSUE_TITLE}}",
      "",
      "Worktree {{WORKTREE_PATH}} on branch {{TASK_BRANCH}} (base {{BASE_BRANCH}}).",
      "Repo: {{REPO_OWNER}}/{{REPO_NAME}}",
      "Issue #{{ISSUE_NUMBER}} {{ISSUE_URL}}",
      "Body: {{ISSUE_BODY}}",
      "Run: {{RUN_ID}}",
      "Task: {{TASK_DEFINITION_NAME}}",
    ].join("\n"),
    filename: "Implement.md",
  };
  const reviewDef: TaskDefinition = {
    queue: "Review",
    next: "Finalize",
    promptBody: "# Review {{ISSUE_TITLE}}",
    filename: "Review.md",
  };
  const finalizeDef: TaskDefinition = {
    queue: "Finalize",
    next: "Ready for Review",
    promptBody: "# Finalize {{ISSUE_TITLE}}",
    filename: "Finalize.md",
  };

  const definitions = [implementDef, reviewDef, finalizeDef];
  const knownStatuses = opts.knownStatuses ?? [
    "Implement",
    "Review",
    "Finalize",
    "Ready for Review",
  ];
  const graph = buildWorkflowGraph({
    definitions,
    knownBoardStatuses: knownStatuses,
  });
  return { graph, implementDef, reviewDef, finalizeDef };
}

function expectedRemoteForCandidate(c: { repository: { owner: string; name: string } }): string {
  return `https://github.com/${c.repository.owner}/${c.repository.name}.git`;
}

describe("TaskRunner.runTask", () => {
  test("happy path: provisions, renders prompt, runs Pi, records Run + transcript, transitions Board", async () => {
    const store = new SqliteWorkflowStore({ path: ":memory:" });
    const { graph, implementDef } = makeGraph();
    const provisioner = makeProvisioner();
    const piEvents = [
      { kind: "message", text: "starting" },
      { kind: "tool_call", name: "Read", path: "src/index.ts" },
    ];
    const { factory, sessions } = recordingPiFactory({ exitCode: 0, events: piEvents });
    const transition = makeTransitionService();
    const issueLoader = fakeIssueContextLoader({
      body: "Please add the widget.",
      labels: ["bug"],
    });
    const logs: string[] = [];

    const runner = new TaskRunner({
      workflowGraph: graph,
      workspaceProvisioner: provisioner,
      issueContextLoader: issueLoader,
      piSessionFactory: factory,
      transitionService: transition,
      store,
      expectedRemoteFor: expectedRemoteForCandidate,
      env: {},
      logger: { log: (m) => logs.push(m), error: (m) => logs.push(`ERR:${m}`) },
    });

    const candidate = makeCandidate();
    await runner.runTask({
      candidate,
      runId: "run-1",
      taskDefinition: implementDef,
      projectItemId: "PVTI_1",
    });

    // Provisioned with right inputs.
    expect(provisioner.calls).toHaveLength(1);
    expect(provisioner.calls[0]).toEqual({
      owner: "octocat",
      repo: "widget",
      issueNumber: 42,
      expectedRemote: "https://github.com/octocat/widget.git",
    });

    // One Pi session, prompt rendered.
    expect(sessions).toHaveLength(1);
    const renderedPrompt = sessions[0]!.input.prompt;
    expect(renderedPrompt).toContain("# Implement Add a frobnicator");
    expect(renderedPrompt).toContain("Worktree /state/octocat/widget/42 on branch pi-lot/octocat/widget/issue-42 (base main).");
    expect(renderedPrompt).toContain("Repo: octocat/widget");
    expect(renderedPrompt).toContain("Issue #42 https://github.com/octocat/widget/issues/42");
    expect(renderedPrompt).toContain("Body: Please add the widget.");
    expect(renderedPrompt).toContain("Run: run-1");
    expect(renderedPrompt).toContain("Task: Implement");
    expect(sessions[0]!.input.taskDefinitionName).toBe("Implement");
    expect(sessions[0]!.input.cwd).toBe("/state/octocat/widget/42");

    // Run record saved.
    const run = store.getRun("run-1");
    expect(run).not.toBeNull();
    expect(run!.runId).toBe("run-1");
    expect(run!.issueKey).toBe("octocat/widget#42");
    expect(run!.taskDefinition).toBe("Implement");
    expect(run!.status).toBe("succeeded");

    // Transcript events streamed into store.
    const transcripts = store.listTranscriptEvents("run-1");
    expect(transcripts.map((t) => t.payload)).toEqual(piEvents);

    // Workflow events include run_started + run_completed (no run_failed).
    const events = store.listEvents();
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("run_started");
    expect(kinds).toContain("run_completed");
    expect(kinds).not.toContain("run_failed");

    // Board transitioned to next status.
    expect(transition.calls).toEqual([{ projectItemId: "PVTI_1", toStatus: "Review" }]);
  });

  test("Pi failure (non-zero exit) appends run_failed and does not transition the Board", async () => {
    const store = new SqliteWorkflowStore({ path: ":memory:" });
    const { graph, implementDef } = makeGraph();
    const provisioner = makeProvisioner();
    const { factory } = recordingPiFactory({ exitCode: 1, events: [{ kind: "message", text: "oops" }] });
    const transition = makeTransitionService();
    const logs: string[] = [];

    const runner = new TaskRunner({
      workflowGraph: graph,
      workspaceProvisioner: provisioner,
      issueContextLoader: fakeIssueContextLoader(),
      piSessionFactory: factory,
      transitionService: transition,
      store,
      expectedRemoteFor: expectedRemoteForCandidate,
      env: {},
      logger: { log: (m) => logs.push(m), error: (m) => logs.push(`ERR:${m}`) },
    });

    await runner.runTask({
      candidate: makeCandidate(),
      runId: "run-2",
      taskDefinition: implementDef,
      projectItemId: "PVTI_1",
    });

    // Run marked failed.
    const run = store.getRun("run-2");
    expect(run!.status).toBe("failed");

    // No transition.
    expect(transition.calls).toHaveLength(0);

    // run_failed appended.
    const kinds = store.listEvents().map((e) => e.kind);
    expect(kinds).toContain("run_failed");
    expect(kinds).not.toContain("run_completed");
  });

  test("terminal next: logs terminal notification and still moves Board to terminal status", async () => {
    const store = new SqliteWorkflowStore({ path: ":memory:" });
    const { graph, finalizeDef } = makeGraph();
    const provisioner = makeProvisioner();
    const { factory } = recordingPiFactory({ exitCode: 0 });
    const transition = makeTransitionService();
    const logs: string[] = [];

    const runner = new TaskRunner({
      workflowGraph: graph,
      workspaceProvisioner: provisioner,
      issueContextLoader: fakeIssueContextLoader(),
      piSessionFactory: factory,
      transitionService: transition,
      store,
      expectedRemoteFor: expectedRemoteForCandidate,
      env: {},
      logger: { log: (m) => logs.push(m), error: (m) => logs.push(`ERR:${m}`) },
    });

    await runner.runTask({
      candidate: makeCandidate({ status: "Finalize" }),
      runId: "run-3",
      taskDefinition: finalizeDef,
      projectItemId: "PVTI_2",
    });

    expect(transition.calls).toEqual([
      { projectItemId: "PVTI_2", toStatus: "Ready for Review" },
    ]);
    // Terminal notification logged.
    expect(logs.some((m) => m.toLowerCase().includes("terminal") && m.includes("Ready for Review"))).toBe(true);
  });

  test("active claim is removed once the Run completes successfully", async () => {
    const store = new SqliteWorkflowStore({ path: ":memory:" });
    const { graph, implementDef } = makeGraph();
    const provisioner = makeProvisioner();
    const { factory } = recordingPiFactory({ exitCode: 0 });
    const transition = makeTransitionService();

    // Pre-claim outside the TaskRunner (Orchestrator owns claim acquisition).
    store.claimTask({
      issueKey: "octocat/widget#42",
      taskDefinition: "Implement",
      runId: "run-claim",
      ts: "2026-01-01T00:00:00.000Z",
    });
    expect(store.listActiveClaims()).toHaveLength(1);

    const runner = new TaskRunner({
      workflowGraph: graph,
      workspaceProvisioner: provisioner,
      issueContextLoader: fakeIssueContextLoader(),
      piSessionFactory: factory,
      transitionService: transition,
      store,
      expectedRemoteFor: expectedRemoteForCandidate,
      env: {},
      logger: { log: () => {}, error: () => {} },
    });

    await runner.runTask({
      candidate: makeCandidate(),
      runId: "run-claim",
      taskDefinition: implementDef,
      projectItemId: "PVTI_1",
    });

    expect(store.listActiveClaims()).toHaveLength(0);
  });
});
