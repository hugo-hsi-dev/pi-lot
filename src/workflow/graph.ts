import type { TaskDefinition } from "./types.ts";

export interface BuildWorkflowGraphInput {
  definitions: readonly TaskDefinition[];
  knownBoardStatuses: readonly string[];
}

export interface WorkflowGraph {
  /** Task Definitions indexed by their queue (= Board status) name. */
  definitions: ReadonlyMap<string, TaskDefinition>;
  /**
   * Board statuses that are referenced by some `def.next` but have no
   * matching Task Definition. The agent hands off into these statuses
   * and the Conductor leaves them alone.
   */
  terminalStatuses: ReadonlySet<string>;
  /**
   * Priority of a queue is the shortest distance (in def edges) from
   * the queue to a terminal status. Smaller = higher priority.
   */
  priorityOf(queue: string): number;
}

export function buildWorkflowGraph(
  input: BuildWorkflowGraphInput,
): WorkflowGraph {
  const known = new Set(input.knownBoardStatuses);
  for (const d of input.definitions) {
    if (!known.has(d.queue)) {
      throw new Error(
        `Task Definition ${d.filename}: queue ${JSON.stringify(
          d.queue,
        )} is not a known Board status`,
      );
    }
    if (!known.has(d.next)) {
      throw new Error(
        `Task Definition ${d.filename}: 'next' status ${JSON.stringify(
          d.next,
        )} is not a known Board status`,
      );
    }
  }

  const definitions = new Map<string, TaskDefinition>();
  for (const d of input.definitions) {
    definitions.set(d.queue, d);
  }

  // Terminal statuses: referenced by some `next` but not themselves a queue.
  const terminalStatuses = new Set<string>();
  for (const d of input.definitions) {
    if (!definitions.has(d.next)) {
      terminalStatuses.add(d.next);
    }
  }

  // Walk each queue to its terminal status, counting edges. If we
  // revisit a queue on the way, the workflow has a cycle and no
  // terminal is reachable.
  const priorities = new Map<string, number>();
  for (const [queue] of definitions) {
    const visited = new Set<string>();
    let cur = queue;
    let steps = 0;
    while (definitions.has(cur)) {
      if (visited.has(cur)) {
        throw new Error(
          `Workflow has a cycle reachable from ${JSON.stringify(
            queue,
          )} (visited ${JSON.stringify(cur)} twice)`,
        );
      }
      visited.add(cur);
      const d = definitions.get(cur)!;
      steps += 1;
      cur = d.next;
    }
    priorities.set(queue, steps);
  }

  return {
    definitions,
    terminalStatuses,
    priorityOf(queue: string): number {
      const p = priorities.get(queue);
      if (p === undefined) {
        throw new Error(`No Task Definition for queue ${JSON.stringify(queue)}`);
      }
      return p;
    },
  };
}
