import { mkdir, readFile, writeFile, readdir, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  phaseTranscriptPath,
  runRecordPath,
  runTranscriptDir,
  runsDir,
} from "./paths.ts";
import type {
  CreateRunInput,
  PhaseName,
  PhaseRecord,
  PhaseStatus,
  Run,
  RunStatus,
  TerminalReport,
} from "./types.ts";

/**
 * Abstract Run Record store interface.
 *
 * The Conductor (and, in parallel, the worker Scheduler in #4) talks
 * to a {@link RunStore} so that Run lifecycle persistence stays
 * independent of disk layout. Tests inject a fake; production uses
 * {@link FileSystemRunStore}.
 *
 * The interface deliberately does not surface filesystem types; phase
 * transcript paths are returned as plain strings inside Run records.
 */
export interface RunStore {
  /** Create and persist a brand-new Run for a Task. Status starts at "queued". */
  createRun(input: CreateRunInput): Promise<Run>;

  /**
   * Append one transcript event line to the named Phase's JSONL file.
   * The Phase record is created on first append with status "running".
   *
   * `event` is serialized as a single JSON line. Callers (the Pi phase
   * runner) decide event shape.
   */
  appendPhaseEvent(
    runId: string,
    phaseName: PhaseName,
    event: unknown,
  ): Promise<void>;

  /**
   * Mark the named Phase ended on the Run.
   *
   * Persists `endedAt`, the final {@link PhaseStatus}, and (for the
   * Finalize phase) the parsed Terminal Report.
   */
  completePhase(
    runId: string,
    phaseName: PhaseName,
    update: CompletePhaseUpdate,
  ): Promise<Run>;

  /**
   * Mark the Run itself terminated.
   *
   * The Run's `status` flips to "ready-for-review" or "needs-human"
   * and `endedAt` is recorded. Optional Terminal Report is copied onto
   * the Run for convenience (the Finalize Phase record already has it).
   */
  completeRun(runId: string, update: CompleteRunUpdate): Promise<Run>;

  /** Load a Run by id, or `null` if the file does not exist. */
  loadRun(runId: string): Promise<Run | null>;

  /**
   * List Runs whose lifecycle is still in progress, i.e. status is
   * "queued" or "running". Used by the Scheduler to discover work in
   * flight at a given moment.
   */
  listActiveRuns(): Promise<Run[]>;
}

export interface CompletePhaseUpdate {
  status: Exclude<PhaseStatus, "pending" | "running">;
  terminalReport?: TerminalReport;
}

export interface CompleteRunUpdate {
  status: Exclude<RunStatus, "queued" | "running">;
  terminalReport?: TerminalReport;
}

export interface FileSystemRunStoreOptions {
  /** Pi Lot state directory; Run Records live under `<stateDir>/runs/`. */
  stateDir: string;
  /** Override for the current time. Injected for deterministic tests. */
  now?: () => Date;
  /** Override for fresh Run id generation. Injected for deterministic tests. */
  newId?: () => string;
}

/**
 * JSON-backed Run Record store.
 *
 * Each Run lives in its own file under `<stateDir>/runs/` so that:
 *   - Lifecycle updates are append-style writes of a small JSON blob
 *     rather than rewrites of a single index file.
 *   - The Scheduler in #4 can list active Runs by reading the directory.
 *   - Concurrent updates to different Runs do not contend.
 *
 * Phase transcripts are JSONL files under `<stateDir>/transcripts/<runId>/`.
 * This store appends to them on behalf of the Pi phase runner so that
 * Phase records always point at a real, writable file path.
 */
export class FileSystemRunStore implements RunStore {
  private readonly stateDir: string;
  private readonly nowFn: () => Date;
  private readonly newIdFn: () => string;

  constructor(opts: FileSystemRunStoreOptions) {
    this.stateDir = opts.stateDir;
    this.nowFn = opts.now ?? (() => new Date());
    this.newIdFn = opts.newId ?? (() => randomUUID());
  }

  public async createRun(input: CreateRunInput): Promise<Run> {
    const id = this.newIdFn();
    const run: Run = {
      id,
      taskRef: { ...input.taskRef },
      boardItemId: input.boardItemId,
      taskBranch: input.taskBranch,
      worktreePath: input.worktreePath,
      status: "queued",
      createdAt: this.nowFn().toISOString(),
      phases: [],
    };
    await mkdir(runsDir(this.stateDir), { recursive: true });
    await this.writeRun(run);
    return run;
  }

  public async appendPhaseEvent(
    runId: string,
    phaseName: PhaseName,
    event: unknown,
  ): Promise<void> {
    const run = await this.requireRun(runId);
    const transcriptPath = phaseTranscriptPath(this.stateDir, runId, phaseName);

    // Ensure the per-run transcript directory exists before appending.
    await mkdir(runTranscriptDir(this.stateDir, runId), { recursive: true });
    await appendFile(transcriptPath, `${JSON.stringify(event)}\n`, "utf8");

    const now = this.nowFn().toISOString();
    let phase = run.phases.find((p) => p.name === phaseName);
    let mutated = false;
    if (!phase) {
      phase = {
        name: phaseName,
        status: "running",
        startedAt: now,
        transcriptPath,
      };
      run.phases.push(phase);
      mutated = true;
    } else if (phase.status === "pending") {
      phase.status = "running";
      phase.startedAt = now;
      mutated = true;
    }

    // First-event side effect on the Run: leaving "queued" once any
    // Phase has begun emitting events.
    if (run.status === "queued") {
      run.status = "running";
      mutated = true;
    }

    if (mutated) {
      await this.writeRun(run);
    }
  }

  public async completePhase(
    runId: string,
    phaseName: PhaseName,
    update: CompletePhaseUpdate,
  ): Promise<Run> {
    const run = await this.requireRun(runId);
    const now = this.nowFn().toISOString();
    let phase = run.phases.find((p) => p.name === phaseName);
    if (!phase) {
      // Phase completed without any event having been appended (e.g. an
      // immediate failure before transcript output). Create the record
      // so callers can see the failure and still find a transcript path.
      phase = {
        name: phaseName,
        status: update.status,
        startedAt: now,
        endedAt: now,
        transcriptPath: phaseTranscriptPath(this.stateDir, runId, phaseName),
      };
      if (update.terminalReport) phase.terminalReport = update.terminalReport;
      run.phases.push(phase);
    } else {
      phase.status = update.status;
      phase.endedAt = now;
      if (update.terminalReport) phase.terminalReport = update.terminalReport;
    }
    await this.writeRun(run);
    return run;
  }

  public async completeRun(
    runId: string,
    update: CompleteRunUpdate,
  ): Promise<Run> {
    const run = await this.requireRun(runId);
    run.status = update.status;
    run.endedAt = this.nowFn().toISOString();
    if (update.terminalReport) run.terminalReport = update.terminalReport;
    await this.writeRun(run);
    return run;
  }

  public async loadRun(runId: string): Promise<Run | null> {
    const file = await this.findRunFile(runId);
    if (!file) return null;
    return await readRunFile(file);
  }

  public async listActiveRuns(): Promise<Run[]> {
    const dir = runsDir(this.stateDir);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const runs: Run[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const run = await readRunFile(`${dir}/${name}`);
      if (run.status === "queued" || run.status === "running") {
        runs.push(run);
      }
    }
    return runs;
  }

  private async requireRun(runId: string): Promise<Run> {
    const run = await this.loadRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }

  private async findRunFile(runId: string): Promise<string | null> {
    const dir = runsDir(this.stateDir);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const suffix = `__${runId}.json`;
    const match = entries.find((n) => n.endsWith(suffix));
    return match ? `${dir}/${match}` : null;
  }

  private async writeRun(run: Run): Promise<void> {
    await mkdir(runsDir(this.stateDir), { recursive: true });
    const file = runRecordPath(this.stateDir, run.taskRef, run.id);
    await writeFile(file, JSON.stringify(run, null, 2), "utf8");
  }
}

async function readRunFile(file: string): Promise<Run> {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as Run;
}
