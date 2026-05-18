import { spawn } from "node:child_process";
import type {
  AddWorktreeInput,
  GitRunner,
  ResetTaskBranchInput,
} from "./git-runner.ts";

/**
 * Production GitRunner that shells out to the real `git` binary.
 *
 * Each operation is a single subprocess invocation with explicit
 * arguments — there is no shell interpolation. The implementation
 * deliberately stays small: it owns argv construction and exit-code
 * translation, and nothing else. Tests inject FakeGitRunner; this
 * class is for the Conductor at runtime.
 *
 * Failures surface as Error with stderr appended so the Conductor
 * can log them into Run Records without further parsing.
 */
export class SubprocessGitRunner implements GitRunner {
  private readonly gitBin: string;

  constructor(opts: { gitBin?: string } = {}) {
    this.gitBin = opts.gitBin ?? "git";
  }

  async getRemoteUrl(repoPath: string, remote = "origin"): Promise<string> {
    const out = await this.run(repoPath, ["remote", "get-url", remote]);
    return out.trim();
  }

  async fetchOrigin(repoPath: string): Promise<void> {
    await this.run(repoPath, ["fetch", "--prune", "origin"]);
  }

  async resolveDefaultBranch(repoPath: string): Promise<string> {
    // Prefer the cached symbolic-ref; fall back to a remote query when
    // the local clone has never recorded origin/HEAD.
    try {
      const out = await this.run(repoPath, [
        "symbolic-ref",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      const ref = out.trim();
      // Output is `origin/<branch>`; strip the remote prefix.
      const slash = ref.indexOf("/");
      if (slash >= 0) return ref.slice(slash + 1);
      return ref;
    } catch {
      await this.run(repoPath, ["remote", "set-head", "origin", "--auto"]);
      const out = await this.run(repoPath, [
        "symbolic-ref",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      const ref = out.trim();
      const slash = ref.indexOf("/");
      return slash >= 0 ? ref.slice(slash + 1) : ref;
    }
  }

  async resetTaskBranch(input: ResetTaskBranchInput): Promise<void> {
    // `git branch -f <branch> <base-ref>` creates or moves the branch
    // without checking it out, so a worktree on the same branch is
    // unaffected when we recreate it below.
    await this.run(input.repoPath, [
      "branch",
      "-f",
      input.branch,
      `origin/${input.base}`,
    ]);
  }

  async worktreeExists(repoPath: string, worktreePath: string): Promise<boolean> {
    const out = await this.run(repoPath, ["worktree", "list", "--porcelain"]);
    return out
      .split("\n")
      .some((line) => line.startsWith("worktree ") && line.slice(9).trim() === worktreePath);
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    await this.run(repoPath, ["worktree", "remove", "--force", worktreePath]);
  }

  async addWorktree(input: AddWorktreeInput): Promise<void> {
    await this.run(input.repoPath, [
      "worktree",
      "add",
      "--force",
      input.worktreePath,
      input.branch,
    ]);
  }

  private run(repoPath: string, args: readonly string[]): Promise<string> {
    return new Promise((resolveP, rejectP) => {
      const child = spawn(this.gitBin, ["-C", repoPath, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", rejectP);
      child.on("close", (code) => {
        if (code === 0) {
          resolveP(stdout);
        } else {
          rejectP(
            new Error(
              `git ${args.join(" ")} failed in ${repoPath} (exit ${code}): ${stderr.trim()}`,
            ),
          );
        }
      });
    });
  }
}
