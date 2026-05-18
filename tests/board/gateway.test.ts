import { describe, expect, test } from "bun:test";
import {
  BoardError,
  BoardGateway,
  type GhResult,
  type GhRunner,
} from "../../src/board/index.ts";
import type { BoardConfig } from "../../src/config/index.ts";

/** Standard fake config used by every test in this file. */
function fakeBoard(): BoardConfig {
  return {
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
  };
}

/**
 * GraphQL-shaped fixture builders. The Board gateway queries the Project
 * via `gh api graphql`; these helpers return what `gh` would print on
 * stdout for various scenarios.
 */

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

function draftItem(opts: { itemId: string; status?: string; title?: string }) {
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
    content: {
      __typename: "DraftIssue",
      title: opts.title ?? "A note",
    },
  };
}

function prItem(opts: {
  itemId: string;
  status?: string;
  number?: number;
  url?: string;
}) {
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
      number: opts.number ?? 99,
      url: opts.url ?? "https://github.com/octocat/widget/pull/99",
    },
  };
}

function graphqlResponse(items: unknown[]): string {
  return JSON.stringify({
    data: {
      organization: {
        projectV2: {
          id: "PVT_kwDOA",
          field: { id: "PVTSSF_status", name: "Status" },
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

/** Returns a runner that always yields the same fixed result. */
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

describe("BoardGateway.pollQueuedTasks", () => {
  test("returns Queued Issue items as Tasks with full identity", async () => {
    const stdout = graphqlResponse([
      issueItem({
        itemId: "PVTI_lADO_42",
        status: "Queued",
        issue: {
          number: 42,
          id: "I_kw_42",
          title: "Implement widget",
          url: "https://github.com/octocat/widget/issues/42",
          createdAt: "2026-04-01T12:00:00Z",
          repository: { owner: { login: "octocat" }, name: "widget" },
        },
      }),
    ]);
    const { runner } = staticRunner(ok(stdout));
    const gateway = new BoardGateway(fakeBoard(), { gh: runner });

    const tasks = await gateway.pollQueuedTasks();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual({
      repository: { owner: "octocat", name: "widget" },
      issueNumber: 42,
      issueId: "I_kw_42",
      title: "Implement widget",
      url: "https://github.com/octocat/widget/issues/42",
      boardItemId: "PVTI_lADO_42",
      projectId: "PVT_kwDOA",
      statusFieldId: "PVTSSF_status",
      createdAt: "2026-04-01T12:00:00Z",
    });
  });
});

// Helpers reused by upcoming tests
export {
  fakeBoard,
  graphqlResponse,
  issueItem,
  draftItem,
  prItem,
  ok,
  fail,
  staticRunner,
};
