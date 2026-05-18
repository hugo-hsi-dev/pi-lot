import {
  FINALIZE_PROMPT_VERSION,
  renderFinalizePrompt,
} from "./prompts/finalize-v1.ts";
import {
  parseTerminalReport,
  type ParsedTerminalReport,
} from "./terminal-report.ts";
import type {
  ImplementPhaseDeps,
  ImplementPhaseInput,
  PhaseOutcome,
  PiSessionEvent,
  PiSessionFacts,
} from "./types.ts";
import type { Run, TerminalReport } from "../runs/index.ts";

/**
 * Loader for the repository's PR template body, if one exists.
 *
 * Production wires this to a filesystem read of one of the standard
 * GitHub PR template locations under the workspace (`.github/PULL_REQUEST_TEMPLATE.md`,
 * etc.). Tests inject a deterministic stub.
 *
 * Resolving to `null` means "no template available"; the Finalize prompt
 * then omits the template section instead of hallucinating one.
 */
export type PrTemplateLoader = (input: {
  worktreePath: string;
}) => Promise<string | null>;

/**
 * Deletes a successful Task worktree. Production wires this to the
 * WorkspaceProvisioner's cleanup; tests inject a recording stub.
 *
 * Failures are intentionally treated as non-fatal by the Finalize Phase
 * (see {@link FinalizePhase.run}); the agent's Terminal Report is the
 * authoritative signal that the handoff succeeded.
 */
export type DeleteWorktreeFn = (worktreePath: string) => Promise<void>;

/** Dependencies the Conductor wires into the Finalize Phase. */
export interface FinalizePhaseDeps extends ImplementPhaseDeps {
  prTemplateLoader: PrTemplateLoader;
  deleteWorktree: DeleteWorktreeFn;
}

/**
 * Finalize Phase (PRD #1 user stories 27-30, issue #10).
 *
 * Responsibilities owned here (not the agent):
 *  - Move the Board item to "Finalizing" before the fresh Pi session.
 *  - Build the {@link PiSessionFacts} bundle from the Task, the
 *    provisioned workspace, and the IssueContextLoader (no prior phase
 *    transcripts ever flow through here).
 *  - Render the versioned Finalize prompt, including the PR template
 *    body when one is available.
 *  - Start exactly one fresh Pi session per invocation and stream
 *    transcript events into the {@link RunStore}.
 *  - Parse the marker-delimited Terminal Report from the session events
 *    and validate it.
 *  - On a valid `ready-for-review` Terminal Report: move the Board item
 *    to "Ready for Review", record the report on the Run, and delete the
 *    Task worktree (best-effort).
 *  - On a missing / invalid Terminal Report or session failure: mark the
 *    Phase failed and leave the Board / worktree alone so the Conductor
 *    (issue #11) can route the Run to Needs Human.
 *
 * Out of scope (owned by the phase agent itself): ensuring PR open/
 * pushed/linked, marking the PR ready for review, following the PR
 * template body, emitting the Terminal Report.
 *
 * Out of scope (owned by other issues):
 *  - The Conductor wiring that flips the Run to needs-human on failure
 *    (issue #11).
 *  - The repository workspace cleanup function itself; this Phase only
 *    invokes the injected hook.
 */
export class FinalizePhase {
  private readonly deps: FinalizePhaseDeps;

  constructor(deps: FinalizePhaseDeps) {
    this.deps = deps;
  }

  /**
   * Run the Finalize Phase end-to-end for a single Task.
   *
   * Always resolves with a {@link PhaseOutcome}; agent or report
   * failures are reported via `status: "failed"` rather than thrown.
   */
  public async run(input: ImplementPhaseInput): Promise<PhaseOutcome> {
    const { task, run, workspace } = input;

    // 1. Board status -> Finalizing BEFORE the fresh session.
    await this.deps.boardStatusUpdater({
      projectId: task.projectId,
      statusFieldId: task.statusFieldId,
      boardItemId: task.boardItemId,
      statusValue: this.deps.board.statusValues.finalizing,
    });

    // 2. Issue context + PR template; both feed the fresh prompt.
    const issueContext = await this.deps.issueContextLoader({
      task,
      taskBranch: workspace.taskBranch,
    });
    const prTemplate = await this.deps.prTemplateLoader({
      worktreePath: workspace.worktreePath,
    });

    // 3. Build the fresh-session facts bundle. No prior transcripts flow.
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

    const prompt = renderFinalizePrompt({ facts, prTemplate });

    const session = this.deps.piSessionFactory({
      prompt,
      promptVersion: FINALIZE_PROMPT_VERSION,
      facts,
      cwd: workspace.worktreePath,
      env: this.deps.env ?? process.env,
    });

    // 4. Run the session, streaming events to the RunStore while we
    //    accumulate text for Terminal Report extraction.
    const collectedText: string[] = [];
    try {
      const sessionResult = await session.run(async (event) => {
        await this.deps.runStore.appendPhaseEvent(run.id, "finalize", event);
        const text = extractText(event);
        if (text) collectedText.push(text);
      });

      if (sessionResult.exitCode !== 0) {
        return await this.failPhase(
          run,
          `pi session exited with code ${sessionResult.exitCode}`,
        );
      }

      const parse = parseTerminalReport(collectedText.join("\n"));
      if (!parse.ok) {
        return await this.failPhase(
          run,
          `Terminal Report rejected: ${parse.reason}`,
        );
      }

      return await this.succeedPhase(run, task, workspace.worktreePath, parse.report);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return await this.failPhase(run, `pi session threw: ${reason}`);
    }
  }

  private async succeedPhase(
    run: Run,
    task: ImplementPhaseInput["task"],
    worktreePath: string,
    report: ParsedTerminalReport,
  ): Promise<PhaseOutcome> {
    // Strip the internal `ok` discriminator before persisting; the Run
    // Record stores the report shape verbatim.
    const persistedReport: TerminalReport = { ...report };

    const updated = await this.deps.runStore.completePhase(
      run.id,
      "finalize",
      { status: "succeeded", terminalReport: persistedReport },
    );

    if (report.status === "ready-for-review") {
      await this.deps.boardStatusUpdater({
        projectId: task.projectId,
        statusFieldId: task.statusFieldId,
        boardItemId: task.boardItemId,
        statusValue: this.deps.board.statusValues.readyForReview,
      });
      await this.deps.runStore.completeRun(run.id, {
        status: "ready-for-review",
        terminalReport: persistedReport,
      });
      // Worktree cleanup is best-effort: the Terminal Report has already
      // told us the handoff is complete, and PRD #1 keeps failed
      // worktrees only when the Run itself failed.
      try {
        await this.deps.deleteWorktree(worktreePath);
      } catch {
        // Intentionally swallow: PRD #1 says abnormal cleanup failures
        // should not retroactively fail a successful handoff. The Run
        // Record already reflects ready-for-review.
      }
    }
    return {
      status: "succeeded",
      transcriptPath: transcriptPathFor(updated),
    };
  }

  private async failPhase(run: Run, reason: string): Promise<PhaseOutcome> {
    const updated = await this.deps.runStore.completePhase(
      run.id,
      "finalize",
      { status: "failed" },
    );
    return {
      status: "failed",
      reason,
      transcriptPath: transcriptPathFor(updated),
    };
  }
}

/**
 * Pull human-readable text out of a transcript event so we can scan it
 * for the Terminal Report markers. We deliberately accept several
 * common SDK-style event shapes:
 *
 *   { kind: "message", text: "..." }
 *   { kind: "message", content: "..." }
 *   { type:  "...",    text: "..." }
 *   { delta:           "..." }       (streamed)
 *   { content: [ { type: "text", text: "..." }, ... ] }
 *
 * Anything else is ignored — the parser only needs to find the markers.
 */
function extractText(event: PiSessionEvent): string | undefined {
  const text = event["text"];
  if (typeof text === "string") return text;
  const content = event["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (part && typeof part === "object" && "text" in part) {
        const t = (part as Record<string, unknown>)["text"];
        if (typeof t === "string") parts.push(t);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  const delta = event["delta"];
  if (typeof delta === "string") return delta;
  return undefined;
}

function transcriptPathFor(run: Run): string {
  const phase = run.phases.find((p) => p.name === "finalize");
  if (!phase) {
    throw new Error(
      `Finalize Phase record missing on Run ${run.id} after completePhase`,
    );
  }
  return phase.transcriptPath;
}
