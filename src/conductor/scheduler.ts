import type { Task } from "../board/index.ts";

/**
 * Boundary type for executing a single Run end-to-end.
 *
 * The Scheduler does not know how a Run is actually carried out — it
 * only knows that a Run, once dispatched, eventually completes when the
 * returned Promise settles. Production wires this to the Pi phase
 * runner; tests inject a fake to observe scheduling decisions without
 * touching git, GitHub, or a model.
 */
export type RunRunner = (task: Task) => Promise<void>;

export interface SchedulerOptions {
  /** Maximum number of active Runs in flight at once. PRD #1: MVP default 5. */
  concurrency: number;
  /** Executes a single Task end-to-end. */
  runner: RunRunner;
}

/**
 * Owns oldest-first Task scheduling and the concurrency limit for the
 * Conductor process. See PRD #1 user stories 6 and 7, and issue #4.
 *
 * The Scheduler keeps an in-memory set of Tasks that are currently
 * active in *this* process. Tasks already active are never re-dispatched
 * even if the Board reports them as Queued during the same tick. Stale
 * active Run Records from a prior process are ignored for MVP and play
 * no part in this decision.
 */
export class Scheduler {
  private readonly concurrency: number;
  private readonly runner: RunRunner;
  private readonly active = new Map<string, Promise<void>>();

  constructor(opts: SchedulerOptions) {
    this.concurrency = opts.concurrency;
    this.runner = opts.runner;
  }

  /**
   * Given a snapshot of currently Queued Tasks, start as many new Runs
   * as the concurrency budget and dedup rules allow, oldest-first.
   *
   * - Tasks already active in this process are skipped.
   * - At most `concurrency` Runs are active concurrently.
   * - Tasks are considered in ascending `createdAt`, with `issueNumber`
   *   as a stable tiebreaker.
   */
  public schedule(tasks: readonly Task[]): void {
    const ordered = [...tasks].sort(compareTasks);
    for (const t of ordered) {
      if (this.active.size >= this.concurrency) break;
      const key = taskKey(t);
      if (this.active.has(key)) continue;
      this.start(key, t);
    }
  }

  /**
   * Resolve once every currently active Run has completed. Intended for
   * tests and for graceful shutdown; the polling loop itself does not
   * await this.
   */
  public async idle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all(this.active.values());
    }
  }

  private start(key: string, task: Task): void {
    let p: Promise<void>;
    try {
      p = this.runner(task);
    } catch (e) {
      p = Promise.reject(e);
    }
    const tracked = p.finally(() => {
      this.active.delete(key);
    });
    // Swallow runner failures here so an unhandled rejection cannot
    // crash the worker; callers observing the Scheduler instead of
    // individual Run promises rely on this.
    tracked.catch(() => {});
    this.active.set(key, tracked);
  }
}

function taskKey(t: Task): string {
  return `${t.repository.owner}/${t.repository.name}#${t.issueNumber}`;
}

function compareTasks(a: Task, b: Task): number {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  return a.issueNumber - b.issueNumber;
}
