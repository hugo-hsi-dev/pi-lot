/**
 * Behavioral tests for issue #7: clone missing repositories and skip
 * unsafe name collisions safely.
 *
 * These tests treat `WorkspaceProvisioner.provision` as the public
 * interface and verify outcomes the Conductor observes:
 *
 *   - missing repo  -> clone + normal worktree provisioning
 *   - flat layout   -> clone target is `<projectsDir>/<repo>`
 *   - mismatch      -> skipped without Run work, with a local warning
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceProvisioner } from "../../src/workspace/index.ts";
import { FakeGitRunner } from "./fake-git-runner.ts";

function makeTempDirs() {
  const root = mkdtempSync(join(tmpdir(), "pilot-clone-"));
  const projectsDir = join(root, "projects");
  const stateDir = join(root, "state");
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { root, projectsDir, stateDir };
}

function withExistingRepo(projectsDir: string, repo: string) {
  const repoPath = join(projectsDir, repo);
  mkdirSync(join(repoPath, ".git"), { recursive: true });
  return repoPath;
}

describe("WorkspaceProvisioner.provision (missing repository)", () => {
  test("clones the missing repository into the flat projects directory", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    const expectedRemote = "git@github.com:hugo-hsi-dev/pi-lot.git";
    const expectedRepoPath = join(projectsDir, "pi-lot");

    // No local clone exists yet. After clone runs, the fake will report
    // the cloned repo's origin and default branch so provisioning
    // proceeds end-to-end.
    const git = new FakeGitRunner({
      cloneEffects: {
        [expectedRepoPath]: {
          remoteUrl: expectedRemote,
          defaultBranch: "main",
        },
      },
    });
    const provisioner = new WorkspaceProvisioner({ projectsDir, stateDir, git });

    const result = await provisioner.provision({
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      issueNumber: 6,
      expectedRemote,
    });

    expect(result.kind).toBe("provisioned");
    if (result.kind !== "provisioned") return;

    expect(result.repoPath).toBe(expectedRepoPath);

    const cloneCall = git.calls.find((c) => c.op === "clone");
    expect(cloneCall).toBeDefined();
    expect(cloneCall?.repoPath).toBe(expectedRepoPath);
    expect(cloneCall?.args?.remoteUrl).toBe(expectedRemote);
  });

  test("cloned repository then follows the normal worktree provisioning path", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    const expectedRemote = "git@github.com:acme/weird-repo.git";
    const expectedRepoPath = join(projectsDir, "weird-repo");

    const git = new FakeGitRunner({
      cloneEffects: {
        [expectedRepoPath]: {
          remoteUrl: expectedRemote,
          // Non-"main" default branch proves we resolve dynamically
          // post-clone, not at clone time.
          defaultBranch: "trunk",
        },
      },
    });
    const provisioner = new WorkspaceProvisioner({ projectsDir, stateDir, git });

    const result = await provisioner.provision({
      owner: "acme",
      repo: "weird-repo",
      issueNumber: 42,
      expectedRemote,
    });

    expect(result.kind).toBe("provisioned");
    if (result.kind !== "provisioned") return;

    expect(result.baseBranch).toBe("trunk");
    expect(result.worktreePath).toBe(join(stateDir, "acme", "weird-repo", "42"));

    // Clone happens before default-branch / branch-reset / worktree work.
    const opOrder = git.calls.map((c) => c.op);
    const cloneIdx = opOrder.indexOf("clone");
    const resetIdx = opOrder.indexOf("resetTaskBranch");
    const addIdx = opOrder.indexOf("addWorktree");
    expect(cloneIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(cloneIdx);
    expect(addIdx).toBeGreaterThan(resetIdx);
  });

  test("does not clone again when the repository is already present", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    const remote = "git@github.com:hugo-hsi-dev/pi-lot.git";
    const repoPath = withExistingRepo(projectsDir, "pi-lot");

    const git = new FakeGitRunner({
      remoteUrls: { [repoPath]: remote },
      defaultBranches: { [repoPath]: "main" },
    });
    const provisioner = new WorkspaceProvisioner({ projectsDir, stateDir, git });

    const result = await provisioner.provision({
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      issueNumber: 6,
      expectedRemote: remote,
    });

    expect(result.kind).toBe("provisioned");
    expect(git.calls.some((c) => c.op === "clone")).toBe(false);
  });
});

describe("WorkspaceProvisioner.provision (unsafe name collision)", () => {
  test("skips the Task when the local repo's origin disagrees with the Issue", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    const repoPath = withExistingRepo(projectsDir, "pi-lot");
    const git = new FakeGitRunner({
      remoteUrls: { [repoPath]: "git@github.com:someone-else/pi-lot.git" },
      defaultBranches: { [repoPath]: "main" },
    });
    const provisioner = new WorkspaceProvisioner({ projectsDir, stateDir, git });

    const result = await provisioner.provision({
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      issueNumber: 6,
      expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
    });

    expect(result.kind).toBe("skipped");
    if (result.kind !== "skipped") return;
    expect(result.reason).toBe("remote-mismatch");
    expect(result.repoPath).toBe(repoPath);
    expect(result.actualRemote).toContain("someone-else");
  });

  test("does no Run work (no clone, no reset, no worktree) on a collision", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    const repoPath = withExistingRepo(projectsDir, "pi-lot");
    const git = new FakeGitRunner({
      remoteUrls: { [repoPath]: "git@github.com:someone-else/pi-lot.git" },
      defaultBranches: { [repoPath]: "main" },
    });
    const provisioner = new WorkspaceProvisioner({ projectsDir, stateDir, git });

    await provisioner.provision({
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      issueNumber: 6,
      expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
    });

    expect(git.calls.some((c) => c.op === "clone")).toBe(false);
    expect(git.calls.some((c) => c.op === "resetTaskBranch")).toBe(false);
    expect(git.calls.some((c) => c.op === "addWorktree")).toBe(false);
    expect(git.calls.some((c) => c.op === "fetchOrigin")).toBe(false);
  });

  test("emits a local warning describing the colliding remote", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    const repoPath = withExistingRepo(projectsDir, "pi-lot");
    const git = new FakeGitRunner({
      remoteUrls: { [repoPath]: "git@github.com:someone-else/pi-lot.git" },
      defaultBranches: { [repoPath]: "main" },
    });

    const warnings: string[] = [];
    const provisioner = new WorkspaceProvisioner({
      projectsDir,
      stateDir,
      git,
      warn: (msg) => warnings.push(msg),
    });

    await provisioner.provision({
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      issueNumber: 6,
      expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
    });

    expect(warnings.length).toBeGreaterThan(0);
    const joined = warnings.join("\n");
    expect(joined).toContain("pi-lot");
    expect(joined).toContain("someone-else");
  });
});
