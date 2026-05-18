import type {
  PiSession,
  PiSessionEvent,
  PiSessionEventHandler,
  PiSessionFactory,
  PiSessionInput,
} from "./types.ts";

/**
 * Production Pi CLI session factory.
 *
 * Spawns the `pi` binary in the workspace, streams stdout line-by-line
 * as transcript events, and resolves with the child's exit code.
 *
 * POC behavior:
 *   - The rendered Task Definition prompt is passed via stdin.
 *   - Each line of stdout is emitted as a transcript event of the form
 *     `{ kind: "stdout", line }`.
 *   - Stderr is streamed as `{ kind: "stderr", line }` so failures are
 *     visible in the transcript.
 *
 * Tests do not use this; they inject a recording fake.
 */
export function createPiCliSessionFactory(opts: {
  /** Command to spawn. Defaults to `["pi"]`. */
  command?: readonly string[];
} = {}): PiSessionFactory {
  const command = opts.command ?? ["pi"];
  return (input: PiSessionInput): PiSession => {
    return {
      async run(handler: PiSessionEventHandler) {
        const proc = Bun.spawn([...command], {
          cwd: input.cwd,
          env: input.env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        // Write the prompt and close stdin so `pi` knows the input is done.
        const writer = proc.stdin as unknown as {
          write: (data: string) => void;
          end: () => void;
        };
        try {
          writer.write(input.prompt);
          writer.end();
        } catch {
          /* swallow: process may have exited already. */
        }

        await Promise.all([
          forwardStream(proc.stdout, "stdout", handler),
          forwardStream(proc.stderr, "stderr", handler),
        ]);
        const exitCode = await proc.exited;
        return { exitCode };
      },
    };
  };
}

async function forwardStream(
  stream: ReadableStream<Uint8Array> | undefined,
  kind: "stdout" | "stderr",
  handler: PiSessionEventHandler,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event: PiSessionEvent = { kind, line };
        await handler(event);
      }
    }
    if (done) {
      const trailing = buffer + decoder.decode();
      if (trailing) {
        await handler({ kind, line: trailing });
      }
      return;
    }
  }
}
