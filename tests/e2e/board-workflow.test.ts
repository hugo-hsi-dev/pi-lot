import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../../src/orchestrator/index.ts";
import { TaskRunner } from "../../src/tasks/index.ts";
import { SqliteWorkflowStore } from "../../src/state/index.ts";
import {
  buildWorkflowGraph,
  loadWorkflowDefinitions,
} from "../../src/workflow/index.ts";
import type { Candidate } from "../../src/board/index.ts";
import type { PiLotConfig } from "../../src/config/index.ts";
import type {
  PiSession,
  PiSessionFactory,
} from "../../src/tasks/index.ts";

const ISSUE_NUMBER = 99;
const OWNER = "octocat";
const REPO = "widget";

async function writeWorkflowDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pilot-e2e-"));
  await writeFile(
    join(dir, "Implement.md"),
    "---\nnext: Review\n---\n\n# Implement {{ISSUE_TITLE}}\n",
  );
  await writeFile(
    join(dir, "Review.md"),
    "---\nnext: Finalize\n---\n\n# Review {{ISSUE_TITLE}}\n",
  );
  await writeFile(
    join(dir, "Finalize.md"),
    "---\nnext: Ready for Review\n---\n\n# Finalize {{ISSUE_TITLE}}\n",
  );
  await mkdir(join(dir, "shared"), { recursive: true });
  await writeFile(
    join(dir, "shared", "prompt-rules.md"),
    "Shared rules (supporting doc; not a Task Definition).",
  );
  return dir;
}

interface BoardState {
  status: "Implement" | "Review" | "Finalize" | "Ready for Review";
}

describe("e2e Board workflow", () => {
  test("drives one Issue Implement -> Review -> Finalize -> Ready for Review across three ticks", async () => {
    const workflowDir = await writeWorkflowDir();
    const loaded = await loadWorkflowDefinitions({ workflowDir });
    const graph = buildWorkflowGraph({
      definitions: loaded.definitions,
      knownBoardStatuses: [
        "Implement",
        "Review",
        "Finalize",
        "Ready for Review",
      ],
    });

    const store = new SqliteWorkflowStore({ path: ":memory:" });

    // Fake Board: tracks the current status of the one Issue.
    const boardState: BoardState = { status: "Implement" };
    const gateway = {
      async pollEligibleCandidates(queueNames: readonly string[]): Promise<Candidate[]> {
        if (!queueNames.includes(boardState.status)) return [];
        const candidate: Candidate = {
          repository: { owner: OWNER, name: REPO },
          issueNumber: ISSUE_NUMBER,
          title: "End-to-end widget",
          url: `https://github.com/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}`,
          status: boardState.status,
          createdAt: "2026-01-01T00:00:00Z",
          projectItemId: "PVTI_e2e",
        };
        return [candidate];
      },
    };

    const transitionCalls: Array<{ projectItemId: string; toStatus: string }> = [];
    const transitionService = {
      async applyTransition(input: { projectItemId: string; toStatus: string }) {
        transitionCalls.push({ ...input });
        // The "Board" updates itself in response to the transition call.
        boardState.status = input.toStatus as BoardState["status"];
      },
    };

    const provisioner = {
      async provision(input: {
        owner: string;
        repo: string;
        issueNumber: number;
        expectedRemote: string;
      }) {
        return {
          kind: "provisioned" as const,
          repoPath: `/repos/${input.owner}/${input.repo}`,
          worktreePath: `/state/${input.owner}/${input.repo}/${input.issueNumber}`,
          taskBranch: `pi-lot/${input.owner}/${input.repo}/issue-${input.issueNumber}`,
          baseBranch: "main",
        };
      },
    };

    const piSessions: Array<{ taskDefinitionName: string; prompt: string }> = [];
    const piSessionFactory: PiSessionFactory = (input) => {
      piSessions.push({
        taskDefinitionName: input.taskDefinitionName,
        prompt: input.prompt,
      });
      const session: PiSession = {
        async run(handler) {
          await handler({ kind: "message", text: `done ${input.taskDefinitionName}` });
          return { exitCode: 0 };
        },
      };
      return session;
    };

    const logs: string[] = [];
    const logger = {
      log: (m: string) => logs.push(m),
      error: (m: string) => logs.push(`ERR:${m}`),
    };

    const runner = new TaskRunner({
      workflowGraph: graph,
      workspaceProvisioner: provisioner,
      issueContextLoader: async () => ({
        body: "Body of the Issue.",
        labels: [],
      }),
      piSessionFactory,
      transitionService,
      store,
      expectedRemoteFor: (c) =>
        `https://github.com/${c.repository.owner}/${c.repository.name}.git`,
      env: {},
      logger,
    });

    const config: PiLotConfig = {
      board: { owner: OWNER, projectNumber: 1, statusField: "Status" },
      projectsDir: "/projects",
      stateDir: "/state",
      workflowDir,
      pollIntervalMs: 30_000,
      concurrency: 5,
    };

    let n = 0;
    const orchestrator = new Orchestrator({
      config,
      workflowGraph: graph,
      gateway,
      store,
      runner,
      logger,
      clock: () => `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
      runIdFactory: () => `run-${++n}`,
    });

    // Tick 1: Implement
    await orchestrator.tick();
    await orchestrator.idle();

    expect(piSessions.map((s) => s.taskDefinitionName)).toEqual(["Implement"]);
    expect(transitionCalls).toEqual([
      { projectItemId: "PVTI_e2e", toStatus: "Review" },
    ]);
    expect(boardState.status).toBe("Review");
    expect(store.listActiveClaims()).toHaveLength(0);

    // Tick 2: Review
    await orchestrator.tick();
    await orchestrator.idle();

    expect(piSessions.map((s) => s.taskDefinitionName)).toEqual([
      "Implement",
      "Review",
    ]);
    expect(transitionCalls).toEqual([
      { projectItemId: "PVTI_e2e", toStatus: "Review" },
      { projectItemId: "PVTI_e2e", toStatus: "Finalize" },
    ]);
    expect(boardState.status).toBe("Finalize");

    // Tick 3: Finalize -> Ready for Review (terminal)
    await orchestrator.tick();
    await orchestrator.idle();

    expect(piSessions.map((s) => s.taskDefinitionName)).toEqual([
      "Implement",
      "Review",
      "Finalize",
    ]);
    expect(transitionCalls).toEqual([
      { projectItemId: "PVTI_e2e", toStatus: "Review" },
      { projectItemId: "PVTI_e2e", toStatus: "Finalize" },
      { projectItemId: "PVTI_e2e", toStatus: "Ready for Review" },
    ]);
    expect(boardState.status).toBe("Ready for Review");

    // Terminal notification logged.
    expect(
      logs.some(
        (l) => l.includes("terminal") && l.includes("Ready for Review"),
      ),
    ).toBe(true);

    // Tick 4: Issue is in a terminal column → no Task Definition matches →
    // gateway returns no candidates and nothing is dispatched.
    await orchestrator.tick();
    await orchestrator.idle();
    expect(piSessions).toHaveLength(3);
    expect(transitionCalls).toHaveLength(3);

    // One Run record per tick.
    const runIds = ["run-1", "run-2", "run-3"];
    for (const id of runIds) {
      const r = store.getRun(id);
      expect(r).not.toBeNull();
      expect(r!.status).toBe("succeeded");
    }
  });
});
