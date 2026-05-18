/**
 * Phase-layer domain types (PRD #1, issue #8).
 *
 * Pi Lot runs three Phases per Task: Implement, Review, Finalize. Each
 * Phase is a fresh Pi SDK session started by the Conductor. The session
 * is given only the facts it needs (repository / Issue / Task Branch /
 * worktree / PR lookup) — never another Phase's transcript or summary.
 *
 * These types are deliberately small and SDK-shaped so the Implement
 * Phase (and later #9/#10) can be exercised with a fake `PiSession` in
 * tests without depending on a concrete agent SDK.
 */
import type { BoardConfig } from "../config/index.ts";
import type { Task } from "../board/index.ts";
import type { Run, RunStore } from "../runs/index.ts";

/** Repository + Issue + workspace + PR facts available to a fresh Pi session. */
export interface PiSessionFacts {
  /** Repository the Task lives in. */
  repository: { owner: string; name: string };
  /** Issue facts; populated from GitHub via the IssueContextLoader. */
  issue: {
    number: number;
    title: string;
    url: string;
    body: string;
    labels: string[];
  };
  /** Task Branch reused across Runs for this Issue. */
  taskBranch: string;
  /** Repository default branch resolved at the start of the Run. */
  baseBranch: string;
  /** Absolute path of the isolated Task worktree. */
  worktreePath: string;
  /** Existing draft Pull Request URL for this Task Branch, if any. */
  existingDraftPrUrl: string | undefined;
}

/**
 * One transcript event emitted by a Pi session. Events are append-only
 * and persisted to the Run's transcript JSONL file. Shape is intentionally
 * loose so the SDK boundary can evolve without forcing schema changes.
 */
export type PiSessionEvent = Record<string, unknown>;

/** Handler called for every transcript event emitted by a Pi session. */
export type PiSessionEventHandler = (event: PiSessionEvent) => Promise<void>;

/** Final state of a single Pi session invocation. */
export interface PiSessionResult {
  /** Process-style exit code. 0 means the agent ended without fatal error. */
  exitCode: number;
}

/**
 * Inputs passed to a freshly constructed Pi session.
 *
 * - `prompt`         : rendered, versioned phase prompt
 * - `promptVersion`  : opaque version tag for reviewability (e.g. "implement/v1")
 * - `facts`          : Issue / branch / worktree / PR lookup context
 * - `cwd`            : absolute path the session should treat as its CWD
 * - `env`            : worker environment to inherit (Pi Lot trusts local env)
 */
export interface PiSessionInput {
  prompt: string;
  promptVersion: string;
  facts: PiSessionFacts;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Abstraction over a single fresh Pi SDK session.
 *
 * `run()` is invoked exactly once per session. Tests inject a fake that
 * synthesises a sequence of events. Production wires this to a real
 * agent SDK in a later step.
 */
export interface PiSession {
  run(handler: PiSessionEventHandler): Promise<PiSessionResult>;
}

/**
 * Factory for fresh Pi sessions. The Implement Phase calls this exactly
 * once per `run()` so each invocation produces a brand-new session,
 * matching PRD #1: "Implement, Review, and Finalize each run in a fresh
 * Pi SDK session."
 */
export type PiSessionFactory = (input: PiSessionInput) => PiSession;

/** Facts derived from the Issue + GitHub, loaded into a fresh Pi session. */
export interface IssueContext {
  body: string;
  labels: string[];
  /** Draft PR URL for this Task Branch, if one already exists. */
  existingDraftPrUrl: string | undefined;
}

/**
 * Loader for the parts of the Issue that the Board gateway does not
 * already provide (body, labels, current draft PR for this branch).
 *
 * Production wires this to `gh issue view` + `gh pr list`; tests inject
 * a deterministic stub so no GitHub call is ever made.
 */
export type IssueContextLoader = (input: {
  task: Task;
  taskBranch: string;
}) => Promise<IssueContext>;

/** Request payload for moving a Board item to a new status value. */
export interface BoardStatusUpdateRequest {
  projectId: string;
  statusFieldId: string;
  boardItemId: string;
  /** Label as configured on the Board (e.g. "Implementing"). */
  statusValue: string;
}

/**
 * Write-side of the Board: move a single Project item to a new status.
 *
 * Production wires this to `gh api graphql` with the appropriate
 * `updateProjectV2ItemFieldValue` mutation; tests inject a fake that
 * just records the call. Kept separate from the Board gateway's
 * read-side so MVP integrations are easy to add per phase.
 */
export type BoardStatusUpdater = (
  req: BoardStatusUpdateRequest,
) => Promise<void>;

/** Workspace facts produced by the WorkspaceProvisioner for a Task. */
export interface WorkspaceFacts {
  repoPath: string;
  worktreePath: string;
  taskBranch: string;
  baseBranch: string;
}

/** Input passed to {@link ImplementPhase.run}. */
export interface ImplementPhaseInput {
  task: Task;
  run: Run;
  workspace: WorkspaceFacts;
}

/** Outcome returned by a Phase's `run()` method. */
export type PhaseOutcome =
  | {
      status: "succeeded";
      transcriptPath: string;
    }
  | {
      status: "failed";
      reason: string;
      transcriptPath: string;
    };

/** Shared dependencies wired into every Phase that the Conductor owns. */
export interface ImplementPhaseDeps {
  board: BoardConfig;
  runStore: RunStore;
  piSessionFactory: PiSessionFactory;
  boardStatusUpdater: BoardStatusUpdater;
  issueContextLoader: IssueContextLoader;
  /**
   * Environment the fresh Pi session inherits. Defaults to the worker
   * process environment (PRD #1 user story 38). Tests inject `{}` so they
   * never leak credentials into assertions.
   */
  env?: NodeJS.ProcessEnv;
}

/** Input passed to {@link ReviewPhase.run}. */
export interface ReviewPhaseInput {
  task: Task;
  run: Run;
  workspace: WorkspaceFacts;
}

/**
 * Shared dependencies wired into the Review Phase (issue #9).
 *
 * Same shape as {@link ImplementPhaseDeps} for now: each Phase is a
 * fresh Pi SDK session with the same seam (board, run store, session
 * factory, status updater, issue-context loader). The Review Phase
 * differs only in which Board status it sets and which prompt it
 * renders.
 */
export interface ReviewPhaseDeps {
  board: BoardConfig;
  runStore: RunStore;
  piSessionFactory: PiSessionFactory;
  boardStatusUpdater: BoardStatusUpdater;
  issueContextLoader: IssueContextLoader;
  /**
   * Environment the fresh Pi session inherits. Defaults to the worker
   * process environment (PRD #1 user story 38).
   */
  env?: NodeJS.ProcessEnv;
}
