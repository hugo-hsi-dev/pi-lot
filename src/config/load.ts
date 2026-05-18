import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { ConfigError } from "./errors.ts";
import type { PiLotConfig } from "./types.ts";

const DEFAULT_CONFIG_PATH = ".pi-lot.config.json";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_STATE_DIR = ".pi-lot-state";
const DEFAULT_WORKFLOW_DIR = ".workflow";

/**
 * Load and validate the Pi Lot configuration from disk.
 *
 * Behavior:
 * - If `path` is provided, that file is used directly.
 * - Otherwise, looks for `.pi-lot.config.json` in `cwd` only — no upward
 *   search of parent directories.
 * - Missing file, invalid JSON, or invalid fields throw {@link ConfigError}.
 *
 * All path-shaped fields are returned as absolute paths. `~` is expanded
 * to the user's home directory.
 */
export async function loadConfig(opts: {
  path?: string;
  cwd?: string;
} = {}): Promise<PiLotConfig> {
  const cwd = opts.cwd ?? process.cwd();
  const configPath = opts.path
    ? resolveUserPath(opts.path, cwd)
    : resolve(cwd, DEFAULT_CONFIG_PATH);

  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    throw new ConfigError(`Pi Lot config file not found at ${configPath}`, [
      `Create ${DEFAULT_CONFIG_PATH} in your working directory or pass --config <path>.`,
    ]);
  }

  let raw: unknown;
  try {
    raw = await file.json();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new ConfigError(`Pi Lot config file is not valid JSON: ${configPath}`, [
      detail,
    ]);
  }

  return validateConfig(raw, { cwd, configPath });
}

/**
 * Validate a parsed config object. Exposed for tests so we can run the
 * validation logic without touching the filesystem.
 */
export function validateConfig(
  raw: unknown,
  ctx: { cwd: string; configPath?: string },
): PiLotConfig {
  const issues: string[] = [];

  if (!isPlainObject(raw)) {
    throw new ConfigError(
      "Pi Lot config must be a JSON object at the top level.",
    );
  }

  const board = validateBoard(raw["board"], issues);
  const projectsDir = validateRequiredPath(
    raw["projectsDir"],
    "projectsDir",
    ctx.cwd,
    issues,
  );
  const stateDir = validateOptionalPath(
    raw["stateDir"],
    "stateDir",
    ctx.cwd,
    issues,
  ) ?? resolve(ctx.cwd, DEFAULT_STATE_DIR);

  const workflowDir = validateOptionalPath(
    raw["workflowDir"],
    "workflowDir",
    ctx.cwd,
    issues,
  ) ?? resolve(ctx.cwd, DEFAULT_WORKFLOW_DIR);

  const pollIntervalMs = validatePositiveInt(
    raw["pollIntervalMs"],
    "pollIntervalMs",
    DEFAULT_POLL_INTERVAL_MS,
    issues,
  );
  const concurrency = validatePositiveInt(
    raw["concurrency"],
    "concurrency",
    DEFAULT_CONCURRENCY,
    issues,
  );

  if (issues.length > 0) {
    throw new ConfigError("Pi Lot config is invalid.", issues);
  }

  return {
    board: board!,
    projectsDir: projectsDir!,
    stateDir,
    workflowDir,
    pollIntervalMs,
    concurrency,
  };
}

function validateBoard(value: unknown, issues: string[]) {
  if (value === undefined) {
    issues.push("Missing required field: board");
    return undefined;
  }
  if (!isPlainObject(value)) {
    issues.push("board must be an object");
    return undefined;
  }

  const owner = value["owner"];
  if (typeof owner !== "string" || owner.trim() === "") {
    issues.push("board.owner must be a non-empty string");
  }

  const projectNumber = value["projectNumber"];
  if (
    typeof projectNumber !== "number" ||
    !Number.isInteger(projectNumber) ||
    projectNumber <= 0
  ) {
    issues.push("board.projectNumber must be a positive integer");
  }

  const statusField = value["statusField"];
  if (typeof statusField !== "string" || statusField.trim() === "") {
    issues.push("board.statusField must be a non-empty string");
  }

  // `board.statusValues` is intentionally NOT validated. It used to map
  // Pi Lot phase keys to Board option labels, but Board status values
  // now come from workflow Task Definition filenames at runtime. A
  // legacy `statusValues` field in the JSON is silently ignored so
  // existing configs keep working during migration.

  if (
    typeof owner !== "string" ||
    typeof projectNumber !== "number" ||
    typeof statusField !== "string"
  ) {
    return undefined;
  }

  return {
    owner: owner.trim(),
    projectNumber,
    statusField: statusField.trim(),
  };
}

function validateRequiredPath(
  value: unknown,
  field: string,
  cwd: string,
  issues: string[],
): string | undefined {
  if (value === undefined) {
    issues.push(`Missing required field: ${field}`);
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${field} must be a non-empty string path`);
    return undefined;
  }
  return resolveUserPath(value, cwd);
}

function validateOptionalPath(
  value: unknown,
  field: string,
  cwd: string,
  issues: string[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${field} must be a non-empty string path when provided`);
    return undefined;
  }
  return resolveUserPath(value, cwd);
}

function validatePositiveInt(
  value: unknown,
  field: string,
  defaultValue: number,
  issues: string[],
): number {
  if (value === undefined || value === null) return defaultValue;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    issues.push(`${field} must be a positive integer when provided`);
    return defaultValue;
  }
  return value;
}

function resolveUserPath(p: string, cwd: string): string {
  let expanded = p;
  if (expanded.startsWith("~/") || expanded === "~") {
    expanded = expanded.replace(/^~/, homedir());
  }
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
