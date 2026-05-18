import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ConfigError,
  loadConfig,
  validateConfig,
} from "../src/config/index.ts";

function makeValidConfig() {
  return {
    board: {
      owner: "octocat",
      projectNumber: 7,
      statusField: "Status",
    },
    projectsDir: "/tmp/projects",
    stateDir: "/tmp/pi-lot-state",
    pollIntervalMs: 15000,
    concurrency: 3,
  };
}

describe("validateConfig", () => {
  test("accepts a complete valid config", () => {
    const cfg = validateConfig(makeValidConfig(), { cwd: "/tmp" });
    expect(cfg.board.owner).toBe("octocat");
    expect(cfg.board.projectNumber).toBe(7);
    expect(cfg.board.statusField).toBe("Status");
    expect(cfg.projectsDir).toBe("/tmp/projects");
    expect(cfg.stateDir).toBe("/tmp/pi-lot-state");
    expect(cfg.pollIntervalMs).toBe(15000);
    expect(cfg.concurrency).toBe(3);
  });

  test("accepts a config without board.statusValues (no longer required)", () => {
    const raw = makeValidConfig();
    // Already absent in the new shape; this test pins the behavior.
    expect("statusValues" in raw.board).toBe(false);
    const cfg = validateConfig(raw, { cwd: "/tmp" });
    expect(cfg.board.owner).toBe("octocat");
  });

  test("silently ignores legacy board.statusValues field for forward-compatibility", () => {
    const raw = makeValidConfig() as Record<string, unknown>;
    (raw.board as Record<string, unknown>).statusValues = {
      queued: "Queued",
      implementing: "Implementing",
      reviewing: "Reviewing",
      finalizing: "Finalizing",
      readyForReview: "Ready for Review",
      needsHuman: "Needs Human",
    };
    const cfg = validateConfig(raw, { cwd: "/tmp" });
    expect(cfg.board.owner).toBe("octocat");
    // The field is not exposed on BoardConfig anymore.
    expect((cfg.board as Record<string, unknown>).statusValues).toBeUndefined();
  });

  test("defaults workflowDir to <cwd>/.workflow when omitted", () => {
    const cfg = validateConfig(makeValidConfig(), { cwd: "/var/app" });
    expect(cfg.workflowDir).toBe("/var/app/.workflow");
  });

  test("honors an explicit workflowDir resolved against cwd", () => {
    const raw = makeValidConfig() as Record<string, unknown>;
    raw.workflowDir = "custom/workflows";
    const cfg = validateConfig(raw, { cwd: "/home/me" });
    expect(cfg.workflowDir).toBe("/home/me/custom/workflows");
  });

  test("expands ~ in workflowDir", () => {
    const raw = makeValidConfig() as Record<string, unknown>;
    raw.workflowDir = "~/my-workflows";
    const cfg = validateConfig(raw, { cwd: "/tmp" });
    expect(cfg.workflowDir).toBe(resolve(homedir(), "my-workflows"));
  });

  test("rejects empty-string workflowDir when provided", () => {
    const raw = makeValidConfig() as Record<string, unknown>;
    raw.workflowDir = "";
    expect(() => validateConfig(raw, { cwd: "/tmp" })).toThrow(ConfigError);
  });

  test("defaults pollIntervalMs and concurrency when omitted", () => {
    const raw = makeValidConfig();
    delete (raw as Record<string, unknown>).pollIntervalMs;
    delete (raw as Record<string, unknown>).concurrency;
    const cfg = validateConfig(raw, { cwd: "/tmp" });
    expect(cfg.pollIntervalMs).toBe(30000);
    expect(cfg.concurrency).toBe(5);
  });

  test("defaults stateDir to <cwd>/.pi-lot-state when omitted", () => {
    const raw = makeValidConfig();
    delete (raw as Record<string, unknown>).stateDir;
    const cfg = validateConfig(raw, { cwd: "/var/app" });
    expect(cfg.stateDir).toBe("/var/app/.pi-lot-state");
  });

  test("resolves relative projectsDir against cwd", () => {
    const raw = makeValidConfig();
    raw.projectsDir = "code/projects";
    const cfg = validateConfig(raw, { cwd: "/home/me" });
    expect(cfg.projectsDir).toBe("/home/me/code/projects");
  });

  test("rejects non-object top-level config", () => {
    expect(() => validateConfig(null, { cwd: "/tmp" })).toThrow(ConfigError);
    expect(() => validateConfig([], { cwd: "/tmp" })).toThrow(ConfigError);
    expect(() => validateConfig("hi", { cwd: "/tmp" })).toThrow(ConfigError);
  });

  test("rejects missing board", () => {
    const raw = makeValidConfig() as Record<string, unknown>;
    delete raw.board;
    try {
      validateConfig(raw, { cwd: "/tmp" });
      expect(false).toBe(true);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues.join("\n")).toContain("board");
    }
  });

  test("rejects missing projectsDir with an actionable message", () => {
    const raw = makeValidConfig() as Record<string, unknown>;
    delete raw.projectsDir;
    try {
      validateConfig(raw, { cwd: "/tmp" });
      expect(false).toBe(true);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues.join("\n")).toContain("projectsDir");
    }
  });

  test("rejects invalid projectNumber", () => {
    const raw = makeValidConfig();
    (raw.board as Record<string, unknown>).projectNumber = -1;
    expect(() => validateConfig(raw, { cwd: "/tmp" })).toThrow(ConfigError);

    const raw2 = makeValidConfig();
    (raw2.board as Record<string, unknown>).projectNumber = "7" as unknown as number;
    expect(() => validateConfig(raw2, { cwd: "/tmp" })).toThrow(ConfigError);
  });

  test("rejects empty owner / statusField strings", () => {
    const raw = makeValidConfig();
    raw.board.owner = "   ";
    expect(() => validateConfig(raw, { cwd: "/tmp" })).toThrow(ConfigError);

    const raw2 = makeValidConfig();
    raw2.board.statusField = "";
    expect(() => validateConfig(raw2, { cwd: "/tmp" })).toThrow(ConfigError);
  });

  test("rejects non-integer / non-positive pollIntervalMs and concurrency", () => {
    const raw = makeValidConfig();
    raw.pollIntervalMs = 0;
    expect(() => validateConfig(raw, { cwd: "/tmp" })).toThrow(ConfigError);

    const raw2 = makeValidConfig();
    raw2.concurrency = 1.5;
    expect(() => validateConfig(raw2, { cwd: "/tmp" })).toThrow(ConfigError);
  });

  test("collects multiple issues into a single ConfigError", () => {
    const raw = {
      board: { owner: "", projectNumber: 0, statusField: "" },
      projectsDir: "",
    };
    try {
      validateConfig(raw, { cwd: "/tmp" });
      expect(false).toBe(true);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues.length).toBeGreaterThan(3);
    }
  });
});

describe("loadConfig", () => {
  test("loads and validates a JSON file from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pilot-cfg-"));
    const path = join(dir, ".pi-lot.config.json");
    writeFileSync(path, JSON.stringify(makeValidConfig()));
    const cfg = await loadConfig({ path });
    expect(cfg.board.owner).toBe("octocat");
  });

  test("throws ConfigError when the file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pilot-cfg-"));
    await expect(
      loadConfig({ path: join(dir, "does-not-exist.json") }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("throws ConfigError when the file is not valid JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pilot-cfg-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ not json");
    await expect(loadConfig({ path })).rejects.toBeInstanceOf(ConfigError);
  });

  test("looks up the default config file in cwd when no path is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pilot-cfg-"));
    writeFileSync(
      join(dir, ".pi-lot.config.json"),
      JSON.stringify(makeValidConfig()),
    );
    const cfg = await loadConfig({ cwd: dir });
    expect(cfg.projectsDir).toBe(resolve("/tmp/projects"));
  });

  test("does NOT search parent directories for the config file", async () => {
    const parent = mkdtempSync(join(tmpdir(), "pilot-cfg-parent-"));
    writeFileSync(
      join(parent, ".pi-lot.config.json"),
      JSON.stringify(makeValidConfig()),
    );
    const child = join(parent, "nested");
    mkdirSync(child);
    await expect(loadConfig({ cwd: child })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});
