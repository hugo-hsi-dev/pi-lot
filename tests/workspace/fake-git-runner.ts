/**
 * In-memory GitRunner for tests. No real git subprocess invocation.
 *
 * The fake records every operation it sees so tests can assert on
 * observable side-effects (fetches, branch resets, worktree creation)
 * without coupling to internal helper structure.
 */
import type {
  AddWorktreeInput,
  GitRunner,
  ResetTaskBranchInput,
} from "../../src/workspace/git-runner.ts";

export interface FakeGitRunnerOptions {
  /** Map repoPath -> remote URL returned for `origin`. */
  remoteUrls?: Record<string, string>;
  /** Map repoPath -> default branch (e.g. "main", "master"). */
  defaultBranches?: Record<string, string>;
  /** Optional list of existing worktree paths the fake should report. */
  existingWorktrees?: string[];
}

export interface FakeGitCall {
  op:
    | "getRemoteUrl"
    | "fetchOrigin"
    | "resolveDefaultBranch"
    | "resetTaskBranch"
    | "worktreeExists"
    | "removeWorktree"
    | "addWorktree";
  repoPath: string;
  args?: Record<string, unknown>;
}

export class FakeGitRunner implements GitRunner {
  public readonly calls: FakeGitCall[] = [];
  private readonly remoteUrls: Record<string, string>;
  private readonly defaultBranches: Record<string, string>;
  private readonly existingWorktrees: Set<string>;

  constructor(opts: FakeGitRunnerOptions = {}) {
    this.remoteUrls = { ...(opts.remoteUrls ?? {}) };
    this.defaultBranches = { ...(opts.defaultBranches ?? {}) };
    this.existingWorktrees = new Set(opts.existingWorktrees ?? []);
  }

  async getRemoteUrl(repoPath: string, remote = "origin"): Promise<string> {
    this.calls.push({ op: "getRemoteUrl", repoPath, args: { remote } });
    const url = this.remoteUrls[repoPath];
    if (!url) {
      throw new Error(`fake: no remote URL configured for ${repoPath}`);
    }
    return url;
  }

  async fetchOrigin(repoPath: string): Promise<void> {
    this.calls.push({ op: "fetchOrigin", repoPath });
  }

  async resolveDefaultBranch(repoPath: string): Promise<string> {
    this.calls.push({ op: "resolveDefaultBranch", repoPath });
    const branch = this.defaultBranches[repoPath];
    if (!branch) {
      throw new Error(`fake: no default branch configured for ${repoPath}`);
    }
    return branch;
  }

  async resetTaskBranch(input: ResetTaskBranchInput): Promise<void> {
    this.calls.push({
      op: "resetTaskBranch",
      repoPath: input.repoPath,
      args: { branch: input.branch, base: input.base },
    });
  }

  async worktreeExists(repoPath: string, worktreePath: string): Promise<boolean> {
    this.calls.push({
      op: "worktreeExists",
      repoPath,
      args: { worktreePath },
    });
    return this.existingWorktrees.has(worktreePath);
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    this.calls.push({
      op: "removeWorktree",
      repoPath,
      args: { worktreePath },
    });
    this.existingWorktrees.delete(worktreePath);
  }

  async addWorktree(input: AddWorktreeInput): Promise<void> {
    this.calls.push({
      op: "addWorktree",
      repoPath: input.repoPath,
      args: {
        worktreePath: input.worktreePath,
        branch: input.branch,
      },
    });
    this.existingWorktrees.add(input.worktreePath);
  }
}
