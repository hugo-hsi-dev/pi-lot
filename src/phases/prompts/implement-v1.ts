import type { PiSessionFacts } from "../types.ts";

/**
 * Versioned Implement Phase prompt (PRD #1 user story 19-22, issue #8 AC3-AC4).
 *
 * The prompt is intentionally narrow: it gives the agent only Task-scope
 * facts and instructs Implement Phase responsibilities. It says NOTHING
 * about Board / GitHub Project status — that is Conductor-owned per
 * ADR 0001 and PRD #1 implementation decisions.
 *
 * The version tag (`IMPLEMENT_PROMPT_VERSION`) is exposed so prompt
 * template changes are reviewable in code review (PRD #1 user story 45).
 *
 * Renaming or changing this file should bump the version.
 */

export const IMPLEMENT_PROMPT_VERSION = "implement/v1";

export function renderImplementPrompt(facts: PiSessionFacts): string {
  const { repository, issue, taskBranch, baseBranch, worktreePath } = facts;
  const repoSlug = `${repository.owner}/${repository.name}`;
  const issueRef = `${repoSlug}#${issue.number}`;
  const prLine = facts.existingDraftPrUrl
    ? `An existing draft pull request for this task branch is at ${facts.existingDraftPrUrl}. Update it instead of creating a new one.`
    : `No draft pull request exists yet for this task branch. Create one as a draft when you push.`;
  const labels = issue.labels.length
    ? `Labels: ${issue.labels.join(", ")}.`
    : "";

  return [
    `You are the Implement Phase agent for ${issueRef}.`,
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
    "- Read the linked GitHub issue and understand the requested change.",
    "- Make code changes within the scope of this issue.",
    "- Run relevant checks (tests, type checks, linters) when practical.",
    "- Commit meaningful checkpoints with clear messages.",
    "- Push the task branch to origin.",
    "- Create or update a draft pull request that links back to the issue.",
    "",
    "Stay within the scope of this single issue. Do not modify unrelated files.",
    "Inherit the local environment for git, gh, package managers, and model credentials.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
