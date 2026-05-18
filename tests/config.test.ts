import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
      statusValues: {
        queued: "Queued",
        implementing: "Implementing",
        reviewing: "Reviewing",
        finalizing: "Finalizing",
        readyForReview: "Ready for Review",
        needsHuman: "Needs Human",
      },
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
    expect(cfg.board.statusValues.queued).toBe("Queued");
    expect(cfg.board.statusValues.needsHuman).toBe("Needs Human");
    expect(cfg.projectsDir).toBe("/tmp/projects");
    expect(cfg.stateDir).toBe("/tmp/pi-lot-state");
    expect(cfg.pollIntervalMs).toBe(15000);
    expect(cfg.concurrency).toBe(3);
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

  test("rejects missing status map keys", () => {
    const raw = makeValidConfig();
    delete (raw.board.statusValues as Record<string, unknown>).needsHuman;
    try {
      validateConfig(raw, { cwd: "/tmp" });
      expect(false).toBe(true);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues.join("\n")).toContain(
        "board.statusValues.needsHuman",
      );
    }
  });

  test("rejects non-string status map values", () => {
    const raw = makeValidConfig();
    (raw.board.statusValues as Record<string, unknown>).queued = 1;
    expect(() => validateConfig(raw, { cwd: "/tmp" })).toThrow(ConfigError);
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
      board: { owner: "", projectNumber: 0, statusField: "", statusValues: {} },
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
});
