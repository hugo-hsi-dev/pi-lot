import type { PiSessionFacts } from "../types.ts";
import {
  TERMINAL_REPORT_BEGIN,
  TERMINAL_REPORT_END,
} from "../terminal-report.ts";

/**
 * Versioned Finalize Phase prompt (PRD #1 user stories 27-30, issue #10).
 *
 * Like the Implement prompt, this is narrow on purpose: it gives the
 * fresh agent only Task-scope facts and instructs Finalize-Phase
 * responsibilities. It says NOTHING about Board / GitHub Project status
 * — that is Conductor-owned per ADR 0001 and PRD #1.
 *
 * The Finalize Phase ends with a marker-delimited Terminal Report block
 * that the Conductor parses as terminal truth for the Run. The markers
 * are imported from the parser module so prompt and parser cannot drift.
 *
 * Renaming or changing this file should bump the version tag.
 */

export const FINALIZE_PROMPT_VERSION = "finalize/v1";

export interface RenderFinalizePromptInput {
  facts: PiSessionFacts;
  /** Repository PR template body, or null if none was found. */
  prTemplate: string | null;
}

export function renderFinalizePrompt(input: RenderFinalizePromptInput): string {
  const { facts, prTemplate } = input;
  const { repository, issue, taskBranch, baseBranch, worktreePath } = facts;
  const repoSlug = `${repository.owner}/${repository.name}`;
  const issueRef = `${repoSlug}#${issue.number}`;
  const prLine = facts.existingDraftPrUrl
    ? `Existing pull request: ${facts.existingDraftPrUrl}. Ensure it is the one you finalize; do not create a duplicate.`
    : `No pull request was recorded for this task branch yet. Open one (linked to the issue) and then finalize it.`;
  const labels = issue.labels.length
    ? `Labels: ${issue.labels.join(", ")}.`
    : "";

  const templateSection =
    prTemplate && prTemplate.trim().length > 0
      ? [
          "",
          "PR template to follow (the repository convention for pull request bodies):",
          prTemplate.trim(),
        ]
      : [];

  const terminalReportInstruction = [
    "When you are done, end your output with a Terminal Report block in",
    "exactly this shape, on its own lines, with valid JSON between the markers:",
    "",
    TERMINAL_REPORT_BEGIN,
    `{`,
    `  "status": "ready-for-review" | "needs-human",`,
    `  "issue": { "owner": "${repository.owner}", "repo": "${repository.name}", "number": ${issue.number} },`,
    `  "prUrl": "<the pull request URL>",`,
    `  "summary": "<one short paragraph describing what you handed off>",`,
    `  "needsHumanReason": "<required only when status is needs-human>"`,
    `}`,
    TERMINAL_REPORT_END,
  ];

  const lines: string[] = [
    `You are the Finalize Phase agent for ${issueRef}.`,
    "",
    `Repository: ${repoSlug}`,
    `Issue: ${issueRef} - ${issue.title}`,
    `Issue URL: ${issue.url}`,
    `Task branch: ${taskBranch}`,
    `Base branch: ${baseBranch}`,
    `Worktree path (your working directory): ${worktreePath}`,
    labels,
    "",
    "Issue body:",
    issue.body,
    "",
    prLine,
    ...templateSection,
    "",
    "Your responsibilities:",
    "- Ensure the pull request exists, is pushed, and is linked to the issue.",
    "- If a PR template is provided above, make the pull request body follow it.",
    "- Mark the pull request ready for review (use `gh pr ready` on its number).",
    "- Do not modify code outside the scope of this issue.",
    "- Inherit the local environment for git, gh, and credentials.",
    "",
    ...terminalReportInstruction,
  ];

  return lines.filter((line) => line !== undefined).join("\n");
}
