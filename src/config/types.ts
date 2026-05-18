/**
 * Configuration types for the Pi Lot Conductor.
 *
 * The config file describes:
 * - The single GitHub Project Board to poll.
 * - Which Project status field/values map to Pi Lot phases.
 * - Where local source repositories live (projects directory).
 * - Where Pi Lot keeps its mutable state (state directory).
 * - How often to poll the Board.
 * - Optional concurrency override (MVP default is 5).
 *
 * See PRD #1: Implementation Decisions.
 */

export type BoardStatusKey =
  | "queued"
  | "implementing"
  | "reviewing"
  | "finalizing"
  | "readyForReview"
  | "needsHuman";

export type BoardStatusMap = Record<BoardStatusKey, string>;

export interface BoardConfig {
  /** GitHub owner (user or organization) that owns the Project. */
  owner: string;
  /** GitHub Project number (the integer in the Project URL). */
  projectNumber: number;
  /** Name of the single-select field used to drive Pi Lot phases. */
  statusField: string;
  /** Mapping of Pi Lot status keys to the option labels configured on the Board. */
  statusValues: BoardStatusMap;
}

export interface PiLotConfig {
  board: BoardConfig;
  /** Absolute or home-relative path to the flat projects directory. */
  projectsDir: string;
  /** Absolute or home-relative path to the Pi Lot mutable state directory. */
  stateDir: string;
  /** Polling interval in milliseconds. */
  pollIntervalMs: number;
  /** Maximum number of active Runs in flight. MVP default 5. */
  concurrency: number;
}
