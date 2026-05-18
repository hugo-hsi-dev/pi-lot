/**
 * GitRunner is the system boundary for git subprocess invocations
 * the workspace provisioner depends on.
 *
 * Methods are SDK-style (one method per operation) rather than a
 * generic "run any git command" so tests can supply small focused
 * fakes without re-implementing git semantics or matching argv strings.
 *
 * Real git execution lives in {@link SubprocessGitRunner} (see
 * subprocess-git-runner.ts). Tests inject FakeGitRunner.
 */

export interface ResetTaskBranchInput {
  /** Absolute path of the source repository (not the worktree). */
  repoPath: string;
  /** Task Branch name, reused across Runs for the same Issue. */
  branch: string;
  /** Base branch to reset the Task Branch to (e.g. "main"). */
  base: string;
}

export interface AddWorktreeInput {
  /** Absolute path of the source repository. */
  repoPath: string;
  /** Absolute path where the worktree should be created. */
  worktreePath: string;
  /** Task Branch to check out in the new worktree. */
  branch: string;
}

export interface CloneInput {
  /** Absolute path where the new clone should be created. */
  repoPath: string;
  /** Git remote URL to clone from (the Issue's repository). */
  remoteUrl: string;
}

export interface GitRunner {
  /**
   * Clone `remoteUrl` into `repoPath` so a missing flat projects-directory
   * entry becomes a usable source repository for the rest of the
   * provisioning sequence.
   */
  clone(input: CloneInput): Promise<void>;

  /** Return the URL configured for the given remote (default `origin`). */
  getRemoteUrl(repoPath: string, remote?: string): Promise<string>;

  /**
   * Fetch updates from `origin` so default-branch resolution and base
   * reset operate on current upstream refs.
   */
  fetchOrigin(repoPath: string): Promise<void>;

  /**
   * Resolve the repository default branch dynamically, e.g. via
   * `git symbolic-ref refs/remotes/origin/HEAD`. Must never return
   * a hardcoded value like "main".
   */
  resolveDefaultBranch(repoPath: string): Promise<string>;

  /**
   * Reset (or create) the Task Branch to point at the given base.
   * Equivalent semantics: `git branch -f <branch> origin/<base>`.
   */
  resetTaskBranch(input: ResetTaskBranchInput): Promise<void>;

  /** Return true if a worktree is already registered at `worktreePath`. */
  worktreeExists(repoPath: string, worktreePath: string): Promise<boolean>;

  /** Remove a worktree registration (used before re-creating one). */
  removeWorktree(repoPath: string, worktreePath: string): Promise<void>;

  /** Create a new worktree at the given path checked out at `branch`. */
  addWorktree(input: AddWorktreeInput): Promise<void>;
}
