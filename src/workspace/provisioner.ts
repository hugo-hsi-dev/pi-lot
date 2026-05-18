import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitRunner } from "./git-runner.ts";
import { normalizeRemoteUrl } from "./remote-url.ts";

/**
 * Per-Task workspace provisioning result.
 *
 * The Conductor passes these facts to phase agents so they can operate
 * on the worktree without re-deriving paths or branch names.
 */
export interface ProvisionedWorkspace {
  kind: "provisioned";
  /** Absolute path of the source repository. */
  repoPath: string;
  /** Absolute path of the isolated Task worktree. */
  worktreePath: string;
  /** Task Branch name (reused across Runs for the same Issue). */
  taskBranch: string;
  /** Repository default branch resolved at the start of the Run. */
  baseBranch: string;
}

/**
 * Outcome when the projects-directory entry already exists but points
 * at a different remote. The Conductor must not run a Task in the
 * wrong repository, so it skips with a local warning.
 */
export interface SkippedWorkspace {
  kind: "skipped";
  /** Why provisioning was skipped. Currently only one reason exists. */
  reason: "remote-mismatch";
  /** Absolute path of the colliding flat-layout entry. */
  repoPath: string;
  /** Remote URL the Issue expected. */
  expectedRemote: string;
  /** Remote URL actually configured at the local path. */
  actualRemote: string;
}

export type ProvisionOutcome = ProvisionedWorkspace | SkippedWorkspace;

/**
 * Back-compat alias for the original "happy path only" shape.
 * @deprecated Prefer narrowing on {@link ProvisionOutcome.kind}.
 */
export type ProvisionResult = ProvisionedWorkspace;

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
  /**
   * Optional local-warning sink. Used for non-fatal skip events such as
   * a name collision against a different remote. Defaults to
   * `console.warn`.
   */
  warn?: (message: string) => void;
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
 * Scope:
 * - Reuses an existing matching repository in {@link projectsDir} (#6).
 * - Clones the repository into the flat projects-directory layout when
 *   missing (#7).
 * - Returns a `skipped` outcome with a local warning when the flat
 *   layout entry exists but points at a different remote (#7).
 * - Resolves the repository default branch dynamically via the injected
 *   GitRunner.
 * - Reuses one Task Branch per Issue and resets it to the default-branch
 *   base at the start of each Run.
 * - Creates the worktree under `<stateDir>/<owner>/<repo>/<issueNumber>/`.
 *
 * Out of scope: cleanup policy after Run termination (issue #14).
 */
export class WorkspaceProvisioner {
  private readonly projectsDir: string;
  private readonly stateDir: string;
  private readonly git: GitRunner;
  private readonly warn: (message: string) => void;

  constructor(opts: WorkspaceProvisionerOptions) {
    this.projectsDir = opts.projectsDir;
    this.stateDir = opts.stateDir;
    this.git = opts.git;
    this.warn = opts.warn ?? ((m) => console.warn(m));
  }

  /**
   * Inspect the flat projects-directory entry for an Issue's repository
   * and report whether it can be reused.
   *
   * Returns `{ ok: true }` when the repo exists locally and its `origin`
   * remote matches `expectedRemote` (URL forms collapsed via
   * {@link normalizeRemoteUrl}). Returns `{ ok: false, reason }` for the
   * two failure shapes the Conductor cares about: missing local clone
   * (which triggers a clone) or remote mismatch (skip Task policy).
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

  public async provision(input: ProvisionInput): Promise<ProvisionOutcome> {
    const validation = await this.validateRemote({
      owner: input.owner,
      repo: input.repo,
      expectedRemote: input.expectedRemote,
    });

    if (!validation.ok && validation.reason === "remote-mismatch") {
      const actualRemote = validation.actualRemote ?? "(unknown)";
      this.warn(
        `pi-lot: skipping ${input.owner}/${input.repo} #${input.issueNumber}: ` +
          `local path ${validation.repoPath} has origin ${actualRemote}, ` +
          `expected ${input.expectedRemote}.`,
      );
      return {
        kind: "skipped",
        reason: "remote-mismatch",
        repoPath: validation.repoPath,
        expectedRemote: input.expectedRemote,
        actualRemote,
      };
    }

    let repoPath: string;
    if (!validation.ok && validation.reason === "not-found") {
      repoPath = validation.repoPath;
      await this.git.clone({ repoPath, remoteUrl: input.expectedRemote });
    } else if (validation.ok) {
      repoPath = validation.repoPath;
    } else {
      // Defensive: all `validation.ok === false` reasons are handled above.
      throw new Error(`Unexpected validation result for ${input.owner}/${input.repo}`);
    }

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

    return { kind: "provisioned", repoPath, worktreePath, taskBranch, baseBranch };
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
