import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoadedWorkflow, TaskDefinition } from "./types.ts";

export interface LoadWorkflowDefinitionsInput {
  workflowDir: string;
}

/**
 * Read the workflow directory and return one Task Definition per
 * top-level `*.md` file. Nested files are supporting docs and are
 * ignored.
 */
export async function loadWorkflowDefinitions(
  input: LoadWorkflowDefinitionsInput,
): Promise<LoadedWorkflow> {
  const entries = await readdir(input.workflowDir, { withFileTypes: true });
  const definitions: TaskDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const filename = entry.name;
    const queue = filename.slice(0, -".md".length);
    const raw = await readFile(join(input.workflowDir, filename), "utf8");
    const parsed = parseTaskDefinition(raw, filename);
    definitions.push({ queue, ...parsed, filename });
  }
  return { definitions };
}

function parseTaskDefinition(
  raw: string,
  filename: string,
): { next: string; promptBody: string } {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new Error(
      `Task Definition ${filename}: missing frontmatter (file must start with '---')`,
    );
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    throw new Error(
      `Task Definition ${filename}: unterminated frontmatter (missing closing '---')`,
    );
  }
  const frontmatter: Record<string, string> = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(
        `Task Definition ${filename}: malformed frontmatter line (expected 'key: value'): ${JSON.stringify(line)}`,
      );
    }
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    frontmatter[key] = value;
  }
  const next = frontmatter["next"];
  if (!next) {
    throw new Error(
      `Task Definition ${filename}: required 'next' field is missing from frontmatter`,
    );
  }
  let body = lines.slice(closeIdx + 1).join("\n");
  if (body.startsWith("\n")) body = body.slice(1);
  return { next, promptBody: body };
}
