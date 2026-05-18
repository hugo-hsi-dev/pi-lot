import type { Task } from "../board/index.ts";
import type { RunStore } from "../runs/index.ts";
import type { RunRunner } from "../conductor/scheduler.ts";
import type { ImplementPhase } from "./implement.ts";
import type { WorkspaceFacts } from "./types.ts";

/**
 * Hook that turns a Task into a {@link WorkspaceFacts} bundle, or
 * `null` if the Task should be skipped (e.g. workspace remote-mismatch).
 *
 * Production wires this to the {@link WorkspaceProvisioner} from
 * `src/workspace/`; tests inject a stub.
 *
 * The hook lives at the Conductor wiring layer rather than inside the
 * Implement Phase so the Provisioner remains independent of any single
 * Phase implementation.
 */
export type ProvisionWorkspaceFn = (
  task: Task,
) => Promise<WorkspaceFacts | null>;

export interface ImplementPhaseRunRunnerOptions {
  runStore: RunStore;
  provisionWorkspace: ProvisionWorkspaceFn;
  implementPhase: ImplementPhase;
}

/**
 * Adapt the Implement Phase to the {@link RunRunner} seam the
 * {@link Scheduler} expects.
 *
 * The Scheduler does not know about Phases — it only sees a `Task` and a
 * promise that resolves when the Run is done. This adapter:
 *
 * 1. Provisions a workspace for the Task. If provisioning is skipped
 *    (remote-mismatch policy), the adapter exits without creating a Run
 *    Record; the Scheduler frees the slot for other Tasks.
 * 2. Creates a Run Record for the Task.
 * 3. Hands control to the {@link ImplementPhase}.
 *
 * In MVP this is the only Phase wired in; Review (#9) and Finalize (#10)
 * will be chained off the Implement Phase's outcome in later issues.
 */
export function createImplementPhaseRunRunner(
  opts: ImplementPhaseRunRunnerOptions,
): RunRunner {
  return async (task: Task) => {
    const workspace = await opts.provisionWorkspace(task);
    if (!workspace) return;

    const run = await opts.runStore.createRun({
      taskRef: {
        owner: task.repository.owner,
        repo: task.repository.name,
        issueNumber: task.issueNumber,
      },
      boardItemId: task.boardItemId,
      taskBranch: workspace.taskBranch,
      worktreePath: workspace.worktreePath,
    });

    await opts.implementPhase.run({ task, run, workspace });
  };
}
