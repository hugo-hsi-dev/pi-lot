import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conductor } from "../../src/conductor/index.ts";
import { assemblePiLotRuntime } from "../../src/conductor/runtime.ts";
import {
  TERMINAL_REPORT_BEGIN,
  TERMINAL_REPORT_END,
} from "../../src/phases/index.ts";
import type {
  IssueContext,
  PiSession,
  PiSessionFactory,
  PiSessionInput,
} from "../../src/phases/index.ts";
import { FileSystemRunStore } from "../../src/runs/index.ts";
import type { Run } from "../../src/runs/index.ts";
import { WorkspaceProvisioner } from "../../src/workspace/index.ts";
import { defaultWorktreeCleanup } from "../../src/workspace/index.ts";
import { FakeGitRunner } from "../workspace/fake-git-runner.ts";
import type { GhRunner } from "../../src/board/index.ts";
import type { PiLotConfig } from "../../src/config/index.ts";
import type { Task } from "../../src/board/index.ts";
import type {
  AddWorktreeInput,
  GitRunner,
} from "../../src/workspace/index.ts";

/**
 * End-to-end tests for the full Conductor pipeline (issue #12).
 *
 * These tests document the MVP testing pattern for future contributors:
 * a single Queued Issue is driven through workspace provisioning,
 * Implement, Review, Finalize, Terminal Report parsing, Board handoff,
 * and worktree cleanup — without calling real GitHub, real repositories,
 * or a real model.
 *
 * What is FAKE / IN-MEMORY here:
 *   - Board: a fake `gh` runner returns a synthetic GraphQL response and
 *     a recording boardStatusUpdater captures every status transition.
 *   - Pi sessions: a per-phase factory yields scripted PiSession events
 *     and exit codes.
 *   - Git: the FakeGitRunner from `tests/workspace/`; no real git
 *     subprocess is spawned and no real clone exists.
 *   - Issue context: a deterministic loader supplies body, labels, and
 *     the existing draft PR URL.
 *
 * What is REAL here:
 *   - The Conductor, Scheduler, and RunRunner composition.
 *   - The Implement, Review, and Finalize Phase business logic.
 *   - The FileSystemRunStore (writing Run Records + transcripts under a
 *     temp stateDir).
 *   - The WorkspaceProvisioner orchestrating the FakeGitRunner.
 *   - The defaultWorktreeCleanup (so we can observe real directory
 *     deletion / preservation on disk).
 *
 * The tests assert externally observable behavior only: Board status
 * transitions, Run Record contents, worktree presence on disk. They
 * never read private helpers or assert on internal object construction.
 */

const BOARD = {
  owner: "octocat",
  projectNumber: 7,
  statusField: "Status",
  statusValues: {
    queued: "Queued",
    implementing: "Implementing",
    reviewing: "Reviewing",
    finalizing: "Finalizing",
    readyForReview: "Ready for Review",
    needsHuman: "Needs Human",
  },
} as const;

function cfg(stateDir: string, projectsDir: string): PiLotConfig {
  return {
    board: { ...BOARD, statusValues: { ...BOARD.statusValues } },
    projectsDir,
    stateDir,
    pollIntervalMs: 30000,
    concurrency: 1,
  };
}

/**
 * Build a fake `gh` runner that returns exactly one Queued ISSUE for the
 * Board poll. Tests reuse this so a single Task drives the whole pipeline.
 */
function queuedIssueGhRunner(opts: {
  issueNumber: number;
  owner: string;
  repo: string;
}): GhRunner {
  return async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      data: {
        organization: {
          projectV2: {
            id: "PVT_e2e",
            field: { id: "PVTSSF_e2e", name: "Status" },
            items: {
              nodes: [
                {
                  id: `PVTI_${opts.issueNumber}`,
                  type: "ISSUE",
                  fieldValues: {
                    nodes: [
                      {
                        __typename: "ProjectV2ItemFieldSingleSelectValue",
                        name: "Queued",
                        field: { name: "Status" },
                      },
                    ],
                  },
                  content: {
                    __typename: "Issue",
                    number: opts.issueNumber,
                    id: `I_${opts.issueNumber}`,
                    title: `Issue ${opts.issueNumber}`,
                    url: `https://github.com/${opts.owner}/${opts.repo}/issues/${opts.issueNumber}`,
                    createdAt: "2026-01-01T00:00:00Z",
                    repository: {
                      owner: { login: opts.owner },
                      name: opts.repo,
                    },
                  },
                },
              ],
            },
          },
        },
      },
    }),
    stderr: "",
  });
}

interface StatusUpdate {
  statusValue: string;
}

interface RecordedSession {
  promptVersion: string;
  cwd: string;
  events: unknown[];
}

/**
 * Per-Phase scripted Pi session factory. Each Phase gets exactly one
 * fresh session, the script function returns the events the session
 * should emit and the final exit code.
 */
function scriptedPiSessionFactory(
  scripts: {
    implement: (input: PiSessionInput) => { events: unknown[]; exitCode: number };
    review: (input: PiSessionInput) => { events: unknown[]; exitCode: number };
    finalize: (input: PiSessionInput) => { events: unknown[]; exitCode: number };
  },
  recorded: RecordedSession[],
): PiSessionFactory {
  return (input: PiSessionInput) => {
    const script =
      input.promptVersion.startsWith("implement")
        ? scripts.implement
        : input.promptVersion.startsWith("review")
          ? scripts.review
          : scripts.finalize;
    const session: PiSession = {
      async run(handler) {
        const planned = script(input);
        const captured: unknown[] = [];
        for (const e of planned.events) {
          captured.push(e);
          await handler(e as Record<string, unknown>);
        }
        recorded.push({
          promptVersion: input.promptVersion,
          cwd: input.cwd,
          events: captured,
        });
        return { exitCode: planned.exitCode };
      },
    };
    return session;
  };
}

function makeTempDirs(): { stateDir: string; projectsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pilot-e2e-"));
  const stateDir = join(root, "state");
  const projectsDir = join(root, "projects");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  return { stateDir, projectsDir };
}

/**
 * Set up a GitRunner that will satisfy WorkspaceProvisioner.provision
 * for a fresh Task by acting as if the repository needs cloning. The
 * `clone` call registers the remote URL and default branch so subsequent
 * provisioner steps succeed.
 *
 * The wrapper additionally creates the worktree directory on disk in
 * `addWorktree`. That makes the worktree retention policy observable on
 * the real filesystem: success-path tests assert the directory is gone;
 * failure-path tests assert it is preserved.
 */
function makeReadyGit(opts: {
  projectsDir: string;
  repo: string;
  expectedRemote: string;
  defaultBranch: string;
}): GitRunner {
  const repoPath = join(opts.projectsDir, opts.repo);
  const inner = new FakeGitRunner({
    cloneEffects: {
      [repoPath]: {
        remoteUrl: opts.expectedRemote,
        defaultBranch: opts.defaultBranch,
      },
    },
  });
  const wrapper: GitRunner = {
    clone: (input) => inner.clone(input),
    getRemoteUrl: (rp, remote) => inner.getRemoteUrl(rp, remote),
    fetchOrigin: (rp) => inner.fetchOrigin(rp),
    resolveDefaultBranch: (rp) => inner.resolveDefaultBranch(rp),
    resetTaskBranch: (input) => inner.resetTaskBranch(input),
    worktreeExists: (rp, wt) => inner.worktreeExists(rp, wt),
    removeWorktree: (rp, wt) => inner.removeWorktree(rp, wt),
    addWorktree: async (input: AddWorktreeInput) => {
      await inner.addWorktree(input);
      mkdirSync(input.worktreePath, { recursive: true });
    },
  };
  return wrapper;
}

describe("Pi Lot end-to-end: one Task from Queued to Ready for Review", () => {
  test("the Conductor drives the full Implement -> Review -> Finalize pipeline using fakes", async () => {
    const { stateDir, projectsDir } = makeTempDirs();
    const owner = "octocat";
    const repo = "widget";
    const issueNumber = 42;
    const expectedRemote = `https://github.com/${owner}/${repo}.git`;

    const store = new FileSystemRunStore({ stateDir });
    const git = makeReadyGit({
      projectsDir,
      repo,
      expectedRemote,
      defaultBranch: "main",
    });
    const provisioner = new WorkspaceProvisioner({
      projectsDir,
      stateDir,
      git,
    });

    const gh: GhRunner = queuedIssueGhRunner({ issueNumber, owner, repo });

    const statusCalls: StatusUpdate[] = [];
    const issueContext: IssueContext = {
      body: "Implement frobnicator",
      labels: ["enhancement"],
      existingDraftPrUrl: "https://github.com/octocat/widget/pull/9",
    };

    const recorded: RecordedSession[] = [];
    const validReport = [
      TERMINAL_REPORT_BEGIN,
      JSON.stringify({
        status: "ready-for-review",
        issue: { owner, repo, number: issueNumber },
        prUrl: "https://github.com/octocat/widget/pull/9",
        summary: "Implemented, reviewed, finalized.",
      }),
      TERMINAL_REPORT_END,
    ].join("\n");

    const piSessionFactory = scriptedPiSessionFactory(
      {
        implement: () => ({
          events: [{ kind: "message", text: "implement: edited files" }],
          exitCode: 0,
        }),
        review: () => ({
          events: [{ kind: "message", text: "review: no fixes needed" }],
          exitCode: 0,
        }),
        finalize: () => ({
          events: [{ kind: "message", text: validReport }],
          exitCode: 0,
        }),
      },
      recorded,
    );

    const runtime = assemblePiLotRuntime({
      config: cfg(stateDir, projectsDir),
      runStore: store,
      provisioner,
      piSessionFactory,
      boardStatusUpdater: async (req) => {
        statusCalls.push({ statusValue: req.statusValue });
      },
      issueContextLoader: async () => issueContext,
      prTemplateLoader: async () => null,
      cleanup: defaultWorktreeCleanup(),
      expectedRemoteFor: () => expectedRemote,
    });

    const conductor = new Conductor(cfg(stateDir, projectsDir), {
      gh,
      runner: runtime.runner,
    });

    await conductor.tick();
    await conductor.idle();

    // Board status transitions: implementing -> reviewing -> finalizing
    // -> readyForReview. The "Queued -> Implementing" arrow is the first
    // update issued by Pi Lot; previous Queued state is owned by the
    // human who triaged the Issue on the Board, not the Conductor.
    expect(statusCalls.map((c) => c.statusValue)).toEqual([
      "Implementing",
      "Reviewing",
      "Finalizing",
      "Ready for Review",
    ]);

    // Each of the three Phases ran in its own fresh Pi session.
    expect(recorded.map((s) => s.promptVersion)).toEqual([
      "implement/v1",
      "review/v1",
      "finalize/v1",
    ]);

    // Run Record: terminal ready-for-review with all three Phase records
    // plus the Terminal Report.
    const runsList = await store.listActiveRuns();
    expect(runsList).toEqual([]); // No active Runs; Run completed.

    // Find the persisted Run via the per-task filename pattern.
    const persisted = await loadOnlyRun(stateDir);
    expect(persisted.status).toBe("ready-for-review");
    expect(persisted.phases.map((p) => p.name)).toEqual([
      "implement",
      "review",
      "finalize",
    ]);
    for (const p of persisted.phases) {
      expect(p.status).toBe("succeeded");
    }
    expect(persisted.terminalReport).toBeDefined();
    expect(persisted.terminalReport!.status).toBe("ready-for-review");
    expect(persisted.terminalReport!.prUrl).toBe(
      "https://github.com/octocat/widget/pull/9",
    );

    // Worktree deleted after success.
    expect(existsSync(persisted.worktreePath)).toBe(false);
  });
});

describe("Pi Lot end-to-end: Phase failure routes to Needs Human", () => {
  test("a fatal Implement Phase failure flips the Board to Needs Human and preserves the worktree", async () => {
    const { stateDir, projectsDir } = makeTempDirs();
    const owner = "octocat";
    const repo = "widget";
    const issueNumber = 77;
    const expectedRemote = `https://github.com/${owner}/${repo}.git`;

    const store = new FileSystemRunStore({ stateDir });
    const git = makeReadyGit({
      projectsDir,
      repo,
      expectedRemote,
      defaultBranch: "main",
    });
    const provisioner = new WorkspaceProvisioner({
      projectsDir,
      stateDir,
      git,
    });

    const gh: GhRunner = queuedIssueGhRunner({ issueNumber, owner, repo });

    const statusCalls: StatusUpdate[] = [];
    const recorded: RecordedSession[] = [];

    const piSessionFactory = scriptedPiSessionFactory(
      {
        // Implement Phase fails fatally — non-zero exit.
        implement: () => ({
          events: [{ kind: "message", text: "implement: failed mid-run" }],
          exitCode: 2,
        }),
        // Review and Finalize should never run because Implement failed.
        review: () => {
          throw new Error("review should not run after Implement failure");
        },
        finalize: () => {
          throw new Error("finalize should not run after Implement failure");
        },
      },
      recorded,
    );

    const runtime = assemblePiLotRuntime({
      config: cfg(stateDir, projectsDir),
      runStore: store,
      provisioner,
      piSessionFactory,
      boardStatusUpdater: async (req) => {
        statusCalls.push({ statusValue: req.statusValue });
      },
      issueContextLoader: async () => ({
        body: "x",
        labels: [],
        existingDraftPrUrl: undefined,
      }),
      prTemplateLoader: async () => null,
      cleanup: defaultWorktreeCleanup(),
      expectedRemoteFor: () => expectedRemote,
    });

    const conductor = new Conductor(cfg(stateDir, projectsDir), {
      gh,
      runner: runtime.runner,
    });

    await conductor.tick();
    await conductor.idle();

    // Board transitions: Implementing (start of Implement Phase) then
    // Needs Human (Conductor outcome handler). Reviewing/Finalizing/
    // Ready for Review must not appear.
    expect(statusCalls.map((c) => c.statusValue)).toEqual([
      "Implementing",
      "Needs Human",
    ]);
    expect(recorded.map((s) => s.promptVersion)).toEqual(["implement/v1"]);

    const persisted = await loadOnlyRun(stateDir);
    expect(persisted.status).toBe("needs-human");
    expect(persisted.terminalReport).toBeDefined();
    expect(persisted.terminalReport!.status).toBe("needs-human");
    expect(persisted.terminalReport!.needsHumanReason).toContain("implement");

    // Failed worktree preserved on disk for human debugging.
    expect(existsSync(persisted.worktreePath)).toBe(true);
  });
});

/**
 * Read the single Run Record persisted under `<stateDir>/runs/`. The e2e
 * tests assert on a single Task per run, so we expect exactly one file.
 */
async function loadOnlyRun(stateDir: string): Promise<Run> {
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = join(stateDir, "runs");
  const entries = await readdir(dir);
  const files = entries.filter((e) => e.endsWith(".json"));
  if (files.length !== 1) {
    throw new Error(
      `Expected exactly one Run Record under ${dir}; found ${files.length}: ${files.join(", ")}`,
    );
  }
  const raw = await readFile(join(dir, files[0]!), "utf8");
  return JSON.parse(raw) as Run;
}
