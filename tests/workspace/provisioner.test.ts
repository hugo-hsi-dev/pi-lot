import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceProvisioner,
  normalizeRemoteUrl,
} from "../../src/workspace/index.ts";
import type {
  ProvisionOutcome,
  ProvisionedWorkspace,
} from "../../src/workspace/index.ts";
import { FakeGitRunner } from "./fake-git-runner.ts";

/**
 * Narrow a {@link ProvisionOutcome} to the success variant for tests
 * that intentionally exercise the happy path. Throws (and fails the
 * test) if the provisioner unexpectedly returned a skip.
 */
function assertProvisioned(outcome: ProvisionOutcome): ProvisionedWorkspace {
  if (outcome.kind !== "provisioned") {
    throw new Error(
      `Expected a provisioned workspace, got skipped (${outcome.reason}).`,
    );
  }
  return outcome;
}

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

    const result = assertProvisioned(
      await provisioner.provision({
        owner: "hugo-hsi-dev",
        repo: "pi-lot",
        issueNumber: 6,
        expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
      }),
    );

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

    const result = assertProvisioned(
      await provisioner.provision({
        owner: "acme",
        repo: "weird-repo",
        issueNumber: 42,
        expectedRemote: "git@github.com:acme/weird-repo.git",
      }),
    );

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

    const first = assertProvisioned(
      await provisioner.provision({
        owner: "hugo-hsi-dev",
        repo: "pi-lot",
        issueNumber: 6,
        expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
      }),
    );
    const second = assertProvisioned(
      await provisioner.provision({
        owner: "hugo-hsi-dev",
        repo: "pi-lot",
        issueNumber: 6,
        expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
      }),
    );

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

    const result = assertProvisioned(
      await provisioner.provision({
        owner: "hugo-hsi-dev",
        repo: "pi-lot",
        issueNumber: 6,
        expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
      }),
    );

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

    const result = assertProvisioned(
      await provisioner.provision({
        owner: "hugo-hsi-dev",
        repo: "pi-lot",
        issueNumber: 6,
        expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
      }),
    );

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

describe("WorkspaceProvisioner.validateRemote", () => {
  test("returns ok when the configured origin matches the expected remote", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    withExistingRepo(projectsDir, "pi-lot", "git@github.com:hugo-hsi-dev/pi-lot.git");
    const repoPath = join(projectsDir, "pi-lot");
    const git = new FakeGitRunner({
      remoteUrls: { [repoPath]: "git@github.com:hugo-hsi-dev/pi-lot.git" },
    });
    const provisioner = new WorkspaceProvisioner({ projectsDir, stateDir, git });

    const result = await provisioner.validateRemote({
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
    });

    expect(result.ok).toBe(true);
    expect(result.actualRemote).toBe("git@github.com:hugo-hsi-dev/pi-lot.git");
  });

  test("treats SSH and HTTPS forms of the same repo as a match", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    withExistingRepo(projectsDir, "pi-lot", "https://github.com/hugo-hsi-dev/pi-lot.git");
    const repoPath = join(projectsDir, "pi-lot");
    const git = new FakeGitRunner({
      remoteUrls: { [repoPath]: "https://github.com/hugo-hsi-dev/pi-lot.git" },
    });
    const provisioner = new WorkspaceProvisioner({ projectsDir, stateDir, git });

    const result = await provisioner.validateRemote({
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
    });

    expect(result.ok).toBe(true);
  });

  test("returns not-ok when the configured origin points to a different repo", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    withExistingRepo(projectsDir, "pi-lot", "git@github.com:someone-else/pi-lot.git");
    const repoPath = join(projectsDir, "pi-lot");
    const git = new FakeGitRunner({
      remoteUrls: { [repoPath]: "git@github.com:someone-else/pi-lot.git" },
    });
    const provisioner = new WorkspaceProvisioner({ projectsDir, stateDir, git });

    const result = await provisioner.validateRemote({
      owner: "hugo-hsi-dev",
      repo: "pi-lot",
      expectedRemote: "git@github.com:hugo-hsi-dev/pi-lot.git",
    });

    expect(result.ok).toBe(false);
    expect(result.actualRemote).toContain("someone-else");
  });

  test("returns not-ok with a not-found reason when no local repo exists", async () => {
    const { projectsDir, stateDir } = makeTempDirs();
    const git = new FakeGitRunner();
    const provisioner = new WorkspaceProvisioner({ projectsDir, stateDir, git });

    const result = await provisioner.validateRemote({
      owner: "hugo-hsi-dev",
      repo: "missing-repo",
      expectedRemote: "git@github.com:hugo-hsi-dev/missing-repo.git",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-found");
  });
});

// Behavior for missing repositories and remote-mismatch collisions is
// covered in `clone.test.ts` (issue #7). Previously this section asserted
// that those situations threw `RepositoryNotFoundError` /
// `RemoteMismatchError`; both are now non-throw outcomes
// (clone-and-continue, and skip-with-warning respectively).

describe("normalizeRemoteUrl", () => {
  test("collapses ssh and https forms of the same GitHub repo", () => {
    const a = normalizeRemoteUrl("git@github.com:hugo-hsi-dev/pi-lot.git");
    const b = normalizeRemoteUrl("https://github.com/hugo-hsi-dev/pi-lot.git");
    const c = normalizeRemoteUrl("https://github.com/hugo-hsi-dev/pi-lot");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("does not collapse different repositories", () => {
    expect(normalizeRemoteUrl("git@github.com:hugo-hsi-dev/pi-lot.git")).not.toBe(
      normalizeRemoteUrl("git@github.com:someone-else/pi-lot.git"),
    );
  });
});
