import { loadConfig, ConfigError } from "./config/index.ts";
import { buildPiLotRuntime } from "./orchestrator/index.ts";
import { parseArgs } from "./cli/args.ts";

/**
 * Pi Lot entry point.
 *
 * Responsibilities:
 * 1. Parse CLI arguments (`--config` only).
 * 2. Load and validate the local config file.
 * 3. Assemble the Orchestrator runtime and start the poll loop.
 *
 * The loop runs until the process receives SIGINT/SIGTERM, at which
 * point it lets in-flight Runs settle and exits cleanly.
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

  const { orchestrator } = await buildPiLotRuntime({ config });

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await orchestrator.start({ signal: controller.signal });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await orchestrator.idle();
  }
  return 0;
}

const code = await main();
process.exit(code);
