/**
 * Production composition root for the Orchestrator (issue #24).
 *
 * Wires together:
 *   - Workflow definitions loaded from `config.workflowDir`.
 *   - SQLite workflow state at `<config.stateDir>/pi-lot.sqlite`.
 *   - MultiQueueBoardGateway (read-side) + BoardTransitionService (write-side).
 *   - WorkspaceProvisioner backed by the subprocess git runner.
 *   - Real `gh`-driven IssueContextLoader and Pi CLI session factory.
 *   - Default worktree cleanup policy.
 *
 * Tests do NOT use this. They drive the Orchestrator + TaskRunner
 * directly with in-memory fakes.
 *
 * Trade-off (POC): we derive the set of known Board statuses from the
 * union of every Task Definition's `queue` and `next` rather than fetching
 * the live Project field option set. This avoids an extra GraphQL call
 * at startup. A typo in a `next` value will still be caught the moment
 * `BoardTransitionService` tries to apply the transition.
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  MultiQueueBoardGateway,
  type GhRunner,
} from "../board/index.ts";
import { defaultGhRunner } from "../board/gh.ts";
import type { PiLotConfig } from "../config/index.ts";
import { BoardTransitionService } from "../github/index.ts";
import { SqliteWorkflowStore } from "../state/index.ts";
import {
  TaskRunner,
  createGhIssueContextLoader,
  createPiCliSessionFactory,
} from "../tasks/index.ts";
import type {
  IssueContextLoader,
  PiSessionFactory,
} from "../tasks/index.ts";
import {
  SubprocessGitRunner,
  WorkspaceProvisioner,
  defaultWorktreeCleanup,
} from "../workspace/index.ts";
import {
  buildWorkflowGraph,
  loadWorkflowDefinitions,
} from "../workflow/index.ts";
import { Orchestrator, type OrchestratorLogger } from "./orchestrator.ts";

export interface BuildPiLotRuntimeInput {
  config: PiLotConfig;
  logger?: OrchestratorLogger;
  /** Overrides for tests / advanced wiring. */
  overrides?: {
    gh?: GhRunner;
    piSessionFactory?: PiSessionFactory;
    issueContextLoader?: IssueContextLoader;
  };
}

export interface PiLotRuntime {
  orchestrator: Orchestrator;
  store: SqliteWorkflowStore;
}

/**
 * Assemble the full Pi Lot runtime. The returned {@link Orchestrator}
 * is ready to `start({ signal })`.
 */
export async function buildPiLotRuntime(
  input: BuildPiLotRuntimeInput,
): Promise<PiLotRuntime> {
  const { config } = input;
  const logger: OrchestratorLogger = input.logger ?? {
    log: (m) => console.log(m),
    error: (m) => console.error(m),
    warn: (m) => console.warn(m),
  };

  const loaded = await loadWorkflowDefinitions({
    workflowDir: config.workflowDir,
  });
  const knownStatuses = new Set<string>();
  for (const def of loaded.definitions) {
    knownStatuses.add(def.queue);
    knownStatuses.add(def.next);
  }
  const graph = buildWorkflowGraph({
    definitions: loaded.definitions,
    knownBoardStatuses: [...knownStatuses],
  });

  await mkdir(config.stateDir, { recursive: true });
  const store = new SqliteWorkflowStore({
    path: join(config.stateDir, "pi-lot.sqlite"),
  });

  const gh: GhRunner = input.overrides?.gh ?? defaultGhRunner;
  const gateway = new MultiQueueBoardGateway(
    {
      owner: config.board.owner,
      projectNumber: config.board.projectNumber,
      statusField: config.board.statusField,
    },
    {
      gh,
      warn: (line) => (logger.warn ?? logger.log)(line),
    },
  );
  const transitionService = new BoardTransitionService(
    {
      owner: config.board.owner,
      projectNumber: config.board.projectNumber,
      statusField: config.board.statusField,
    },
    { gh },
  );

  const provisioner = new WorkspaceProvisioner({
    projectsDir: config.projectsDir,
    stateDir: config.stateDir,
    git: new SubprocessGitRunner(),
    warn: (line) => (logger.warn ?? logger.log)(line),
  });

  const piSessionFactory =
    input.overrides?.piSessionFactory ?? createPiCliSessionFactory();
  const issueContextLoader =
    input.overrides?.issueContextLoader ?? createGhIssueContextLoader({ gh });
  const cleanup = defaultWorktreeCleanup();

  const runner = new TaskRunner({
    workflowGraph: graph,
    workspaceProvisioner: provisioner,
    issueContextLoader,
    piSessionFactory,
    transitionService,
    store,
    cleanup,
    expectedRemoteFor: (c) =>
      `https://github.com/${c.repository.owner}/${c.repository.name}.git`,
    logger,
  });

  const orchestrator = new Orchestrator({
    config,
    workflowGraph: graph,
    gateway,
    store,
    runner,
    logger,
    runIdFactory: defaultRunIdFactory,
  });

  return { orchestrator, store };
}

function defaultRunIdFactory(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
