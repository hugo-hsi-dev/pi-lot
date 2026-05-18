import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli/args.ts";

describe("parseArgs", () => {
  test("returns an empty result with no args", () => {
    expect(parseArgs([])).toEqual({});
  });

  test("parses --config <path>", () => {
    expect(parseArgs(["--config", "/etc/pi-lot.json"])).toEqual({
      configPath: "/etc/pi-lot.json",
    });
  });

  test("parses -c <path>", () => {
    expect(parseArgs(["-c", "./pi-lot.json"])).toEqual({
      configPath: "./pi-lot.json",
    });
  });

  test("parses --config=<path>", () => {
    expect(parseArgs(["--config=./pi-lot.json"])).toEqual({
      configPath: "./pi-lot.json",
    });
  });

  test("rejects unknown flags", () => {
    expect(() => parseArgs(["--nope"])).toThrow();
  });

  test("rejects --config without a value", () => {
    expect(() => parseArgs(["--config"])).toThrow();
    expect(() => parseArgs(["--config", "--other"])).toThrow();
  });
});
