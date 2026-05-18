import type { PiLotConfig } from "../config/index.ts";
import { BoardGateway, BoardError } from "../board/index.ts";
import type { GhRunner, Task } from "../board/index.ts";
import { defaultGhRunner } from "../board/gh.ts";
import { Scheduler } from "./scheduler.ts";
import type { RunRunner } from "./scheduler.ts";

/**
 * Minimal logger surface used by the Conductor. The `warn` channel is
 * optional; when omitted, warnings fall back to `console.warn`.
 */
export interface ConductorLogger {
  log: (msg: string) => void;
  error: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface ConductorDeps {
  /** Logger sink. Defaults to the real console. */
  logger?: ConductorLogger;
  /** Injected `gh` runner. Defaults to spawning the real `gh` binary. */
  gh?: GhRunner;
  /**
   * Executes a single Task end-to-end. Production wires this to the Pi
   * phase runner once it exists (#8-#10); tests inject a fake. When
   * omitted, the Conductor uses a built-in placeholder runner that logs
   * the dispatch and returns immediately — enough for issue #4 to
   * exercise scheduling without performing real Phase work.
   */
  runner?: RunRunner;
}

/**
 * Conductor is the single supervisory process that, in the full MVP,
 * polls the Board, selects Queued Tasks, and runs Implement, Review,
 * and Finalize phases for each Task.
 *
 * In this slice (issue #3) the Conductor can call `pollOnce` to ask the
 * Board gateway for the current Queued Tasks. The scheduling / phase
 * orchestration that consumes those Tasks is tracked under separate
 * subissues of PRD #1, so `start()` still performs a safe no-op.
 */
export class Conductor {
  private readonly config: PiLotConfig;
  private readonly logger: ConductorLogger;
  private readonly board: BoardGateway;
  private readonly scheduler: Scheduler;

  constructor(config: PiLotConfig, deps: ConductorDeps | ConductorLogger = {}) {
    this.config = config;
    // Back-compat: the scaffold accepted a bare logger as the second arg.
    const opts: ConductorDeps = isConductorDeps(deps) ? deps : { logger: deps };
    this.logger = opts.logger ?? console;
    this.board = new BoardGateway(config.board, {
      gh: opts.gh ?? defaultGhRunner,
      warn: (line) => (this.logger.warn ?? console.warn)(line),
    });
    const runner: RunRunner = opts.runner ?? this.defaultRunner();
    this.scheduler = new Scheduler({
      concurrency: config.concurrency,
      runner,
    });
  }

  /**
   * Ask the Board for the current Queued Tasks. Errors are logged and
   * an empty list is returned so the caller (scheduler) can keep
   * polling on the next tick instead of crashing the worker.
   */
  public async pollOnce(): Promise<Task[]> {
    try {
      return await this.board.pollQueuedTasks();
    } catch (e) {
      if (e instanceof BoardError) {
        this.logger.error(
          `pi-lot: Board poll failed (${e.kind}): ${e.message}` +
            (e.detail ? `\n  ${e.detail}` : ""),
        );
        return [];
      }
      throw e;
    }
  }

  /**
   * Run a single polling cycle: ask the Board for current Queued Tasks
   * and let the Scheduler dispatch as many as the concurrency budget
   * allows, oldest-first, skipping Tasks already active in this process.
   *
   * `tick` returns once dispatching has happened. It does *not* wait for
   * the started Runs to finish — those continue in the background and
   * free up scheduler slots when they complete.
   */
  public async tick(): Promise<void> {
    const tasks = await this.pollOnce();
    this.scheduler.schedule(tasks);
  }

  /**
   * Resolve once every Run started by this Conductor has completed.
   * Used by tests and by graceful shutdown.
   */
  public async idle(): Promise<void> {
    await this.scheduler.idle();
  }

  /**
   * Start the Conductor. In this scaffold, `start` logs readiness and
   * returns immediately. Future subissues will replace the no-op body
   * with the polling loop and phase orchestration.
   */
  public async start(): Promise<void> {
    const { board, projectsDir, stateDir, pollIntervalMs, concurrency } = this.config;
    this.logger.log(
      `Pi Lot Conductor ready (board=${board.owner}#${board.projectNumber}, ` +
        `projectsDir=${projectsDir}, stateDir=${stateDir}, ` +
        `pollIntervalMs=${pollIntervalMs}, concurrency=${concurrency}).`,
    );
    this.logger.log(
      "No Board polling implementation present yet; exiting cleanly (no-op).",
    );
  }

  /**
   * Placeholder runner used when no `runner` is injected. The real Pi
   * phase runner is owned by later subissues (#8-#10); for now we just
   * log the dispatch so issue #4 can wire scheduling end-to-end without
   * blocking on phase work that does not exist yet.
   */
  private defaultRunner(): RunRunner {
    return async (task: Task) => {
      this.logger.log(
        `pi-lot: would start Run for ${task.repository.owner}/` +
          `${task.repository.name}#${task.issueNumber} (${task.title}). ` +
          "Phase runner not implemented yet.",
      );
    };
  }
}

/** Type guard separating the new deps bag from the legacy bare-logger arg. */
function isConductorDeps(
  v: ConductorDeps | ConductorLogger,
): v is ConductorDeps {
  if (typeof v !== "object" || v === null) return false;
  // Bare logger is shaped like { log, error } with functions.
  const looksLikeLogger =
    typeof (v as { log?: unknown }).log === "function" &&
    typeof (v as { error?: unknown }).error === "function" &&
    !("gh" in v) &&
    !("logger" in v) &&
    !("runner" in v);
  return !looksLikeLogger;
}
