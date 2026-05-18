import type { TerminalReport } from "../runs/index.ts";

/**
 * Terminal Report parser (PRD #1, issue #10).
 *
 * The Finalize Phase agent ends its session with a marker-delimited JSON
 * block that the Conductor treats as terminal truth for the Run. We
 * never parse the full transcript — we look for a single, stable
 * begin/end marker pair and extract the JSON payload between them.
 *
 * Markers are intentionally distinctive (multi-character sentinels) so
 * they cannot collide with normal agent output, and are exported so the
 * Finalize prompt and tests stay in sync.
 */

export const TERMINAL_REPORT_BEGIN = "<<<TERMINAL_REPORT>>>";
export const TERMINAL_REPORT_END = "<<<END_TERMINAL_REPORT>>>";

/** Stable, well-formed Terminal Report payload as recorded on a Run. */
export interface ParsedTerminalReport extends TerminalReport {
  status: "ready-for-review" | "needs-human";
  issue: { owner: string; repo: string; number: number };
  prUrl: string;
  summary: string;
}

export type ParseTerminalReportResult =
  | { ok: true; report: ParsedTerminalReport }
  | { ok: false; reason: string };

/**
 * Extract the Terminal Report from arbitrary transcript text.
 *
 * Returns `{ ok: true }` only when:
 *   - A `<<<TERMINAL_REPORT>>>...<<<END_TERMINAL_REPORT>>>` block exists,
 *   - The block body parses as JSON,
 *   - `status` is "ready-for-review" or "needs-human",
 *   - `issue.owner`, `issue.repo`, `issue.number` are present and typed,
 *   - `prUrl` and `summary` are non-empty strings,
 *   - For "needs-human", `needsHumanReason` is a non-empty string.
 *
 * If multiple blocks appear (e.g. the agent re-emitted a report after a
 * retry), the LAST block wins. This keeps reruns from being misled by an
 * earlier, stale "needs-human" block when the agent recovered.
 */
export function parseTerminalReport(
  transcript: string,
): ParseTerminalReportResult {
  const beginIdx = transcript.lastIndexOf(TERMINAL_REPORT_BEGIN);
  if (beginIdx === -1) {
    return {
      ok: false,
      reason: "Terminal Report not found: missing begin marker",
    };
  }
  const afterBegin = beginIdx + TERMINAL_REPORT_BEGIN.length;
  const endIdx = transcript.indexOf(TERMINAL_REPORT_END, afterBegin);
  if (endIdx === -1) {
    return {
      ok: false,
      reason: "Terminal Report incomplete: end marker missing after begin",
    };
  }
  const body = transcript.slice(afterBegin, endIdx).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: `Terminal Report body is not valid JSON: ${detail}`,
    };
  }
  if (!isObject(parsed)) {
    return { ok: false, reason: "Terminal Report body is not a JSON object" };
  }

  const status = parsed["status"];
  if (status !== "ready-for-review" && status !== "needs-human") {
    return {
      ok: false,
      reason: `Terminal Report status must be 'ready-for-review' or 'needs-human' (got ${String(status)})`,
    };
  }

  const issue = parsed["issue"];
  if (!isObject(issue)) {
    return {
      ok: false,
      reason: "Terminal Report is missing the issue identity object",
    };
  }
  const owner = issue["owner"];
  const repo = issue["repo"];
  const number = issue["number"];
  if (
    typeof owner !== "string" ||
    owner.length === 0 ||
    typeof repo !== "string" ||
    repo.length === 0 ||
    typeof number !== "number" ||
    !Number.isInteger(number)
  ) {
    return {
      ok: false,
      reason: "Terminal Report issue identity must include owner, repo, and integer number",
    };
  }

  const prUrl = parsed["prUrl"];
  if (typeof prUrl !== "string" || prUrl.length === 0) {
    return {
      ok: false,
      reason: "Terminal Report is missing prUrl (the PR URL handed off to the reviewer)",
    };
  }

  const summary = parsed["summary"];
  if (typeof summary !== "string" || summary.length === 0) {
    return {
      ok: false,
      reason: "Terminal Report is missing summary",
    };
  }

  let needsHumanReason: string | undefined;
  if (status === "needs-human") {
    const reason = parsed["needsHumanReason"];
    if (typeof reason !== "string" || reason.length === 0) {
      return {
        ok: false,
        reason: "Terminal Report with status 'needs-human' must include needsHumanReason",
      };
    }
    needsHumanReason = reason;
  }

  const report: ParsedTerminalReport = {
    status,
    issue: { owner, repo, number },
    prUrl,
    summary,
  };
  if (needsHumanReason) report.needsHumanReason = needsHumanReason;
  // Preserve forward-compatible extra fields so debugging information
  // an agent decides to attach is not silently dropped.
  for (const [k, v] of Object.entries(parsed)) {
    if (k in report) continue;
    report[k] = v;
  }
  return { ok: true, report };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
