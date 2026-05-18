/**
 * Boundary type for invoking the local `gh` CLI.
 *
 * The Board gateway never spawns `gh` directly. Instead it receives a
 * `GhRunner` and calls it with the argument vector it wants to run. This
 * keeps the gateway pure (testable with mocks) and concentrates real
 * process spawning behind a single seam.
 */

export interface GhResult {
  /** Exit code reported by `gh`. */
  exitCode: number;
  /** Captured stdout (decoded as utf-8). */
  stdout: string;
  /** Captured stderr (decoded as utf-8). */
  stderr: string;
}

export type GhRunner = (args: readonly string[]) => Promise<GhResult>;

/**
 * Default runner: spawn `gh` via Bun's process API. Used in production.
 * Not exercised in the unit tests for the Board gateway — those inject a
 * fake runner so no real GitHub call is ever made.
 */
export const defaultGhRunner: GhRunner = async (args) => {
  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};
