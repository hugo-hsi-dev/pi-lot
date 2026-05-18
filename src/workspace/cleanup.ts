import { rm } from "node:fs/promises";

/**
 * Worktree retention policy for Pi Lot Tasks (PRD #1 user stories 33/34,
 * issue #11).
 *
 * The policy is intentionally split into two named operations rather than
 * a single boolean-driven helper so the Conductor's intent at the call
 * site is self-documenting: a Ready-for-Review Run "deletes its
 * worktree"; a Needs-Human Run "preserves its worktree".
 *
 * Tests inject a recording implementation. Production wires
 * {@link defaultWorktreeCleanup}.
 */
export interface WorktreeCleanup {
  /**
   * Delete a Task worktree directory after a successful (Ready for
   * Review) Run. Idempotent: deleting a path that does not exist is not
   * an error, so the Conductor can call this without first checking.
   */
  deleteWorktree(worktreePath: string): Promise<void>;

  /**
   * Mark a Task worktree as preserved after a Needs Human Run. The
   * default implementation is a no-op: leaving the directory in place is
   * the entire point. The method exists so that the Conductor's call
   * site documents which retention branch it took, and so tests can
   * observe that the preservation branch was reached.
   */
  preserveWorktree(worktreePath: string): Promise<void>;
}

/**
 * Default filesystem-backed cleanup. Uses `fs.rm` with `recursive: true`
 * and `force: true` so missing directories are treated as already-deleted.
 */
export function defaultWorktreeCleanup(): WorktreeCleanup {
  return {
    async deleteWorktree(worktreePath: string): Promise<void> {
      await rm(worktreePath, { recursive: true, force: true });
    },
    async preserveWorktree(): Promise<void> {
      // Intentional no-op: the worktree is preserved for human debugging.
    },
  };
}
