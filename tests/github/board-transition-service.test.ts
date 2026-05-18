import { describe, expect, test } from "bun:test";
import type { GhResult, GhRunner } from "../../src/board/index.ts";
import { BoardTransitionService } from "../../src/github/board-transition-service.ts";

const BOARD = {
  owner: "octocat",
  projectNumber: 7,
  statusField: "Status",
};

interface ScriptedCall {
  args: readonly string[];
  result: GhResult;
}

function optionsResponse(
  options: ReadonlyArray<{ id: string; name: string }>,
  ids: { projectId?: string; fieldId?: string } = {},
): GhResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      data: {
        organization: {
          projectV2: {
            id: ids.projectId ?? "PVT_kwDOA",
            field: { id: ids.fieldId ?? "PVTSSF_status", options },
          },
        },
      },
    }),
    stderr: "",
  };
}

function mutationOk(): GhResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "x" } } },
    }),
    stderr: "",
  };
}

function scriptedRunner(handler: (args: readonly string[]) => GhResult): {
  runner: GhRunner;
  calls: ScriptedCall[];
} {
  const calls: ScriptedCall[] = [];
  const runner: GhRunner = async (args) => {
    const result = handler(args);
    calls.push({ args, result });
    return result;
  };
  return { runner, calls };
}

function isOptionsQuery(args: readonly string[]): boolean {
  const queryArg = args.find((a) => a.startsWith("query=")) ?? "";
  // Options query has GraphQL `query(...)`; mutation has `mutation(...)`.
  const body = queryArg.slice("query=".length).trimStart();
  return body.startsWith("query");
}

function isMutation(args: readonly string[]): boolean {
  const queryArg = args.find((a) => a.startsWith("query=")) ?? "";
  const body = queryArg.slice("query=".length).trimStart();
  return body.startsWith("mutation");
}

describe("BoardTransitionService.applyTransition", () => {
  test("first call queries Status field options then issues the mutation", async () => {
    const { runner, calls } = scriptedRunner((args) => {
      if (isOptionsQuery(args)) {
        return optionsResponse([
          { id: "opt_impl", name: "Implementing" },
          { id: "opt_review", name: "Reviewing" },
        ]);
      }
      return mutationOk();
    });
    const svc = new BoardTransitionService(BOARD, { gh: runner });

    await svc.applyTransition({
      projectItemId: "PVTI_item",
      toStatus: "Reviewing",
    });

    expect(calls).toHaveLength(2);
    expect(isOptionsQuery(calls[0]!.args)).toBe(true);
    expect(isMutation(calls[1]!.args)).toBe(true);
  });

  test("second call with a different toStatus reuses the cached options and only runs the mutation", async () => {
    const { runner, calls } = scriptedRunner((args) => {
      if (isOptionsQuery(args)) {
        return optionsResponse([
          { id: "opt_impl", name: "Implementing" },
          { id: "opt_review", name: "Reviewing" },
          { id: "opt_done", name: "Done" },
        ]);
      }
      return mutationOk();
    });
    const svc = new BoardTransitionService(BOARD, { gh: runner });

    await svc.applyTransition({
      projectItemId: "PVTI_item",
      toStatus: "Reviewing",
    });
    await svc.applyTransition({
      projectItemId: "PVTI_item",
      toStatus: "Done",
    });

    const optionsCalls = calls.filter((c) => isOptionsQuery(c.args));
    const mutationCalls = calls.filter((c) => isMutation(c.args));
    expect(optionsCalls).toHaveLength(1);
    expect(mutationCalls).toHaveLength(2);
  });

  test("throws a descriptive error for an unknown toStatus, and the cache survives so later valid calls do not re-query", async () => {
    const { runner, calls } = scriptedRunner((args) => {
      if (isOptionsQuery(args)) {
        return optionsResponse([
          { id: "opt_impl", name: "Implementing" },
          { id: "opt_review", name: "Reviewing" },
        ]);
      }
      return mutationOk();
    });
    const svc = new BoardTransitionService(BOARD, { gh: runner });

    let caught: unknown;
    try {
      await svc.applyTransition({
        projectItemId: "PVTI_item",
        toStatus: "Nope",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("Nope");
    expect(msg).toContain("Implementing");
    expect(msg).toContain("Reviewing");

    // Cache is not poisoned: a follow-up valid call hits the mutation without
    // re-running the options query.
    await svc.applyTransition({
      projectItemId: "PVTI_item",
      toStatus: "Implementing",
    });
    const optionsCalls = calls.filter((c) => isOptionsQuery(c.args));
    expect(optionsCalls).toHaveLength(1);
  });

  test("mutation payload carries the resolved option id and the projectItemId", async () => {
    const { runner, calls } = scriptedRunner((args) => {
      if (isOptionsQuery(args)) {
        return optionsResponse([
          { id: "opt_review", name: "Reviewing" },
        ]);
      }
      return mutationOk();
    });
    const svc = new BoardTransitionService(BOARD, { gh: runner });

    await svc.applyTransition({
      projectItemId: "PVTI_target",
      toStatus: "Reviewing",
    });

    const mutationCall = calls.find((c) => isMutation(c.args))!;
    expect(mutationCall.args).toContain("optionId=opt_review");
    expect(mutationCall.args).toContain("itemId=PVTI_target");
  });
});
