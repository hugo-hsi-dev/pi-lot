import type { PiSessionFacts } from "../types.ts";

/**
 * Versioned Review Phase prompt (PRD #1 user stories 23-26, issue #9).
 *
 * The Review Phase runs in a fresh Pi SDK session that is independent
 * of the Implement Phase's session and transcript. The prompt:
 *
 *   - Gives the agent only Task-scope facts (repo, Issue, branch, PR URL,
 *     worktree).
 *   - Limits the phase to a single review pass — no iterative loop.
 *   - Restricts changes to the Task scope (this Issue).
 *   - Stays silent on Board / GitHub Project status (Conductor-owned per
 *     ADR 0001 and PRD #1).
 *
 * The version tag (`REVIEW_PROMPT_VERSION`) is exposed so prompt template
 * changes are reviewable in code review (PRD #1 user story 45). Renaming
 * or changing this file should bump the version.
 */

export const REVIEW_PROMPT_VERSION = "review/v1";

export function renderReviewPrompt(facts: PiSessionFacts): string {
  const { repository, issue, taskBranch, baseBranch, worktreePath } = facts;
  const repoSlug = `${repository.owner}/${repository.name}`;
  const issueRef = `${repoSlug}#${issue.number}`;
  const prLine = facts.existingDraftPrUrl
    ? `The draft pull request for this task branch is at ${facts.existingDraftPrUrl}. Read its diff with \`gh pr diff\` and review the implementation against the issue.`
    : `No draft pull request exists yet for this task branch. Inspect the local diff between ${baseBranch} and ${taskBranch} as the review surface.`;
  const labels = issue.labels.length
    ? `Labels: ${issue.labels.join(", ")}.`
    : "";

  return [
    `You are the Review Phase agent for ${issueRef}.`,
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
    "",
    "Your responsibilities:",
    "- Read the linked github issue to understand the requested change.",
    "- Read the PR diff and evaluate the implementation against the issue.",
    "- Perform exactly one pass: review, then make any necessary fixes. Do not iterate.",
    "- Fix problems directly within the scope of this issue only.",
    "- Run relevant checks (tests, type checks, linters) when practical.",
    "- Commit your fixes with clear messages.",
    "- Push the task branch to origin.",
    "",
    "Do not expand the scope beyond this issue. Do not modify unrelated files.",
    "This is a one pass review; once you have committed and pushed your fixes, end the session.",
    "Inherit the local environment for git, gh, package managers, and model credentials.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
