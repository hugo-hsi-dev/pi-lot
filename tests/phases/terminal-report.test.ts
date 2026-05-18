import { describe, expect, test } from "bun:test";
import {
  parseTerminalReport,
  TERMINAL_REPORT_BEGIN,
  TERMINAL_REPORT_END,
} from "../../src/phases/terminal-report.ts";

/**
 * Tests for the Terminal Report parser (issue #10).
 *
 * The Finalize Phase agent ends its session with a parseable Terminal
 * Report block. We do not parse the whole transcript; we just extract the
 * marker-delimited JSON payload and validate its required fields.
 *
 * The accepted shape (MVP) is:
 *
 *   <<<TERMINAL_REPORT>>>
 *   { "status": "ready-for-review" | "needs-human", "issue": {...},
 *     "prUrl": "...", "summary": "...", "needsHumanReason"?: "..." }
 *   <<<END_TERMINAL_REPORT>>>
 *
 * Tests assert observable behavior only: what the parser accepts, what it
 * rejects, and what it returns. The marker constants are exported so the
 * Finalize prompt and Pi session producers can stay in sync without
 * hardcoding strings.
 */

const VALID_BLOCK = [
  TERMINAL_REPORT_BEGIN,
  JSON.stringify({
    status: "ready-for-review",
    issue: { owner: "octocat", repo: "widget", number: 42 },
    prUrl: "https://github.com/octocat/widget/pull/19",
    summary: "Implemented frobnicator and finalized PR.",
  }),
  TERMINAL_REPORT_END,
].join("\n");

describe("parseTerminalReport", () => {
  test("parses a valid ready-for-review report from a marker-delimited block", () => {
    const transcript = `Some chatter from the agent\n${VALID_BLOCK}\ntrailing line`;
    const result = parseTerminalReport(transcript);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.status).toBe("ready-for-review");
      expect(result.report.issue).toEqual({
        owner: "octocat",
        repo: "widget",
        number: 42,
      });
      expect(result.report.prUrl).toBe(
        "https://github.com/octocat/widget/pull/19",
      );
      expect(result.report.summary).toBe(
        "Implemented frobnicator and finalized PR.",
      );
    }
  });

  test("parses a valid needs-human report and preserves the reason", () => {
    const block = [
      TERMINAL_REPORT_BEGIN,
      JSON.stringify({
        status: "needs-human",
        issue: { owner: "octocat", repo: "widget", number: 42 },
        prUrl: "https://github.com/octocat/widget/pull/19",
        summary: "Could not mark PR ready for review; merge conflict.",
        needsHumanReason: "merge conflict on base branch",
      }),
      TERMINAL_REPORT_END,
    ].join("\n");
    const result = parseTerminalReport(`${block}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.status).toBe("needs-human");
      expect(result.report.needsHumanReason).toBe(
        "merge conflict on base branch",
      );
    }
  });

  test("rejects a transcript missing the terminal report block", () => {
    const result = parseTerminalReport("agent said some things but never reported");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/missing|not found|no.*report/i);
    }
  });

  test("rejects an unterminated block (begin marker but no end marker)", () => {
    const transcript = `${TERMINAL_REPORT_BEGIN}\n{"status":"ready-for-review"}`;
    const result = parseTerminalReport(transcript);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/end|unterminated|incomplete/i);
    }
  });

  test("rejects a block whose body is not valid JSON", () => {
    const transcript = [
      TERMINAL_REPORT_BEGIN,
      "{ not json at all",
      TERMINAL_REPORT_END,
    ].join("\n");
    const result = parseTerminalReport(transcript);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/json/i);
    }
  });

  test("rejects a block whose status is not a known value", () => {
    const transcript = [
      TERMINAL_REPORT_BEGIN,
      JSON.stringify({
        status: "almost-done",
        issue: { owner: "o", repo: "r", number: 1 },
        prUrl: "https://github.com/o/r/pull/1",
        summary: "x",
      }),
      TERMINAL_REPORT_END,
    ].join("\n");
    const result = parseTerminalReport(transcript);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/status/i);
    }
  });

  test("rejects a block missing required fields (no prUrl)", () => {
    const transcript = [
      TERMINAL_REPORT_BEGIN,
      JSON.stringify({
        status: "ready-for-review",
        issue: { owner: "o", repo: "r", number: 1 },
        summary: "x",
      }),
      TERMINAL_REPORT_END,
    ].join("\n");
    const result = parseTerminalReport(transcript);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/prUrl|pr url|pull request url/i);
    }
  });

  test("rejects a block missing the issue identity", () => {
    const transcript = [
      TERMINAL_REPORT_BEGIN,
      JSON.stringify({
        status: "ready-for-review",
        prUrl: "https://github.com/o/r/pull/1",
        summary: "x",
      }),
      TERMINAL_REPORT_END,
    ].join("\n");
    const result = parseTerminalReport(transcript);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/issue/i);
    }
  });

  test("rejects a needs-human report missing needsHumanReason", () => {
    const transcript = [
      TERMINAL_REPORT_BEGIN,
      JSON.stringify({
        status: "needs-human",
        issue: { owner: "o", repo: "r", number: 1 },
        prUrl: "https://github.com/o/r/pull/1",
        summary: "x",
      }),
      TERMINAL_REPORT_END,
    ].join("\n");
    const result = parseTerminalReport(transcript);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/needsHumanReason|reason/i);
    }
  });

  test("picks the LAST report block if multiple appear, so retries don't get short-circuited by an earlier stale block", () => {
    const first = [
      TERMINAL_REPORT_BEGIN,
      JSON.stringify({
        status: "needs-human",
        issue: { owner: "o", repo: "r", number: 1 },
        prUrl: "https://github.com/o/r/pull/1",
        summary: "early",
        needsHumanReason: "stale",
      }),
      TERMINAL_REPORT_END,
    ].join("\n");
    const second = [
      TERMINAL_REPORT_BEGIN,
      JSON.stringify({
        status: "ready-for-review",
        issue: { owner: "o", repo: "r", number: 1 },
        prUrl: "https://github.com/o/r/pull/1",
        summary: "final",
      }),
      TERMINAL_REPORT_END,
    ].join("\n");
    const result = parseTerminalReport(`${first}\nintermission\n${second}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.status).toBe("ready-for-review");
      expect(result.report.summary).toBe("final");
    }
  });
});
