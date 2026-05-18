import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceProvisioner } from "../../src/workspace/index.ts";
import { FakeGitRunner } from "./fake-git-runner.ts";

function makeTempDirs() {
  const root = mkdtempSync(join(tmpdir(), "pilot-ws-"));
  const projectsDir = join(root, "projects");
  const stateDir = join(root, "state");
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { root, projectsDir, stateDir };
}

function withExistingRepo(projectsDir: string, repo: string, remoteUrl: string) {
  const repoPath = join(projectsDir, repo);
  mkdirSync(join(repoPath, ".git"), { recursive: true });
  return { repoPath, remoteUrl };
}

describe("WorkspaceProvisioner.provision (existing matching repo)", () => {
  test("reuses an existing matching repository in the projects directory", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    withExistingRepo(projectsDir, "pi-lot", "git@github.com:hugo-hsi-dev/pi-lot.git");

    const git = new FakeGitRunner({
      remoteUrls: {
        [join(projectsDir, "pi-lot")]: "git@github.com:hugo-hsi-dev/pi-lot.git",
      },
      defaultBranches: { [join(projectsDir, "pi-lot")]: "main" },
    });
    const provisioner = new WorkspaceProvisioner({ projectsDir, stateDir, git });

    const result = await provisioner.provision({
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      issueNumber: 6,
      expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
    });

    expect(result.repoPath).toBe(join(projectsDir, "pi-lot"));
  });

  test("resolves the repository default branch dynamically via GitRunner", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    withExistingRepo(projectsDir, "weird-repo", "git@github.com:acme/weird-repo.git");

    const git = new FakeGitRunner({
      remoteUrls: {
        [join(projectsDir, "weird-repo")]: "git@github.com:acme/weird-repo.git",
      },
      // Default branch is not "main" — provisioner must learn that from git, not hardcode it.
      defaultBranches: { [join(projectsDir, "weird-repo")]: "trunk" },
    });
    const provisioner = new WorkspaceProvisioner({ projectsDir, stateDir, git });

    const result = await provisioner.provision({
      owner: "acme",
      repo: "weird-repo",
      issueNumber: 42,
      expectedRemote: "git@github.com:acme/weird-repo.git",
    });

    expect(result.baseBranch).toBe("trunk");
    expect(git.calls.some((c) => c.op === "resolveDefaultBranch")).toBe(true);
  });

  test("uses a stable Task Branch name reused across Runs for the same Issue", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    withExistingRepo(projectsDir, "pi-lot", "git@github.com:hugo-hsi-dev/pi-lot.git");
    const git = new FakeGitRunner({
      remoteUrls: {
        [join(projectsDir, "pi-lot")]: "git@github.com:hugo-hsi-dev/pi-lot.git",
      },
      defaultBranches: { [join(projectsDir, "pi-lot")]: "main" },
    });
    const provisioner = new WorkspaceProvisioner({ projectsDir, stateDir, git });

    const first = await provisioner.provision({
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      issueNumber: 6,
      expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
    });
    const second = await provisioner.provision({
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      issueNumber: 6,
      expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
    });

    expect(second.taskBranch).toBe(first.taskBranch);
    expect(first.taskBranch).toContain("issue-6");
  });

  test("resets the Task Branch to the resolved default-branch base on every Run", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    withExistingRepo(projectsDir, "pi-lot", "git@github.com:hugo-hsi-dev/pi-lot.git");
    const repoPath = join(projectsDir, "pi-lot");
    const git = new FakeGitRunner({
      remoteUrls: { [repoPath]: "git@github.com:hugo-hsi-dev/pi-lot.git" },
      defaultBranches: { [repoPath]: "main" },
    });
    const provisioner = new WorkspaceProvisioner({ projectsDir, stateDir, git });

    const result = await provisioner.provision({
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      issueNumber: 6,
      expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
    });

    const reset = git.calls.find((c) => c.op === "resetTaskBranch");
    expect(reset).toBeDefined();
    expect(reset?.repoPath).toBe(repoPath);
    expect(reset?.args?.branch).toBe(result.taskBranch);
    expect(reset?.args?.base).toBe("main");
  });

  test("creates the worktree under <stateDir>/<owner>/<repo>/<issueNumber>", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    withExistingRepo(projectsDir, "pi-lot", "git@github.com:hugo-hsi-dev/pi-lot.git");
    const repoPath = join(projectsDir, "pi-lot");
    const git = new FakeGitRunner({
      remoteUrls: { [repoPath]: "git@github.com:hugo-hsi-dev/pi-lot.git" },
      defaultBranches: { [repoPath]: "main" },
    });
    const provisioner = new WorkspaceProvisioner({ projectsDir, stateDir, git });

    const result = await provisioner.provision({
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      issueNumber: 6,
      expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
    });

    const expectedPath = join(stateDir, "hugo-hsi-dev", "pi-lot", "6");
    expect(result.worktreePath).toBe(expectedPath);

    const add = git.calls.find((c) => c.op === "addWorktree");
    expect(add).toBeDefined();
    expect(add?.repoPath).toBe(repoPath);
    expect(add?.args?.worktreePath).toBe(expectedPath);
    expect(add?.args?.branch).toBe(result.taskBranch);
  });

  test("replaces a leftover worktree at the same path before creating a new one", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    withExistingRepo(projectsDir, "pi-lot", "git@github.com:hugo-hsi-dev/pi-lot.git");
    const repoPath = join(projectsDir, "pi-lot");
    const expectedPath = join(stateDir, "hugo-hsi-dev", "pi-lot", "6");
    const git = new FakeGitRunner({
      remoteUrls: { [repoPath]: "git@github.com:hugo-hsi-dev/pi-lot.git" },
      defaultBranches: { [repoPath]: "main" },
      existingWorktrees: [expectedPath],
    });
    const provisioner = new WorkspaceProvisioner({ projectsDir, stateDir, git });

    await provisioner.provision({
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      issueNumber: 6,
      expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
    });

    const removeIdx = git.calls.findIndex(
      (c) => c.op === "removeWorktree" && c.args?.worktreePath === expectedPath,
    );
    const addIdx = git.calls.findIndex(
      (c) => c.op === "addWorktree" && c.args?.worktreePath === expectedPath,
    );
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(removeIdx);
  });
});
