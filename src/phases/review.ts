import {
  REVIEW_PROMPT_VERSION,
  renderReviewPrompt,
} from "./prompts/review-v1.ts";
import type {
  PhaseOutcome,
  PiSessionFacts,
  ReviewPhaseDeps,
  ReviewPhaseInput,
} from "./types.ts";
import type { Run } from "../runs/index.ts";

/**
 * Review Phase (PRD #1 user stories 23-26, issue #9).
 *
 * Responsibilities owned here (not the agent):
 *  - Move the Board item to "Reviewing" before the fresh Pi session runs.
 *  - Build the {@link PiSessionFacts} bundle from the Task, the
 *    provisioned workspace, and the IssueContextLoader (which surfaces the
 *    existing draft PR URL produced by the Implement Phase).
 *  - Render the versioned Review prompt that enforces a single-pass
 *    review limited to Task scope.
 *  - Start exactly one fresh Pi session per invocation and stream
 *    transcript events into the {@link RunStore}.
 *  - Complete the "review" Phase record with succeeded/failed.
 *
 * Out of scope (owned by the phase agent itself): reading the PR diff,
 * running checks, making in-scope fixes, committing, pushing.
 *
 * Out of scope (owned by later issues / phases): Finalize (#10),
 * terminal-state Run flips (#11), worktree cleanup.
 */
export class ReviewPhase {
  private readonly deps: ReviewPhaseDeps;

  constructor(deps: ReviewPhaseDeps) {
    this.deps = deps;
  }

  /**
   * Run the Review Phase end-to-end for a single Task.
   *
   * The returned promise resolves with a {@link PhaseOutcome} regardless
   * of whether the underlying Pi session succeeded or failed; this method
   * does not throw on agent failure. It re-throws unexpected errors from
   * the Board status updater or the issue-context loader so the Conductor
   * can decide whether to retry or send the Run to Needs Human.
   */
  public async run(input: ReviewPhaseInput): Promise<PhaseOutcome> {
    const { task, run, workspace } = input;

    // Phase 1: move Board status -> Reviewing BEFORE the session runs.
    await this.deps.boardStatusUpdater({
      projectId: task.projectId,
      statusFieldId: task.statusFieldId,
      boardItemId: task.boardItemId,
      statusValue: this.deps.board.statusValues.reviewing,
    });

    // Phase 2: load Issue context (body, labels, existing draft PR URL).
    // The PR URL surfaces the diff target for the review session.
    const issueContext = await this.deps.issueContextLoader({
      task,
      taskBranch: workspace.taskBranch,
    });

    // Phase 3: build the fresh-session facts bundle. No Implement Phase
    // transcript ever flows through here.
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

    const prompt = renderReviewPrompt(facts);

    // Phase 4: start a fresh Pi session, stream events into the RunStore.
    const session = this.deps.piSessionFactory({
      prompt,
      promptVersion: REVIEW_PROMPT_VERSION,
      facts,
      cwd: workspace.worktreePath,
      env: this.deps.env ?? process.env,
    });

    try {
      const sessionResult = await session.run(async (event) => {
        await this.deps.runStore.appendPhaseEvent(run.id, "review", event);
      });

      if (sessionResult.exitCode === 0) {
        const updated = await this.deps.runStore.completePhase(
          run.id,
          "review",
          { status: "succeeded" },
        );
        return {
          status: "succeeded",
          transcriptPath: transcriptPathFor(updated),
        };
      }

      const updated = await this.deps.runStore.completePhase(
        run.id,
        "review",
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
        "review",
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
 * Read the Review Phase's transcript path off a Run snapshot.
 * `completePhase` guarantees the Phase record exists on return.
 */
function transcriptPathFor(run: Run): string {
  const phase = run.phases.find((p) => p.name === "review");
  if (!phase) {
    throw new Error(
      `Review Phase record missing on Run ${run.id} after completePhase`,
    );
  }
  return phase.transcriptPath;
}
