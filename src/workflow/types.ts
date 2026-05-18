/**
 * A Task Definition is a top-level Markdown file in the workflow
 * directory. The filename stem (without `.md`) is the Task Queue name
 * and must equal a Board status string exactly. The YAML-ish
 * frontmatter at the top carries simple `key: value` pairs; `next` is
 * required and names the Board status that the agent should hand off to
 * when this Task is done. The body below the frontmatter is the prompt
 * template.
 */
export interface TaskDefinition {
  /** Board status name (= filename stem, preserved exactly). */
  queue: string;
  /** Board status name the agent hands off to when this Task succeeds. */
  next: string;
  /** Markdown body after the closing `---`, with the leading newline trimmed. */
  promptBody: string;
  /** Original filename, used in error messages. */
  filename: string;
}

export interface LoadedWorkflow {
  definitions: readonly TaskDefinition[];
}
