import { describe, expect, test } from "bun:test";
import {
  renderPrompt,
  UnknownPlaceholderError,
} from "../../src/workflow/prompt-renderer.ts";

/**
 * Tests for the Sandcastle-style prompt renderer (issue #24, PRD user
 * stories 13-16, 50).
 *
 * The renderer substitutes `{{UPPER_SNAKE_CASE}}` placeholders from a
 * context map. Anything else inside `{{ ... }}` is treated as literal
 * markdown (prompt templates sometimes show code examples that contain
 * double braces).
 */

describe("renderPrompt", () => {
  test("replaces a single {{ISSUE_TITLE}} placeholder", () => {
    const out = renderPrompt("Title: {{ISSUE_TITLE}}", {
      ISSUE_TITLE: "Add a frobnicator",
    });
    expect(out).toBe("Title: Add a frobnicator");
  });

  test("replaces every occurrence of a repeated placeholder", () => {
    const out = renderPrompt(
      "Issue {{ISSUE_NUMBER}} (see #{{ISSUE_NUMBER}})",
      { ISSUE_NUMBER: "42" },
    );
    expect(out).toBe("Issue 42 (see #42)");
  });

  test("throws UnknownPlaceholderError naming the placeholder when missing from context", () => {
    let caught: unknown;
    try {
      renderPrompt("Hello {{MISSING_NAME}}", { OTHER: "x" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownPlaceholderError);
    const err = caught as UnknownPlaceholderError;
    expect(err.placeholder).toBe("MISSING_NAME");
    expect(err.message).toContain("MISSING_NAME");
  });

  test("leaves {{lowercase}} as literal text", () => {
    const out = renderPrompt("see {{example}} here", {});
    expect(out).toBe("see {{example}} here");
  });

  test("leaves {{mixedCase}} as literal text", () => {
    const out = renderPrompt("see {{mixedCase}} and {{Other}} here", {});
    expect(out).toBe("see {{mixedCase}} and {{Other}} here");
  });

  test("leaves {{with spaces}} and {{HAS-DASH}} as literal text", () => {
    const out = renderPrompt(
      "code: {{with spaces}} and {{HAS-DASH}}",
      {},
    );
    expect(out).toBe("code: {{with spaces}} and {{HAS-DASH}}");
  });

  test("preserves a relative markdown link in surrounding text", () => {
    const template =
      "See [the spec](./docs/spec.md) for {{ISSUE_TITLE}}.\n\n```ts\nconst x = {{ y }};\n```\n";
    const out = renderPrompt(template, { ISSUE_TITLE: "Add a frobnicator" });
    expect(out).toBe(
      "See [the spec](./docs/spec.md) for Add a frobnicator.\n\n```ts\nconst x = {{ y }};\n```\n",
    );
  });
});
