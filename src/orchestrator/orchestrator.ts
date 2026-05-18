import type { Candidate } from "../board/index.ts";
import type { PiLotConfig } from "../config/index.ts";
import { DuplicateClaimError } from "../state/index.ts";
import type { SqliteWorkflowStore } from "../state/index.ts";
import type { RunTaskInput } from "../tasks/index.ts";
import type { TaskDefinition, WorkflowGraph } from "../workflow/index.ts";

/** Minimal logger surface used by the Orchestrator. */
export interface OrchestratorLogger {
  log: (msg: string) => void;
  error: (msg: string) => void;
  warn?: (msg: string) => void;
}

/**
 * Subset of the Board gateway used by the Orchestrator. Kept structural
 * so tests can inject a tiny fake.
 */
export interface OrchestratorGateway {
  pollEligibleCandidates(
    queueNames: readonly string[],
  ): Promise<Candidate[]>;
}

/**
 * Subset of the Task Runner used by the Orchestrator. Kept structural
 * so tests can stand a recording fake in for the production runner.
 */
export interface OrchestratorRunner {
  runTask(input: RunTaskInput): Promise<void>;
}

export interface OrchestratorDeps {
  config: PiLotConfig;
  workflowGraph: WorkflowGraph;
  gateway: OrchestratorGateway;
  store: SqliteWorkflowStore;
  runner: OrchestratorRunner;
  logger: OrchestratorLogger;
  /** Returns ISO-8601 timestamps. Defaults to `new Date().toISOString()`. */
  clock?: () => string;
  /** Returns a fresh, unique Run id. */
  runIdFactory: () => string;
}

export interface OrchestratorStartOptions {
  signal?: AbortSignal;
}

/**
 * The Orchestrator owns:
 *  - the poll loop that asks the Board for candidates in configured queues,
 *  - the ordering rules (queue priority descending toward terminal,
 *    then Issue createdAt ascending),
 *  - the SQLite-backed claim acquisition for each `(issueKey, taskDef)` pair,
 *  - dispatch into the Task Runner up to `config.concurrency` in-flight Runs.
 *
 * After a Task Definition completes the Orchestrator does NOT chain a
 * follow-up Task in the same tick. The Board is the visible workflow
 * source; the next Task arrives via the next poll cycle once the Board
 * Item has moved to the next column.
 */
export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly inflight = new Set<Promise<void>>();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  /** Number of Runs currently in flight. Exposed for tests/diagnostics. */
  public get inflightCount(): number {
    return this.inflight.size;
  }

  /**
   * Poll the Board for candidates in every configured Task Queue. Errors
   * bubble up; callers (the start loop) decide whether to retry.
   */
  public async pollOnce(): Promise<Candidate[]> {
    const queueNames = [...this.deps.workflowGraph.definitions.keys()];
    return this.deps.gateway.pollEligibleCandidates(queueNames);
  }

  /**
   * One scheduling cycle: poll, order, claim, dispatch (up to
   * `concurrency`). Returns once dispatches are issued. Does NOT wait
   * for in-flight Runs to settle.
   */
  public async tick(): Promise<void> {
    const candidates = await this.pollOnce();
    const ordered = this.orderCandidates(candidates);

    for (const candidate of ordered) {
      if (this.inflight.size >= this.deps.config.concurrency) break;
      const def = this.deps.workflowGraph.definitions.get(candidate.status);
      if (!def) continue; // Should not happen: gateway only returns configured queues.

      const claimed = this.tryClaim(candidate, def);
      if (!claimed) continue;

      this.dispatch(candidate, def, claimed.runId);
    }
  }

  /**
   * Start the poll loop. Resolves when `signal` aborts (clean shutdown).
   * Errors thrown by `tick` are logged; the loop keeps going so a
   * transient GitHub blip does not crash the worker.
   */
  public async start(opts: OrchestratorStartOptions = {}): Promise<void> {
    const { signal } = opts;
    if (signal?.aborted) return;

    while (!signal?.aborted) {
      try {
        await this.tick();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.deps.logger.error(`Orchestrator: tick failed: ${msg}`);
      }
      if (signal?.aborted) return;
      await this.sleep(this.deps.config.pollIntervalMs, signal);
    }
  }

  /** Wait until every in-flight Run has settled. Used by tests + shutdown. */
  public async idle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.race(this.inflight);
    }
  }

  private orderCandidates(candidates: Candidate[]): Candidate[] {
    return [...candidates].sort((a, b) => {
      const pa = this.deps.workflowGraph.priorityOf(a.status);
      const pb = this.deps.workflowGraph.priorityOf(b.status);
      if (pa !== pb) return pa - pb; // smaller priority = closer to terminal = runs first
      const ca = a.createdAt;
      const cb = b.createdAt;
      if (ca < cb) return -1;
      if (ca > cb) return 1;
      return a.issueNumber - b.issueNumber;
    });
  }

  private tryClaim(
    candidate: Candidate,
    def: TaskDefinition,
  ): { runId: string } | undefined {
    const runId = this.deps.runIdFactory();
    const ts = (this.deps.clock ?? defaultClock)();
    const issueKey = candidateIssueKey(candidate);
    try {
      this.deps.store.claimTask({
        issueKey,
        taskDefinition: def.queue,
        runId,
        ts,
      });
      return { runId };
    } catch (e) {
      if (e instanceof DuplicateClaimError) return undefined;
      throw e;
    }
  }

  private dispatch(
    candidate: Candidate,
    def: TaskDefinition,
    runId: string,
  ): void {
    const input: RunTaskInput = {
      candidate,
      runId,
      taskDefinition: def,
      projectItemId: candidate.projectItemId,
    };
    const promise = (async () => {
      try {
        await this.deps.runner.runTask(input);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.deps.logger.error(
          `Orchestrator: Task Runner threw for ${candidateIssueKey(candidate)} / ${def.queue}: ${msg}`,
        );
      }
    })();
    this.inflight.add(promise);
    promise.finally(() => {
      this.inflight.delete(promise);
    });
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        resolve();
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function candidateIssueKey(c: Candidate): string {
  return `${c.repository.owner}/${c.repository.name}#${c.issueNumber}`;
}

function defaultClock(): string {
  return new Date().toISOString();
}
