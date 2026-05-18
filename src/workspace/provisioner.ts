import { join } from "node:path";
import type { GitRunner } from "./git-runner.ts";

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

  public async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const repoPath = join(this.projectsDir, input.repo);
    const taskBranch = taskBranchName(input.owner, input.repo, input.issueNumber);
    const worktreePath = worktreePathFor(
      this.stateDir,
      input.owner,
      input.repo,
      input.issueNumber,
    );

    const baseBranch = await this.git.resolveDefaultBranch(repoPath);
    await this.git.resetTaskBranch({ repoPath, branch: taskBranch, base: baseBranch });

    if (await this.git.worktreeExists(repoPath, worktreePath)) {
      await this.git.removeWorktree(repoPath, worktreePath);
    }
    await this.git.addWorktree({ repoPath, worktreePath, branch: taskBranch });

    return { repoPath, worktreePath, taskBranch, baseBranch };
  }
}
