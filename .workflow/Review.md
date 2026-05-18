---
next: Finalize
---

# Review {{ISSUE_TITLE}}

Worktree `{{WORKTREE_PATH}}` on branch `{{TASK_BRANCH}}`.

Evaluate the diff against GitHub Issue #{{ISSUE_NUMBER}} ({{ISSUE_URL}}) and improve it if needed, bounded by the Issue scope.

## Process
- Inspect `git diff {{BASE_BRANCH}}...HEAD`.
- Flag and fix in-scope quality issues; leave out-of-scope items alone.
- Re-run tests before finishing.

## Rules
See [shared rules](./shared/prompt-rules.md).
