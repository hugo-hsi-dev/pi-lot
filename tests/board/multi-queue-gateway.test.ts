import { describe, expect, test } from "bun:test";
import {
  BoardError,
  type GhResult,
  type GhRunner,
} from "../../src/board/index.ts";
import { MultiQueueBoardGateway } from "../../src/board/multi-queue-gateway.ts";

interface FakeIssueNode {
  number: number;
  id: string;
  title: string;
  url: string;
  createdAt: string;
  repository: { owner: { login: string }; name: string };
}

function issueNode(overrides: Partial<FakeIssueNode> = {}): FakeIssueNode {
  return {
    number: 42,
    id: "I_kw_42",
    title: "Implement widget",
    url: "https://github.com/octocat/widget/issues/42",
    createdAt: "2026-04-01T12:00:00Z",
    repository: { owner: { login: "octocat" }, name: "widget" },
    ...overrides,
  };
}

function issueItem(opts: {
  itemId: string;
  status?: string;
  issue?: Partial<FakeIssueNode>;
}) {
  return {
    id: opts.itemId,
    type: "ISSUE",
    fieldValues: {
      nodes: opts.status
        ? [
            {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: opts.status,
              field: { name: "Status" },
            },
          ]
        : [],
    },
    content: {
      __typename: "Issue",
      ...issueNode(opts.issue ?? {}),
    },
  };
}

function draftItem(opts: { itemId: string; status?: string }) {
  return {
    id: opts.itemId,
    type: "DRAFT_ISSUE",
    fieldValues: {
      nodes: opts.status
        ? [
            {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: opts.status,
              field: { name: "Status" },
            },
          ]
        : [],
    },
    content: { __typename: "DraftIssue", title: "a note" },
  };
}

function prItem(opts: { itemId: string; status?: string }) {
  return {
    id: opts.itemId,
    type: "PULL_REQUEST",
    fieldValues: {
      nodes: opts.status
        ? [
            {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: opts.status,
              field: { name: "Status" },
            },
          ]
        : [],
    },
    content: {
      __typename: "PullRequest",
      number: 99,
      url: "https://github.com/octocat/widget/pull/99",
    },
  };
}

function graphqlResponse(items: unknown[]): string {
  return JSON.stringify({
    data: {
      organization: {
        projectV2: {
          id: "PVT_kwDOA",
          items: { nodes: items },
        },
      },
    },
  });
}

function ok(stdout: string): GhResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(code: number, stderr: string, stdout = ""): GhResult {
  return { exitCode: code, stdout, stderr };
}

function staticRunner(result: GhResult): {
  runner: GhRunner;
  calls: ReadonlyArray<readonly string[]>;
} {
  const calls: (readonly string[])[] = [];
  const runner: GhRunner = async (args) => {
    calls.push(args);
    return result;
  };
  return { runner, calls };
}

const BOARD = {
  owner: "octocat",
  projectNumber: 7,
  statusField: "Status",
};

describe("MultiQueueBoardGateway.pollEligibleCandidates", () => {
  test("queries the GitHub Project board and returns Issue candidates whose status is in the queue list", async () => {
    const stdout = graphqlResponse([
      issueItem({
        itemId: "PVTI_a",
        status: "Queued: Build",
        issue: { number: 1 },
      }),
    ]);
    const { runner, calls } = staticRunner(ok(stdout));
    const gateway = new MultiQueueBoardGateway(BOARD, { gh: runner });

    const candidates = await gateway.pollEligibleCandidates(["Queued: Build"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("api");
    expect(calls[0]![1]).toBe("graphql");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.issueNumber).toBe(1);
  });

  test("skips Board items whose content is not a GitHub Issue", async () => {
    const stdout = graphqlResponse([
      draftItem({ itemId: "PVTI_draft", status: "Queued: Build" }),
      prItem({ itemId: "PVTI_pr", status: "Queued: Build" }),
      issueItem({
        itemId: "PVTI_issue",
        status: "Queued: Build",
        issue: { number: 7 },
      }),
    ]);
    const warnings: string[] = [];
    const { runner } = staticRunner(ok(stdout));
    const gateway = new MultiQueueBoardGateway(BOARD, {
      gh: runner,
      warn: (line) => warnings.push(line),
    });

    const candidates = await gateway.pollEligibleCandidates(["Queued: Build"]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.issueNumber).toBe(7);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  test("ignores Board items in statuses that are not in the queue list", async () => {
    const stdout = graphqlResponse([
      issueItem({
        itemId: "PVTI_a",
        status: "Implementing",
        issue: { number: 1 },
      }),
      issueItem({
        itemId: "PVTI_b",
        status: "Queued: Build",
        issue: { number: 2 },
      }),
      issueItem({
        itemId: "PVTI_c",
        status: "Queued: Review",
        issue: { number: 3 },
      }),
      issueItem({ itemId: "PVTI_d", issue: { number: 4 } }),
    ]);
    const { runner } = staticRunner(ok(stdout));
    const gateway = new MultiQueueBoardGateway(BOARD, { gh: runner });

    const candidates = await gateway.pollEligibleCandidates([
      "Queued: Build",
      "Queued: Review",
    ]);

    expect(candidates.map((c) => c.issueNumber).sort()).toEqual([2, 3]);
  });

  test("preserves the source status string per candidate so the scheduler can route", async () => {
    const stdout = graphqlResponse([
      issueItem({
        itemId: "PVTI_a",
        status: "Queued: Build",
        issue: { number: 1 },
      }),
      issueItem({
        itemId: "PVTI_b",
        status: "Queued: Review",
        issue: { number: 2 },
      }),
    ]);
    const { runner } = staticRunner(ok(stdout));
    const gateway = new MultiQueueBoardGateway(BOARD, { gh: runner });

    const candidates = await gateway.pollEligibleCandidates([
      "Queued: Build",
      "Queued: Review",
    ]);

    const byIssue = new Map(candidates.map((c) => [c.issueNumber, c.status]));
    expect(byIssue.get(1)).toBe("Queued: Build");
    expect(byIssue.get(2)).toBe("Queued: Review");
  });

  test("preserves the GitHub Issue createdAt per candidate", async () => {
    const stdout = graphqlResponse([
      issueItem({
        itemId: "PVTI_a",
        status: "Queued: Build",
        issue: { number: 1, createdAt: "2026-01-02T03:04:05Z" },
      }),
    ]);
    const { runner } = staticRunner(ok(stdout));
    const gateway = new MultiQueueBoardGateway(BOARD, { gh: runner });

    const candidates = await gateway.pollEligibleCandidates(["Queued: Build"]);

    expect(candidates[0]!.createdAt).toBe("2026-01-02T03:04:05Z");
  });

  test("surfaces gh failures as a BoardError", async () => {
    const { runner } = staticRunner(fail(1, "network unreachable"));
    const gateway = new MultiQueueBoardGateway(BOARD, { gh: runner });

    let caught: unknown;
    try {
      await gateway.pollEligibleCandidates(["Queued: Build"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BoardError);
  });
});
