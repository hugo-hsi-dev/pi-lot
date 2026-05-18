/**
 * Minimal CLI argument parser for Pi Lot.
 *
 * MVP only needs `--config <path>` (alias `-c <path>`). Everything else
 * is rejected with an actionable message so unknown flags don't silently
 * change Conductor behavior.
 */
export interface CliArgs {
  configPath?: string;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--config" || arg === "-c") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(`${arg} requires a path argument`);
      }
      out.configPath = next;
      i++;
      continue;
    }
    if (arg.startsWith("--config=")) {
      out.configPath = arg.slice("--config=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}
