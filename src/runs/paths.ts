import { join } from "node:path";
import type { TaskRef } from "./types.ts";

/**
 * Path helpers for the on-disk Run Record store.
 *
 * Layout under `stateDir`:
 *
 *   <stateDir>/
 *     runs/
 *       <owner>__<repo>__<issueNumber>__<runId>.json
 *     transcripts/
 *       <runId>/
 *         implement.jsonl
 *         review.jsonl
 *         finalize.jsonl
 *
 * `<owner>__<repo>__<issueNumber>__<runId>` keeps Task identity in the
 * filename so a human glancing at `<stateDir>/runs/` can immediately see
 * which Issue a Run belongs to without opening the JSON.
 *
 * We use `__` as the separator because GitHub repository names cannot
 * contain that sequence, so the encoding is unambiguous.
 */

/** Directory holding all persisted Run Record JSON files. */
export function runsDir(stateDir: string): string {
  return join(stateDir, "runs");
}

/** Directory holding per-run Phase transcript JSONL files. */
export function transcriptsDir(stateDir: string): string {
  return join(stateDir, "transcripts");
}

/** Per-run transcript directory: `<stateDir>/transcripts/<runId>/`. */
export function runTranscriptDir(stateDir: string, runId: string): string {
  return join(transcriptsDir(stateDir), runId);
}

/** Absolute path to a Phase's transcript JSONL file. */
export function phaseTranscriptPath(
  stateDir: string,
  runId: string,
  phaseName: string,
): string {
  return join(runTranscriptDir(stateDir, runId), `${phaseName}.jsonl`);
}

/** Absolute path to a Run Record JSON file. */
export function runRecordPath(
  stateDir: string,
  taskRef: TaskRef,
  runId: string,
): string {
  const { owner, repo, issueNumber } = taskRef;
  return join(
    runsDir(stateDir),
    `${owner}__${repo}__${issueNumber}__${runId}.json`,
  );
}
