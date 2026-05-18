import { loadConfig, ConfigError } from "./config/index.ts";
import { Conductor } from "./conductor/index.ts";
import { parseArgs } from "./cli/args.ts";

/**
 * Pi Lot entry point.
 *
 * Responsibilities at this scaffold stage:
 * 1. Parse CLI arguments (only `--config` is recognized).
 * 2. Load and validate the local config file.
 * 3. Start exactly one Conductor process, inheriting the worker
 *    environment unchanged.
 *
 * Validation failures exit non-zero with an actionable message before
 * any GitHub, git, or Pi session work is attempted.
 */
async function main(): Promise<number> {
  let configPath: string | undefined;
  try {
    ({ configPath } = parseArgs(process.argv.slice(2)));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`pi-lot: ${msg}\n`);
    process.stderr.write("Usage: bun start [--config <path>]\n");
    return 2;
  }

  let config;
  try {
    config = await loadConfig({ path: configPath });
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`pi-lot: ${e.format()}\n`);
      return 1;
    }
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`pi-lot: failed to load config: ${msg}\n`);
    return 1;
  }

  const conductor = new Conductor(config);
  await conductor.start();
  return 0;
}

const code = await main();
process.exit(code);
