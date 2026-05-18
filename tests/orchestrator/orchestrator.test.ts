import { describe, expect, test } from "bun:test";
import { Orchestrator } from "../../src/orchestrator/orchestrator.ts";
import type { Candidate } from "../../src/board/index.ts";
import type { TaskDefinition, WorkflowGraph } from "../../src/workflow/index.ts";
import { buildWorkflowGraph } from "../../src/workflow/index.ts";
import { SqliteWorkflowStore } from "../../src/state/index.ts";
import type { PiLotConfig } from "../../src/config/index.ts";
import type { RunTaskInput } from "../../src/tasks/index.ts";

interface FakeGateway {
  pollEligibleCandidates(queueNames: readonly string[]): Promise<Candidate[]>;
  setNext(candidates: Candidate[]): void;
  calls: number;
}

function fakeGateway(initial: Candidate[] = []): FakeGateway {
  let next = initial;
  return {
    calls: 0,
    setNext(candidates) {
      next = candidates;
    },
    async pollEligibleCandidates() {
      this.calls += 1;
      return next;
    },
  };
}

interface FakeRunner {
  runTask(input: RunTaskInput): Promise<void>;
  dispatched: RunTaskInput[];
  pending: Map<string, () => void>;
}

function makeRunner(opts: {
  /** When true, runs do not resolve until `release` is called. */
  block?: boolean;
  /** Called inside runTask before resolving. */
  onRun?: (input: RunTaskInput) => Promise<void> | void;
} = {}): FakeRunner {
  const dispatched: RunTaskInput[] = [];
  const pending = new Map<string, () => void>();
  return {
    dispatched,
    pending,
    async runTask(input) {
      dispatched.push(input);
      if (opts.onRun) await opts.onRun(input);
      if (opts.block) {
        await new Promise<void>((resolve) => {
          pending.set(input.runId, resolve);
        });
      }
    },
  };
}

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  const issueNumber = overrides.issueNumber ?? 1;
  return {
    repository: { owner: "octocat", name: "widget" },
    issueNumber,
    title: `Issue ${issueNumber}`,
    url: `https://github.com/octocat/widget/issues/${issueNumber}`,
    status: "Implement",
    createdAt: "2026-01-01T00:00:00Z",
    projectItemId: `PVTI_${issueNumber}`,
    ...overrides,
  };
}

function makeGraph(): WorkflowGraph {
  const implementDef: TaskDefinition = {
    queue: "Implement",
    next: "Review",
    promptBody: "Implement",
    filename: "Implement.md",
  };
  const reviewDef: TaskDefinition = {
    queue: "Review",
    next: "Finalize",
    promptBody: "Review",
    filename: "Review.md",
  };
  const finalizeDef: TaskDefinition = {
    queue: "Finalize",
    next: "Ready for Review",
    promptBody: "Finalize",
    filename: "Finalize.md",
  };
  return buildWorkflowGraph({
    definitions: [implementDef, reviewDef, finalizeDef],
    knownBoardStatuses: ["Implement", "Review", "Finalize", "Ready for Review"],
  });
}

function makeConfig(overrides: Partial<PiLotConfig> = {}): PiLotConfig {
  return {
    board: { owner: "octocat", projectNumber: 7, statusField: "Status" },
    projectsDir: "/projects",
    stateDir: "/state",
    workflowDir: "/state/.workflow",
    pollIntervalMs: 30_000,
    concurrency: 5,
    ...overrides,
  };
}


describe("Orchestrator.tick", () => {
  test("schedules Finalize before Review before Implement (derived queue priority)", async () => {
    const graph = makeGraph();
    const store = new SqliteWorkflowStore({ path: ":memory:" });
    const gateway = fakeGateway([
      makeCandidate({ issueNumber: 1, status: "Implement", createdAt: "2026-01-01T00:00:00Z" }),
      makeCandidate({ issueNumber: 2, status: "Review", createdAt: "2026-01-02T00:00:00Z" }),
      makeCandidate({ issueNumber: 3, status: "Finalize", createdAt: "2026-01-03T00:00:00Z" }),
    ]);
    const runner = makeRunner();
    let seq = 0;
    const orchestrator = new Orchestrator({
      config: makeConfig(),
      workflowGraph: graph,
      gateway,
      store,
      runner,
      logger: { log: () => {}, error: () => {} },
      clock: () => `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
      runIdFactory: () => `run-${++seq}`,
    });

    await orchestrator.tick();

    expect(runner.dispatched.map((d) => d.taskDefinition.queue)).toEqual([
      "Finalize",
      "Review",
      "Implement",
    ]);
  });

  test("within a single queue, older Issues are dispatched first", async () => {
    const graph = makeGraph();
    const store = new SqliteWorkflowStore({ path: ":memory:" });
    const gateway = fakeGateway([
      makeCandidate({ issueNumber: 10, status: "Implement", createdAt: "2026-02-01T00:00:00Z" }),
      makeCandidate({ issueNumber: 11, status: "Implement", createdAt: "2026-01-01T00:00:00Z" }),
      makeCandidate({ issueNumber: 12, status: "Implement", createdAt: "2026-01-15T00:00:00Z" }),
    ]);
    const runner = makeRunner();
    let n = 0;
    const orchestrator = new Orchestrator({
      config: makeConfig(),
      workflowGraph: graph,
      gateway,
      store,
      runner,
      logger: { log: () => {}, error: () => {} },
      clock: () => `2026-03-01T00:00:00.000Z`,
      runIdFactory: () => `run-${++n}`,
    });

    await orchestrator.tick();

    expect(runner.dispatched.map((d) => d.candidate.issueNumber)).toEqual([11, 12, 10]);
  });

  test("honors config.concurrency: in-flight Runs cap dispatch per tick", async () => {
    const graph = makeGraph();
    const store = new SqliteWorkflowStore({ path: ":memory:" });
    const gateway = fakeGateway([
      makeCandidate({ issueNumber: 1, status: "Implement", createdAt: "2026-01-01T00:00:00Z" }),
      makeCandidate({ issueNumber: 2, status: "Implement", createdAt: "2026-01-02T00:00:00Z" }),
      makeCandidate({ issueNumber: 3, status: "Implement", createdAt: "2026-01-03T00:00:00Z" }),
    ]);
    const runner = makeRunner({ block: true });
    let n = 0;
    const orchestrator = new Orchestrator({
      config: makeConfig({ concurrency: 2 }),
      workflowGraph: graph,
      gateway,
      store,
      runner,
      logger: { log: () => {}, error: () => {} },
      clock: () => `2026-03-01T00:00:00.000Z`,
      runIdFactory: () => `run-${++n}`,
    });

    await orchestrator.tick();

    // Only 2 dispatched while the first two block.
    expect(runner.dispatched).toHaveLength(2);
    expect(runner.dispatched.map((d) => d.candidate.issueNumber)).toEqual([1, 2]);

    // Release one slot; another tick can pick up #3.
    runner.pending.get("run-1")!();
    // Let the runner promise resolve before next tick.
    await new Promise((r) => setTimeout(r, 0));

    await orchestrator.tick();
    expect(runner.dispatched).toHaveLength(3);
    expect(runner.dispatched[2]!.candidate.issueNumber).toBe(3);

    // Drain remaining blocked runs to avoid leaks.
    for (const release of runner.pending.values()) release();
  });

  test("skips a candidate whose (issue, taskDefinition) is already claimed in SQLite", async () => {
    const graph = makeGraph();
    const store = new SqliteWorkflowStore({ path: ":memory:" });
    // Pre-existing claim for issue #5 in Implement.
    store.claimTask({
      issueKey: "octocat/widget#5",
      taskDefinition: "Implement",
      runId: "external-run",
      ts: "2026-01-01T00:00:00.000Z",
    });
    const gateway = fakeGateway([
      makeCandidate({ issueNumber: 5, status: "Implement", createdAt: "2026-01-01T00:00:00Z" }),
      makeCandidate({ issueNumber: 6, status: "Implement", createdAt: "2026-01-02T00:00:00Z" }),
    ]);
    const runner = makeRunner();
    let n = 0;
    const orchestrator = new Orchestrator({
      config: makeConfig(),
      workflowGraph: graph,
      gateway,
      store,
      runner,
      logger: { log: () => {}, error: () => {} },
      clock: () => `2026-03-01T00:00:00.000Z`,
      runIdFactory: () => `run-${++n}`,
    });

    await orchestrator.tick();

    expect(runner.dispatched).toHaveLength(1);
    expect(runner.dispatched[0]!.candidate.issueNumber).toBe(6);
  });

  test("after a Run completes, the claim is freed and the next tick can pick up the same key", async () => {
    const graph = makeGraph();
    const store = new SqliteWorkflowStore({ path: ":memory:" });
    const gateway = fakeGateway([
      makeCandidate({ issueNumber: 7, status: "Implement", createdAt: "2026-01-01T00:00:00Z" }),
    ]);

    // Runner that releases the claim on completion (simulates TaskRunner success).
    const runner = {
      dispatched: [] as RunTaskInput[],
      async runTask(input: RunTaskInput) {
        this.dispatched.push(input);
        store.completeClaim({
          issueKey: `${input.candidate.repository.owner}/${input.candidate.repository.name}#${input.candidate.issueNumber}`,
          taskDefinition: input.taskDefinition.queue,
          ts: "2026-01-01T00:00:01.000Z",
        });
      },
    };
    let n = 0;
    const orchestrator = new Orchestrator({
      config: makeConfig(),
      workflowGraph: graph,
      gateway,
      store,
      runner,
      logger: { log: () => {}, error: () => {} },
      clock: () => `2026-01-01T00:00:00.000Z`,
      runIdFactory: () => `run-${++n}`,
    });

    await orchestrator.tick();
    expect(runner.dispatched).toHaveLength(1);
    expect(store.listActiveClaims()).toHaveLength(0);

    // Same candidate still visible from gateway → orchestrator can re-claim.
    await orchestrator.tick();
    expect(runner.dispatched).toHaveLength(2);
  });

  test("does NOT chain a follow-up Task in the same tick: only one dispatch per Issue per tick", async () => {
    const graph = makeGraph();
    const store = new SqliteWorkflowStore({ path: ":memory:" });
    // Gateway returns the same Issue in two queues at once (which shouldn't
    // normally happen in real GH, but proves the Orchestrator only acts on
    // candidates the gateway emitted this tick — no implicit chaining).
    const gateway = fakeGateway([
      makeCandidate({ issueNumber: 9, status: "Implement", createdAt: "2026-01-01T00:00:00Z" }),
    ]);

    const runner = {
      dispatched: [] as RunTaskInput[],
      async runTask(input: RunTaskInput) {
        this.dispatched.push(input);
        // Inside runTask, even if we (hypothetically) advanced the Board
        // and freed the claim, the Orchestrator must NOT pull a follow-up
        // until the next poll cycle.
        store.completeClaim({
          issueKey: `${input.candidate.repository.owner}/${input.candidate.repository.name}#${input.candidate.issueNumber}`,
          taskDefinition: input.taskDefinition.queue,
          ts: "2026-01-01T00:00:01.000Z",
        });
      },
    };
    let n = 0;
    const orchestrator = new Orchestrator({
      config: makeConfig(),
      workflowGraph: graph,
      gateway,
      store,
      runner,
      logger: { log: () => {}, error: () => {} },
      clock: () => `2026-01-01T00:00:00.000Z`,
      runIdFactory: () => `run-${++n}`,
    });

    await orchestrator.tick();
    expect(runner.dispatched).toHaveLength(1);
    expect(gateway.calls).toBe(1);
  });
});
