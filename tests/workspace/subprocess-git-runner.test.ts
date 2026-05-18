/**
 * Integration tests for SubprocessGitRunner using local-only git.
 *
 * Each test builds a tiny bare repository as `origin` and a working
 * clone pointed at it. No network is touched. These tests exist so
 * the production wiring stays honest about real git semantics
 * (default-branch resolution, `branch -f`, worktree add/remove).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SubprocessGitRunner } from "../../src/workspace/subprocess-git-runner.ts";
import { WorkspaceProvisioner } from "../../src/workspace/index.ts";
import { existsSync } from "node:fs";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} in ${cwd} failed: ${result.stderr || result.stdout}`,
    );
  }
}

function setupRepo(defaultBranch: string): { repoPath: string; remotePath: string } {
  const root = mkdtempSync(join(tmpdir(), "pilot-git-"));
  const remotePath = join(root, "remote.git");
  const repoPath = join(root, "clone");
  mkdirSync(remotePath);

  // Bare upstream
  git(remotePath, ["init", "--bare", "--initial-branch", defaultBranch]);

  // Seed a commit
  const seedPath = join(root, "seed");
  mkdirSync(seedPath);
  git(seedPath, ["init", "--initial-branch", defaultBranch]);
  git(seedPath, ["config", "user.email", "t@t"]);
  git(seedPath, ["config", "user.name", "t"]);
  git(seedPath, ["commit", "--allow-empty", "-m", "seed"]);
  git(seedPath, ["remote", "add", "origin", remotePath]);
  git(seedPath, ["push", "origin", defaultBranch]);

  // Working clone with origin/HEAD recorded
  git(root, ["clone", remotePath, "clone"]);
  git(repoPath, ["config", "user.email", "t@t"]);
  git(repoPath, ["config", "user.name", "t"]);
  return { repoPath, remotePath };
}

describe("SubprocessGitRunner (local git)", () => {
  test("getRemoteUrl returns the configured origin URL", async () => {
    const { repoPath, remotePath } = setupRepo("main");
    const runner = new SubprocessGitRunner();
    expect(await runner.getRemoteUrl(repoPath)).toBe(remotePath);
  });

  test("resolveDefaultBranch returns the upstream's HEAD branch (not hardcoded)", async () => {
    const { repoPath } = setupRepo("trunk");
    const runner = new SubprocessGitRunner();
    expect(await runner.resolveDefaultBranch(repoPath)).toBe("trunk");
  });

  test("resetTaskBranch creates or moves the branch to origin/<base>", async () => {
    const { repoPath } = setupRepo("main");
    const runner = new SubprocessGitRunner();
    await runner.resetTaskBranch({
      repoPath,
      branch: "pi-lot/test/task",
      base: "main",
    });
    const result = spawnSync(
      "git",
      ["-C", repoPath, "rev-parse", "pi-lot/test/task"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
  });

  test("WorkspaceProvisioner end-to-end against real git provisions a working worktree", async () => {
    const { repoPath, remotePath } = setupRepo("trunk");

    // Lay out the projects + state directories the Conductor will use.
    const baseRoot = mkdtempSync(join(tmpdir(), "pilot-e2e-"));
    const projectsDir = join(baseRoot, "projects");
    const stateDir = join(baseRoot, "state");
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    // Move the working clone into the flat projects directory layout.
    spawnSync("mv", [repoPath, join(projectsDir, "demo")]);
    const flatRepoPath = join(projectsDir, "demo");

    const provisioner = new WorkspaceProvisioner({
      projectsDir,
      stateDir,
      git: new SubprocessGitRunner(),
    });

    const outcome = await provisioner.provision({
      owner: "acme",
      repo: "demo",
      issueNumber: 12,
      expectedRemote: remotePath,
    });

    if (outcome.kind !== "provisioned") {
      throw new Error(`expected provisioned outcome, got ${outcome.kind}`);
    }
    const result = outcome;

    expect(result.repoPath).toBe(flatRepoPath);
    expect(result.baseBranch).toBe("trunk");
    expect(result.worktreePath).toBe(join(stateDir, "acme", "demo", "12"));
    expect(existsSync(result.worktreePath)).toBe(true);

    // The worktree is checked out on the Task Branch we asked for.
    const head = spawnSync(
      "git",
      ["-C", result.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8" },
    );
    expect(head.stdout.trim()).toBe(result.taskBranch);
  });

  test("clone creates a working clone whose origin matches the requested URL", async () => {
    const { remotePath } = setupRepo("main");
    const projectsDir = mkdtempSync(join(tmpdir(), "pilot-clone-"));
    const target = join(projectsDir, "demo");

    const runner = new SubprocessGitRunner();
    await runner.clone({ repoPath: target, remoteUrl: remotePath });

    expect(existsSync(join(target, ".git"))).toBe(true);
    expect(await runner.getRemoteUrl(target)).toBe(remotePath);
  });

  test("WorkspaceProvisioner end-to-end clones a missing repository before provisioning", async () => {
    const { remotePath } = setupRepo("main");

    const baseRoot = mkdtempSync(join(tmpdir(), "pilot-e2e-clone-"));
    const projectsDir = join(baseRoot, "projects");
    const stateDir = join(baseRoot, "state");
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    // Note: no repo at <projectsDir>/demo. The provisioner must clone it.
    const provisioner = new WorkspaceProvisioner({
      projectsDir,
      stateDir,
      git: new SubprocessGitRunner(),
    });

    const outcome = await provisioner.provision({
      owner: "acme",
      repo: "demo",
      issueNumber: 7,
      expectedRemote: remotePath,
    });

    if (outcome.kind !== "provisioned") {
      throw new Error(`expected provisioned outcome, got ${outcome.kind}`);
    }
    expect(outcome.repoPath).toBe(join(projectsDir, "demo"));
    expect(existsSync(join(projectsDir, "demo", ".git"))).toBe(true);
    expect(existsSync(outcome.worktreePath)).toBe(true);
  });

  test("WorkspaceProvisioner skips with a warning when the local clone has a different origin", async () => {
    const { remotePath: realRemote } = setupRepo("main");
    const { remotePath: otherRemote } = setupRepo("main");

    const baseRoot = mkdtempSync(join(tmpdir(), "pilot-skip-"));
    const projectsDir = join(baseRoot, "projects");
    const stateDir = join(baseRoot, "state");
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    // Pre-populate the flat path with a clone of the *other* repo, which
    // simulates the unsafe name collision the Conductor must skip.
    const runner = new SubprocessGitRunner();
    await runner.clone({
      repoPath: join(projectsDir, "demo"),
      remoteUrl: otherRemote,
    });

    const warnings: string[] = [];
    const provisioner = new WorkspaceProvisioner({
      projectsDir,
      stateDir,
      git: runner,
      warn: (m) => warnings.push(m),
    });

    const outcome = await provisioner.provision({
      owner: "acme",
      repo: "demo",
      issueNumber: 7,
      expectedRemote: realRemote,
    });

    expect(outcome.kind).toBe("skipped");
    expect(warnings.length).toBeGreaterThan(0);
    // No worktree should be created on a collision.
    expect(existsSync(join(stateDir, "acme", "demo", "7"))).toBe(false);
  });

  test("addWorktree, worktreeExists and removeWorktree round-trip", async () => {
    const { repoPath } = setupRepo("main");
    const runner = new SubprocessGitRunner();
    await runner.resetTaskBranch({
      repoPath,
      branch: "pi-lot/test/wt",
      base: "main",
    });

    const wtRoot = mkdtempSync(join(tmpdir(), "pilot-wt-"));
    const worktreePath = join(wtRoot, "tree");

    expect(await runner.worktreeExists(repoPath, worktreePath)).toBe(false);
    await runner.addWorktree({
      repoPath,
      worktreePath,
      branch: "pi-lot/test/wt",
    });
    expect(await runner.worktreeExists(repoPath, worktreePath)).toBe(true);
    await runner.removeWorktree(repoPath, worktreePath);
    expect(await runner.worktreeExists(repoPath, worktreePath)).toBe(false);
  });
});
