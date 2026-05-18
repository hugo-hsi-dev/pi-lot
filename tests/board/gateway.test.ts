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
  test("skips Queued non-Issue Board items with a warning and no Task", async () => {
    const stdout = graphqlResponse([
      draftItem({
        itemId: "PVTI_draft",
        status: "Queued",
        title: "design notes",
      }),
      prItem({
        itemId: "PVTI_pr",
        status: "Queued",
        number: 88,
        url: "https://github.com/octocat/widget/pull/88",
      }),
      issueItem({
        itemId: "PVTI_issue",
        status: "Queued",
        issue: { number: 11 },
      }),
    ]);
    const warnings: string[] = [];
    const { runner } = staticRunner(ok(stdout));
    const gateway = new BoardGateway(fakeBoard(), {
      gh: runner,
      warn: (line) => warnings.push(line),
    });

    const tasks = await gateway.pollQueuedTasks();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.issueNumber).toBe(11);
    expect(tasks[0]!.boardItemId).toBe("PVTI_issue");
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("PVTI_draft"))).toBe(true);
    expect(warnings.some((w) => w.includes("PVTI_pr"))).toBe(true);
    for (const w of warnings) {
      expect(w.toLowerCase()).toContain("non-issue");
    }
  });

  test("ignores Issue items that are not in the Queued status", async () => {
    const stdout = graphqlResponse([
      issueItem({
        itemId: "PVTI_a",
        status: "Implementing",
        issue: { number: 1 },
      }),
      issueItem({ itemId: "PVTI_b", status: "Queued", issue: { number: 2 } }),
      issueItem({
        itemId: "PVTI_c",
        status: "Ready for Review",
        issue: { number: 3 },
      }),
      issueItem({ itemId: "PVTI_d", issue: { number: 4 } }), // no status set
    ]);
    const warnings: string[] = [];
    const { runner } = staticRunner(ok(stdout));
    const gateway = new BoardGateway(fakeBoard(), {
      gh: runner,
      warn: (line) => warnings.push(line),
    });

    const tasks = await gateway.pollQueuedTasks();

    expect(tasks.map((t) => t.issueNumber)).toEqual([2]);
    expect(warnings).toHaveLength(0);
  });

  test("returns Queued Issue Tasks ordered oldest first by createdAt", async () => {
    const stdout = graphqlResponse([
      issueItem({
        itemId: "PVTI_newer",
        status: "Queued",
        issue: { number: 30, createdAt: "2026-05-10T00:00:00Z" },
      }),
      issueItem({
        itemId: "PVTI_oldest",
        status: "Queued",
        issue: { number: 10, createdAt: "2026-01-01T00:00:00Z" },
      }),
      issueItem({
        itemId: "PVTI_mid",
        status: "Queued",
        issue: { number: 20, createdAt: "2026-03-15T00:00:00Z" },
      }),
    ]);
    const { runner } = staticRunner(ok(stdout));
    const gateway = new BoardGateway(fakeBoard(), { gh: runner });

    const tasks = await gateway.pollQueuedTasks();

    expect(tasks.map((t) => t.issueNumber)).toEqual([10, 20, 30]);
  });

  test("surfaces GitHub Project permission errors with the gh auth refresh hint", async () => {
    const stderr =
      "GraphQL: Your token has not been granted the required scopes to execute this query. " +
      'The "projectV2" field requires the "read:project" scope.';
    const { runner } = staticRunner(fail(1, stderr));
    const gateway = new BoardGateway(fakeBoard(), { gh: runner });

    let caught: unknown;
    try {
      await gateway.pollQueuedTasks();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BoardError);
    const err = caught as BoardError;
    expect(err.kind).toBe("permission");
    expect(err.message).toContain("gh auth refresh -s project");
  });

  test("non-permission gh failures are reported as gh-failed without the auth hint", async () => {
    const { runner } = staticRunner(fail(1, "network unreachable"));
    const gateway = new BoardGateway(fakeBoard(), { gh: runner });

    let caught: unknown;
    try {
      await gateway.pollQueuedTasks();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BoardError);
    const err = caught as BoardError;
    expect(err.kind).toBe("gh-failed");
    expect(err.message).not.toContain("gh auth refresh");
  });

  test("treats non-JSON gh output as a malformed BoardError", async () => {
    const { runner } = staticRunner(ok("not json at all"));
    const gateway = new BoardGateway(fakeBoard(), { gh: runner });

    let caught: unknown;
    try {
      await gateway.pollQueuedTasks();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BoardError);
    expect((caught as BoardError).kind).toBe("malformed");
  });

  test("treats responses without projectV2 as malformed", async () => {
    const stdout = JSON.stringify({ data: { organization: null, user: null } });
    const { runner } = staticRunner(ok(stdout));
    const gateway = new BoardGateway(fakeBoard(), { gh: runner });

    let caught: unknown;
    try {
      await gateway.pollQueuedTasks();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BoardError);
    expect((caught as BoardError).kind).toBe("malformed");
  });

  test("treats Issue items with missing required fields as malformed", async () => {
    // Item is type=ISSUE and Queued but content has no createdAt / number.
    const stdout = graphqlResponse([
      {
        id: "PVTI_broken",
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
          // missing number, id, title, url, createdAt, repository
        },
      },
    ]);
    const { runner } = staticRunner(ok(stdout));
    const gateway = new BoardGateway(fakeBoard(), { gh: runner });

    let caught: unknown;
    try {
      await gateway.pollQueuedTasks();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BoardError);
    expect((caught as BoardError).kind).toBe("malformed");
  });

  test("invokes gh api graphql parameterised by the configured Board", async () => {
    const { runner, calls } = staticRunner(ok(graphqlResponse([])));
    const gateway = new BoardGateway(fakeBoard(), { gh: runner });

    await gateway.pollQueuedTasks();

    expect(calls).toHaveLength(1);
    const args = calls[0]!;
    expect(args[0]).toBe("api");
    expect(args[1]).toBe("graphql");
    // Variables are bound (not interpolated) so values can't be injected.
    expect(args).toContain("owner=octocat");
    expect(args).toContain("projectNumber=7");
    expect(args).toContain("statusField=Status");
  });

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
