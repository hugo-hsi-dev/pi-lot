import type { PiLotConfig } from "../config/index.ts";
import { BoardGateway, BoardError } from "../board/index.ts";
import type { GhRunner, Task } from "../board/index.ts";
import { defaultGhRunner } from "../board/gh.ts";

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

  constructor(config: PiLotConfig, deps: ConductorDeps | ConductorLogger = {}) {
    this.config = config;
    // Back-compat: the scaffold accepted a bare logger as the second arg.
    const opts: ConductorDeps = isConductorDeps(deps) ? deps : { logger: deps };
    this.logger = opts.logger ?? console;
    this.board = new BoardGateway(config.board, {
      gh: opts.gh ?? defaultGhRunner,
      warn: (line) => (this.logger.warn ?? console.warn)(line),
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
    !("logger" in v);
  return !looksLikeLogger;
}
