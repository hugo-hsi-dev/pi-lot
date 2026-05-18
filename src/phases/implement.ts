import {
  IMPLEMENT_PROMPT_VERSION,
  renderImplementPrompt,
} from "./prompts/implement-v1.ts";
import type {
  ImplementPhaseDeps,
  ImplementPhaseInput,
  PhaseOutcome,
  PiSessionFacts,
} from "./types.ts";
import type { Run } from "../runs/index.ts";

/**
 * Implement Phase (PRD #1 user stories 19-22, issue #8).
 *
 * Responsibilities owned here (not the agent):
 *  - Move the Board item from "Queued" to "Implementing" before the
 *    fresh Pi session runs.
 *  - Build the {@link PiSessionFacts} bundle from the Task, the
 *    provisioned workspace, and the IssueContextLoader.
 *  - Render the versioned Implement prompt.
 *  - Start exactly one fresh Pi session per invocation and stream
 *    transcript events into the {@link RunStore}.
 *  - Complete the "implement" Phase record with succeeded/failed.
 *
 * Out of scope (owned by the phase agent itself): code edits, running
 * checks, committing, pushing, creating/updating the draft PR.
 *
 * Out of scope (owned by later issues / phases): Review (#9), Finalize
 * (#10), terminal-state Run flips, worktree cleanup.
 */
export class ImplementPhase {
  private readonly deps: ImplementPhaseDeps;

  constructor(deps: ImplementPhaseDeps) {
    this.deps = deps;
  }

  /**
   * Run the Implement Phase end-to-end for a single Task.
   *
   * The returned promise resolves with a {@link PhaseOutcome} regardless
   * of whether the underlying Pi session succeeded or failed; this method
   * does not throw on agent failure. It re-throws unexpected errors from
   * the Board status updater or the issue-context loader so the Conductor
   * can decide whether to retry or send the Run to Needs Human.
   */
  public async run(input: ImplementPhaseInput): Promise<PhaseOutcome> {
    const { task, run, workspace } = input;

    // Phase 1: move Board status Queued -> Implementing BEFORE the session.
    await this.deps.boardStatusUpdater({
      projectId: task.projectId,
      statusFieldId: task.statusFieldId,
      boardItemId: task.boardItemId,
      statusValue: this.deps.board.statusValues.implementing,
    });

    // Phase 2: load Issue context (body, labels, existing draft PR).
    const issueContext = await this.deps.issueContextLoader({
      task,
      taskBranch: workspace.taskBranch,
    });

    // Phase 3: build the fresh-session facts bundle. No prior phase
    // transcripts ever flow through here.
    const facts: PiSessionFacts = {
      repository: task.repository,
      issue: {
        number: task.issueNumber,
        title: task.title,
        url: task.url,
        body: issueContext.body,
        labels: issueContext.labels,
      },
      taskBranch: workspace.taskBranch,
      baseBranch: workspace.baseBranch,
      worktreePath: workspace.worktreePath,
      existingDraftPrUrl: issueContext.existingDraftPrUrl,
    };

    const prompt = renderImplementPrompt(facts);

    // Phase 4: start a fresh Pi session, stream events into the RunStore.
    const session = this.deps.piSessionFactory({
      prompt,
      promptVersion: IMPLEMENT_PROMPT_VERSION,
      facts,
      cwd: workspace.worktreePath,
      env: this.deps.env ?? process.env,
    });

    try {
      const sessionResult = await session.run(async (event) => {
        await this.deps.runStore.appendPhaseEvent(run.id, "implement", event);
      });

      if (sessionResult.exitCode === 0) {
        const updated = await this.deps.runStore.completePhase(
          run.id,
          "implement",
          { status: "succeeded" },
        );
        return {
          status: "succeeded",
          transcriptPath: transcriptPathFor(updated),
        };
      }

      const updated = await this.deps.runStore.completePhase(
        run.id,
        "implement",
        { status: "failed" },
      );
      return {
        status: "failed",
        reason: `pi session exited with code ${sessionResult.exitCode}`,
        transcriptPath: transcriptPathFor(updated),
      };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const updated = await this.deps.runStore.completePhase(
        run.id,
        "implement",
        { status: "failed" },
      );
      return {
        status: "failed",
        reason: `pi session threw: ${reason}`,
        transcriptPath: transcriptPathFor(updated),
      };
    }
  }
}

/**
 * Read the Implement Phase's transcript path off a Run snapshot.
 * `completePhase` guarantees the Phase record exists on return.
 */
function transcriptPathFor(run: Run): string {
  const phase = run.phases.find((p) => p.name === "implement");
  if (!phase) {
    throw new Error(
      `Implement Phase record missing on Run ${run.id} after completePhase`,
    );
  }
  return phase.transcriptPath;
}
