import type { GhRunner } from "../board/index.ts";
import type { IssueContext, IssueContextLoader } from "./types.ts";

/**
 * Build a production {@link IssueContextLoader} that shells out to
 * `gh issue view --json body,labels` for a given repository + Issue
 * number.
 *
 * Tests do not use this; they inject a deterministic stub.
 */
export function createGhIssueContextLoader(opts: {
  gh: GhRunner;
}): IssueContextLoader {
  return async ({ owner, repo, issueNumber }): Promise<IssueContext> => {
    const result = await opts.gh([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      `${owner}/${repo}`,
      "--json",
      "body,labels",
    ]);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new Error(
        `gh issue view failed for ${owner}/${repo}#${issueNumber} (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
      );
    }
    const parsed = JSON.parse(result.stdout) as {
      body?: string;
      labels?: Array<{ name?: string }>;
    };
    return {
      body: parsed.body ?? "",
      labels: Array.isArray(parsed.labels)
        ? parsed.labels
            .map((l) => l?.name)
            .filter((n): n is string => typeof n === "string")
        : [],
    };
  };
}
