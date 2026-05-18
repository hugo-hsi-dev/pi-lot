import { stat } from "node:fs/promises";
import { join } from "node:path";
import { RemoteMismatchError, RepositoryNotFoundError } from "./errors.ts";
import type { GitRunner } from "./git-runner.ts";
import { normalizeRemoteUrl } from "./remote-url.ts";

/**
 * Per-Task workspace provisioning result.
 *
 * The Conductor passes these facts to phase agents so they can operate
 * on the worktree without re-deriving paths or branch names.
 */
export interface ProvisionResult {
  /** Absolute path of the reused source repository. */
  repoPath: string;
  /** Absolute path of the isolated Task worktree. */
  worktreePath: string;
  /** Task Branch name (reused across Runs for the same Issue). */
  taskBranch: string;
  /** Repository default branch resolved at the start of the Run. */
  baseBranch: string;
}

export interface ProvisionInput {
  /** GitHub owner (user or org) that owns the Issue's repository. */
  owner: string;
  /** Repository name (matches the flat projects-directory entry). */
  repo: string;
  /** GitHub Issue number that anchors the Task. */
  issueNumber: number;
  /** Expected git remote URL for `origin`; used by the validation hook. */
  expectedRemote: string;
}

export interface WorkspaceProvisionerOptions {
  /** Flat projects directory where source repositories live. */
  projectsDir: string;
  /** Pi Lot state directory; worktrees live under here. */
  stateDir: string;
  /** Git subprocess abstraction (injected for tests). */
  git: GitRunner;
}

export interface ValidateRemoteInput {
  owner: string;
  repo: string;
  expectedRemote: string;
}

/** Result of the remote-validation hook. */
export type ValidateRemoteResult =
  | {
      ok: true;
      repoPath: string;
      actualRemote: string;
    }
  | {
      ok: false;
      reason: "not-found" | "remote-mismatch";
      repoPath: string;
      actualRemote?: string;
    };

/** Build the Task Branch name reused across Runs for a given Issue. */
export function taskBranchName(owner: string, repo: string, issueNumber: number): string {
  return `pi-lot/${owner}/${repo}/issue-${issueNumber}`;
}

/** Build the worktree path used by Pi Lot state for a given Issue. */
export function worktreePathFor(
  stateDir: string,
  owner: string,
  repo: string,
  issueNumber: number,
): string {
  return join(stateDir, owner, repo, String(issueNumber));
}

/**
 * WorkspaceProvisioner takes a Task identity (owner/repo/issue) and
 * prepares an isolated worktree on a fresh Task Branch rooted at the
 * repository's current default branch.
 *
 * Scope (issue #6):
 * - Reuses an existing matching repository in {@link projectsDir}.
 * - Exposes a remote-validation hook (`validateRemote`). Skip-on-mismatch
 *   policy is owned by issue #7.
 * - Resolves the repository default branch dynamically via the injected
 *   GitRunner.
 * - Reuses one Task Branch per Issue and resets it to the default-branch
 *   base at the start of each Run.
 * - Creates the worktree under `<stateDir>/<owner>/<repo>/<issueNumber>/`.
 *
 * Out of scope: cloning missing repositories (issue #7), cleanup policy
 * after Run termination (issue #14).
 */
export class WorkspaceProvisioner {
  private readonly projectsDir: string;
  private readonly stateDir: string;
  private readonly git: GitRunner;

  constructor(opts: WorkspaceProvisionerOptions) {
    this.projectsDir = opts.projectsDir;
    this.stateDir = opts.stateDir;
    this.git = opts.git;
  }

  /**
   * Inspect the flat projects-directory entry for an Issue's repository
   * and report whether it can be reused.
   *
   * Returns `{ ok: true }` when the repo exists locally and its `origin`
   * remote matches `expectedRemote` (URL forms collapsed via
   * {@link normalizeRemoteUrl}). Returns `{ ok: false, reason }` for the
   * two failure shapes the Conductor cares about: missing local clone
   * (handled in #7) or remote mismatch (skip Task policy in #7).
   *
   * This method performs no mutation, so the Conductor can call it
   * before deciding whether to clone, skip, or proceed.
   */
  public async validateRemote(input: ValidateRemoteInput): Promise<ValidateRemoteResult> {
    const repoPath = this.repoPathFor(input.repo);
    if (!(await this.repoExists(repoPath))) {
      return { ok: false, reason: "not-found", repoPath };
    }
    const actualRemote = await this.git.getRemoteUrl(repoPath);
    if (normalizeRemoteUrl(actualRemote) !== normalizeRemoteUrl(input.expectedRemote)) {
      return { ok: false, reason: "remote-mismatch", repoPath, actualRemote };
    }
    return { ok: true, repoPath, actualRemote };
  }

  public async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const validation = await this.validateRemote({
      owner: input.owner,
      repo: input.repo,
      expectedRemote: input.expectedRemote,
    });

    if (!validation.ok) {
      if (validation.reason === "not-found") {
        throw new RepositoryNotFoundError({
          owner: input.owner,
          repo: input.repo,
          expectedPath: validation.repoPath,
        });
      }
      throw new RemoteMismatchError({
        owner: input.owner,
        repo: input.repo,
        repoPath: validation.repoPath,
        expectedRemote: input.expectedRemote,
        actualRemote: validation.actualRemote ?? "(unknown)",
      });
    }

    const repoPath = validation.repoPath;
    const taskBranch = taskBranchName(input.owner, input.repo, input.issueNumber);
    const worktreePath = worktreePathFor(
      this.stateDir,
      input.owner,
      input.repo,
      input.issueNumber,
    );

    await this.git.fetchOrigin(repoPath);
    const baseBranch = await this.git.resolveDefaultBranch(repoPath);
    await this.git.resetTaskBranch({ repoPath, branch: taskBranch, base: baseBranch });

    if (await this.git.worktreeExists(repoPath, worktreePath)) {
      await this.git.removeWorktree(repoPath, worktreePath);
    }
    await this.git.addWorktree({ repoPath, worktreePath, branch: taskBranch });

    return { repoPath, worktreePath, taskBranch, baseBranch };
  }

  private repoPathFor(repo: string): string {
    return join(this.projectsDir, repo);
  }

  private async repoExists(repoPath: string): Promise<boolean> {
    try {
      const s = await stat(join(repoPath, ".git"));
      return s.isDirectory() || s.isFile();
    } catch {
      return false;
    }
  }
}
