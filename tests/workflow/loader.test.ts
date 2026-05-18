import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowDefinitions } from "../../src/workflow/index.ts";

/**
 * Tests for the Workflow Definition loader (issue #24).
 *
 * The loader reads a workflow directory and returns one Task Definition
 * per top-level `*.md` file. Each Task Definition has a YAML-ish
 * frontmatter block (`---` delimited, simple `key: value` lines) and a
 * Markdown body. The filename stem is the Task Queue / Board status name
 * and must be preserved exactly (spaces, case).
 */

function makeWorkflowDir(): string {
  return mkdtempSync(join(tmpdir(), "pilot-workflow-"));
}

function writeFile(dir: string, relativePath: string, content: string): void {
  const fullPath = join(dir, relativePath);
  const parent = fullPath.substring(0, fullPath.lastIndexOf("/"));
  mkdirSync(parent, { recursive: true });
  writeFileSync(fullPath, content);
}

describe("loadWorkflowDefinitions", () => {
  test("discovers top-level *.md files in the workflow directory", async () => {
    const dir = makeWorkflowDir();
    writeFile(
      dir,
      "Implement.md",
      ["---", "next: Review", "---", "Implement the issue."].join("\n"),
    );
    writeFile(
      dir,
      "Review.md",
      ["---", "next: Finalize", "---", "Review the diff."].join("\n"),
    );

    const { definitions } = await loadWorkflowDefinitions({
      workflowDir: dir,
    });

    const queues = definitions.map((d) => d.queue).sort();
    expect(queues).toEqual(["Implement", "Review"]);
  });

  test("ignores nested *.md files (supporting docs, not Task Definitions)", async () => {
    const dir = makeWorkflowDir();
    writeFile(
      dir,
      "Implement.md",
      ["---", "next: Review", "---", "body"].join("\n"),
    );
    writeFile(dir, "shared/rules.md", "# shared rules, not a Task Def");
    writeFile(dir, "docs/notes/extra.md", "more supporting docs");

    const { definitions } = await loadWorkflowDefinitions({
      workflowDir: dir,
    });

    expect(definitions.map((d) => d.queue)).toEqual(["Implement"]);
  });

  test("preserves spaces and case in the filename stem as the Task Queue name", async () => {
    const dir = makeWorkflowDir();
    writeFile(
      dir,
      "Ready for Review.md",
      ["---", "next: Done", "---", "body"].join("\n"),
    );

    const { definitions } = await loadWorkflowDefinitions({
      workflowDir: dir,
    });

    expect(definitions).toHaveLength(1);
    expect(definitions[0]!.queue).toBe("Ready for Review");
    expect(definitions[0]!.filename).toBe("Ready for Review.md");
  });

  test("parses the required `next` field from frontmatter, preserving spaces", async () => {
    const dir = makeWorkflowDir();
    writeFile(
      dir,
      "Finalize.md",
      ["---", "next: Ready for Review", "---", "body"].join("\n"),
    );

    const { definitions } = await loadWorkflowDefinitions({
      workflowDir: dir,
    });

    expect(definitions[0]!.next).toBe("Ready for Review");
  });

  test("throws a descriptive error naming the filename when `next` is missing", async () => {
    const dir = makeWorkflowDir();
    writeFile(
      dir,
      "Implement.md",
      ["---", "owner: pi", "---", "body without next"].join("\n"),
    );

    await expect(
      loadWorkflowDefinitions({ workflowDir: dir }),
    ).rejects.toThrow(/Implement\.md.*next/);
  });

  test("throws a descriptive error when frontmatter is missing entirely", async () => {
    const dir = makeWorkflowDir();
    writeFile(dir, "Implement.md", "just a body, no frontmatter\n");

    await expect(
      loadWorkflowDefinitions({ workflowDir: dir }),
    ).rejects.toThrow(/Implement\.md.*frontmatter/);
  });

  test("throws a descriptive error when closing `---` is missing", async () => {
    const dir = makeWorkflowDir();
    writeFile(
      dir,
      "Implement.md",
      ["---", "next: Review", "body but no close"].join("\n"),
    );

    await expect(
      loadWorkflowDefinitions({ workflowDir: dir }),
    ).rejects.toThrow(/Implement\.md/);
  });

  test("preserves the prompt body after the closing `---`, trimming a leading newline", async () => {
    const dir = makeWorkflowDir();
    const body = "# Implement\n\nDo the work.\n\n- one\n- two\n";
    writeFile(
      dir,
      "Implement.md",
      ["---", "next: Review", "---", body].join("\n"),
    );

    const { definitions } = await loadWorkflowDefinitions({
      workflowDir: dir,
    });

    expect(definitions[0]!.promptBody).toBe(body);
  });
});
