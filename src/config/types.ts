/**
 * Configuration types for the Pi Lot Conductor.
 *
 * The config file describes:
 * - The single GitHub Project Board to poll.
 * - Where Task Definitions (workflow files) live on disk.
 * - Where local source repositories live (projects directory).
 * - Where Pi Lot keeps its mutable state (state directory).
 * - How often to poll the Board.
 * - Optional concurrency override (MVP default is 5).
 *
 * Note: Board status values are sourced from workflow Task Definition
 * filenames at runtime, not from this config (PRD user stories 44-47).
 *
 * See PRD #1: Implementation Decisions.
 */

/**
 * Legacy Pi Lot phase status keys.
 *
 * Retained as an exported type so non-config modules that still reference
 * the historical phase key set keep compiling while the workflow-driven
 * status registry is wired in by parallel work for Issue #24.
 */
export type BoardStatusKey =
  | "queued"
  | "implementing"
  | "reviewing"
  | "finalizing"
  | "readyForReview"
  | "needsHuman";

/** Legacy status map type. See {@link BoardStatusKey}. */
export type BoardStatusMap = Record<BoardStatusKey, string>;

export interface BoardConfig {
  /** GitHub owner (user or organization) that owns the Project. */
  owner: string;
  /** GitHub Project number (the integer in the Project URL). */
  projectNumber: number;
  /** Name of the single-select field used to drive Pi Lot phases. */
  statusField: string;
}

export interface PiLotConfig {
  board: BoardConfig;
  /** Absolute or home-relative path to the flat projects directory. */
  projectsDir: string;
  /** Absolute or home-relative path to the Pi Lot mutable state directory. */
  stateDir: string;
  /**
   * Absolute path to the directory holding Task Definition `.md` files.
   * Defaults to `<cwd>/.workflow` when not set in the config.
   */
  workflowDir: string;
  /** Polling interval in milliseconds. */
  pollIntervalMs: number;
  /** Maximum number of active Runs in flight. MVP default 5. */
  concurrency: number;
}
