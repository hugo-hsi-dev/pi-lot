/**
 * Task-runner domain types.
 *
 * One Task Definition + one GitHub Issue + one fresh Pi session = one Run.
 *
 * These types are deliberately minimal and SDK-shaped so the {@link
 * TaskRunner} can be exercised in tests with a fake `PiSession` without
 * depending on any concrete agent SDK.
 */

/**
 * One transcript event emitted by a Pi session. Events are append-only
 * and persisted to the Run's transcript table. Shape is intentionally
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
 * - `prompt`         : rendered, versioned Task Definition prompt
 * - `taskDefinitionName` : Task Definition / queue name (e.g. "Implement")
 * - `cwd`            : absolute path the session should treat as its CWD
 * - `env`            : worker environment to inherit
 */
export interface PiSessionInput {
  prompt: string;
  taskDefinitionName: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Abstraction over a single fresh Pi SDK session.
 *
 * `run()` is invoked exactly once per session. Tests inject a fake that
 * synthesises a sequence of events. Production wires this to a real
 * agent SDK.
 */
export interface PiSession {
  run(handler: PiSessionEventHandler): Promise<PiSessionResult>;
}

/**
 * Factory for fresh Pi sessions. The Task Runner calls this exactly
 * once per `runTask()` so each invocation produces a brand-new session.
 */
export type PiSessionFactory = (input: PiSessionInput) => PiSession;

/** Facts loaded from GitHub for the Issue underlying a Task. */
export interface IssueContext {
  body: string;
  labels: string[];
}

/**
 * Loader for the parts of the Issue that the Board gateway does not
 * already provide (body, labels).
 *
 * Production wires this to `gh issue view`; tests inject a deterministic
 * stub so no GitHub call is ever made.
 */
export type IssueContextLoader = (input: {
  owner: string;
  repo: string;
  issueNumber: number;
}) => Promise<IssueContext>;

/**
 * Optional supplier of a Pull Request template body. Wired through the
 * Task Runner so a Task Definition prompt can render the template into a
 * `{{PR_TEMPLATE}}`-style placeholder if it asks for one. Unused in the
 * POC default workflow.
 */
export type PrTemplateLoader = () => Promise<string | undefined>;
