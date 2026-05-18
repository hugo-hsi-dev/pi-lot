import { describe, expect, test } from "bun:test";
import {
  buildWorkflowGraph,
  type TaskDefinition,
} from "../../src/workflow/index.ts";

/**
 * Tests for the Workflow Graph resolver (issue #24).
 *
 * The graph derives Task Queue priorities and terminal statuses from a
 * set of Task Definitions plus the live Board status names. Smaller
 * priority numbers mean the queue is closer to handoff and should run
 * first (e.g., Finalize before Implement).
 */

function def(
  queue: string,
  next: string,
  promptBody = "body",
): TaskDefinition {
  return { queue, next, promptBody, filename: `${queue}.md` };
}

describe("buildWorkflowGraph", () => {
  test("derives queue priorities by shortest distance to a terminal status", () => {
    const graph = buildWorkflowGraph({
      definitions: [
        def("Implement", "Review"),
        def("Review", "Finalize"),
        def("Finalize", "Ready for Review"),
      ],
      knownBoardStatuses: [
        "Implement",
        "Review",
        "Finalize",
        "Ready for Review",
      ],
    });

    expect(graph.priorityOf("Finalize")).toBe(1);
    expect(graph.priorityOf("Review")).toBe(2);
    expect(graph.priorityOf("Implement")).toBe(3);
  });

  test("treats a `next` with no matching Task Definition as a terminal status", () => {
    const graph = buildWorkflowGraph({
      definitions: [
        def("Implement", "Review"),
        def("Review", "Finalize"),
        def("Finalize", "Ready for Review"),
      ],
      knownBoardStatuses: [
        "Implement",
        "Review",
        "Finalize",
        "Ready for Review",
      ],
    });

    expect(graph.terminalStatuses.has("Ready for Review")).toBe(true);
    expect(graph.terminalStatuses.has("Implement")).toBe(false);
    expect(graph.terminalStatuses.has("Review")).toBe(false);
    expect(graph.terminalStatuses.has("Finalize")).toBe(false);
  });

  test("throws when a definition's `next` is not in knownBoardStatuses", () => {
    expect(() =>
      buildWorkflowGraph({
        definitions: [def("Implement", "MysteryStatus")],
        knownBoardStatuses: ["Implement", "Review"],
      }),
    ).toThrow(/Implement\.md.*MysteryStatus/);
  });

  test("throws when a definition's queue (filename stem) is not in knownBoardStatuses", () => {
    expect(() =>
      buildWorkflowGraph({
        definitions: [def("Phantom", "Done")],
        knownBoardStatuses: ["Done"],
      }),
    ).toThrow(/Phantom\.md.*Phantom/);
  });

  test("throws when Task Definitions form a cycle (no terminal reachable)", () => {
    expect(() =>
      buildWorkflowGraph({
        definitions: [
          def("Implement", "Review"),
          def("Review", "Implement"),
        ],
        knownBoardStatuses: ["Implement", "Review"],
      }),
    ).toThrow(/cycle/i);
  });

  test("indexes Task Definitions by queue name for lookup", () => {
    const implement = def("Implement", "Review", "implement body");
    const review = def("Review", "Done", "review body");
    const graph = buildWorkflowGraph({
      definitions: [implement, review],
      knownBoardStatuses: ["Implement", "Review", "Done"],
    });

    expect(graph.definitions.get("Implement")).toBe(implement);
    expect(graph.definitions.get("Review")).toBe(review);
    expect(graph.definitions.get("Done")).toBeUndefined();
  });
});
