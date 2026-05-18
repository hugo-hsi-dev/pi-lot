import type { PiLotConfig } from "../config/index.ts";

/**
 * Conductor is the single supervisory process that, in the full MVP,
 * polls the Board, selects Queued Tasks, and runs Implement, Review,
 * and Finalize phases for each Task.
 *
 * In this scaffold (issue #2) the Conductor performs a safe no-op:
 * it accepts the validated config, logs that it is ready, and exits.
 * Board polling, repository provisioning, and Pi phase execution are
 * tracked under separate subissues of PRD #1.
 */
export class Conductor {
  private readonly config: PiLotConfig;
  private readonly logger: Pick<Console, "log" | "error">;

  constructor(config: PiLotConfig, logger: Pick<Console, "log" | "error"> = console) {
    this.config = config;
    this.logger = logger;
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
