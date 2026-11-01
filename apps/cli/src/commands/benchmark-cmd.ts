/* global console, process, performance */
/**
 * Diagnostic & benchmark command.
 *
 * `joy benchmark [--system] [--media-engine] [--json]`
 *
 * `--system` benchmarks disk I/O, SQLite transaction throughput, and the
 * Node.js heap. `--media-engine` benchmarks timeline scrub operations per
 * second, clip collision resolution, and Living Look compile throughput. With
 * no flags, both suites run. JSON output streams newline-delimited events: one
 * `measurement` event as each measurement finishes, then one `summary` per
 * suite and a final `complete` event. If the run fails, the stream ends with a
 * single `error` event instead (and the exit code is 1).
 *
 * The suites are synthetic micro-benchmarks. Their absolute numbers vary from
 * machine to machine and run to run; only their shape (names, units,
 * iteration counts) is stable.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compileLook, editorialClean } from '@joy-media/motion-core';
import type { CliFlags } from '../cli.js';
import { createDefaultProject } from '../utils/project-loader.js';
import { c, logError, logInfo, logStep, logSuccess, printBanner } from '../utils/logger.js';

export interface BenchmarkCommandFlags {
  system?: boolean | undefined;
  'media-engine'?: boolean | undefined;
  json?: boolean | undefined;
}

export interface BenchmarkMeasurement {
  readonly suite: 'system' | 'media-engine';
  readonly name: string;
  readonly unit: string;
  readonly value: number;
  readonly iterations: number;
  readonly totalMs: number;
  readonly perOpMs?: number | undefined;
  /** Iterations whose operation was rejected instead of completing (only reported by some benchmarks). */
  readonly failures?: number | undefined;
}

export interface BenchmarkSummary {
  readonly suite: 'system' | 'media-engine';
  readonly measurementCount: number;
  /** Wall-clock time spent in THIS suite (setup included). */
  readonly totalMs: number;
  readonly measurements: readonly BenchmarkMeasurement[];
}

export interface BenchmarkCommandOptions {
  readonly system?: boolean | undefined;
  readonly 'media-engine'?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly stdout?: NodeJS.WritableStream | undefined;
}

export interface BenchmarkCommandOutput {
  readonly exitCode: number;
  readonly summaries: readonly BenchmarkSummary[];
  readonly measurements: readonly BenchmarkMeasurement[];
}

export async function handleBenchmarkCommand(args: string[], flags: CliFlags): Promise<number> {
  void args;
  const opts: BenchmarkCommandOptions = {
    system: flags.system,
    'media-engine': flags['media-engine' as keyof CliFlags] as boolean | undefined,
    json: flags.json,
  };
  const result = await runBenchmark(opts);
  return result.exitCode;
}

// ─── Timing helpers ─────────────────────────────────────────────────────────

/** Smallest elapsed time (ms) a rate is computed over, so a too-fast loop can never yield Infinity/NaN. */
const MIN_ELAPSED_MS = 0.001;

function now(): number {
  return performance.now();
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** `count` operations in `elapsedMs` as operations per second; always a finite number > 0. */
export function perSecond(count: number, elapsedMs: number): number {
  const ms = Number.isFinite(elapsedMs) && elapsedMs > MIN_ELAPSED_MS ? elapsedMs : MIN_ELAPSED_MS;
  return round3(count / (ms / 1000));
}

function measurement(
  fields: Omit<BenchmarkMeasurement, 'perOpMs' | 'totalMs'> & { readonly elapsedMs: number },
): BenchmarkMeasurement {
  const { elapsedMs, ...rest } = fields;
  return {
    ...rest,
    totalMs: round3(elapsedMs),
    // Per-op times are tiny (microseconds); keep 6 decimals so they don't round to 0.
    perOpMs: Math.round((elapsedMs / fields.iterations) * 1_000_000) / 1_000_000,
  };
}

/** Run `fn` in a private scratch directory that is always removed afterwards. */
function withScratchDir<T>(prefix: string, fn: (dir: string) => T): T {
  const base = tmpdir();
  mkdirSync(base, { recursive: true });
  // mkdtemp gives every run its own directory, so two benchmarks running at
  // the same time (or in the same millisecond) can never trample each other.
  const dir = mkdtempSync(join(base, `${prefix}-`));
  try {
    return fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore on Windows transient locks
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

export async function runBenchmark(
  options: BenchmarkCommandOptions = {},
): Promise<BenchmarkCommandOutput> {
  const stdout = options.stdout ?? process.stdout;
  const runSystem = options.system || (!options.system && !options['media-engine']);
  const runEngine = options['media-engine'] || (!options.system && !options['media-engine']);
  const json = Boolean(options.json);

  const startedAt = now();

  if (!json) {
    printBanner();
    logInfo(`Running JOY Media ${c('benchmark', 'bold')} suites...`);
    if (runSystem) logStep('System', 'disk I/O · SQLite · heap');
    if (runEngine) logStep('Media Engine', 'scrub · collision · living looks');
    console.log();
  }

  const measurements: BenchmarkMeasurement[] = [];
  const suiteMs = new Map<BenchmarkMeasurement['suite'], number>();

  const runSuite = (
    suite: BenchmarkMeasurement['suite'],
    steps: ReadonlyArray<() => BenchmarkMeasurement>,
  ): void => {
    const suiteStartedAt = now();
    for (const step of steps) {
      const m = step();
      measurements.push(m);
      // Stream each result as soon as it exists so a watcher sees progress.
      if (json) stdout.write(`${JSON.stringify({ type: 'measurement', ...m })}\n`);
    }
    suiteMs.set(suite, round3(now() - suiteStartedAt));
  };

  try {
    if (runSystem) {
      runSuite('system', [
        benchmarkDiskRead,
        benchmarkDiskWrite,
        benchmarkSqliteTransactions,
        benchmarkHeapAllocation,
      ]);
    }
    if (runEngine) {
      runSuite('media-engine', [
        benchmarkTimelineScrub,
        benchmarkClipCollisionResolution,
        benchmarkLivingLookCompile,
      ]);
    }
  } catch (err) {
    const message = `Benchmark failed: ${errorMessage(err)}`;
    logError(message);
    if (json) {
      stdout.write(`${JSON.stringify({ type: 'error', message, ts: new Date().toISOString() })}\n`);
    }
    return { exitCode: 1, summaries: [], measurements };
  }

  const totalMs = round3(now() - startedAt);

  const summaries: BenchmarkSummary[] = [];
  for (const suite of ['system', 'media-engine'] as const) {
    if (!suiteMs.has(suite)) continue;
    const own = measurements.filter((m) => m.suite === suite);
    summaries.push({
      suite,
      measurementCount: own.length,
      totalMs: suiteMs.get(suite) ?? 0,
      measurements: own,
    });
  }

  if (json) {
    for (const summary of summaries) {
      stdout.write(`${JSON.stringify({ type: 'summary', ...summary })}\n`);
    }
    stdout.write(
      `${JSON.stringify({
        type: 'complete',
        totalMs,
        suites: summaries.map((s) => s.suite),
        measurementCount: measurements.length,
      })}\n`,
    );
  } else {
    printBenchmarkTables(summaries, stdout);
    stdout.write('\n');
    logSuccess(
      `Benchmark complete in ${Math.round(totalMs)}ms — ${measurements.length} measurement(s).`,
    );
  }

  return {
    exitCode: 0,
    summaries,
    measurements,
  };
}

function printBenchmarkTables(
  summaries: readonly BenchmarkSummary[],
  stdout: NodeJS.WritableStream = process.stdout,
): void {
  for (const summary of summaries) {
    const title = summary.suite === 'system' ? 'System Benchmarks' : 'Media Engine Benchmarks';
    stdout.write(`  ${c(title, 'bold')}\n`);
    const rows = summary.measurements.map((m) => [
      m.name,
      formatNumber(m.value),
      m.unit,
      String(m.iterations),
      m.totalMs.toFixed(2),
      m.perOpMs !== undefined ? m.perOpMs.toFixed(4) : '—',
    ]);
    const headers = ['Metric', 'Value', 'Unit', 'Iterations', 'Total (ms)', 'Per-op (ms)'];
    const colWidths = headers.map((h, i) => {
      let max = h.length;
      for (const row of rows) {
        const len = row[i]?.length ?? 0;
        if (len > max) max = len;
      }
      return Math.max(max, 4);
    });
    const headerLine = headers.map((h, i) => h.padEnd(colWidths[i]!)).join('  │  ');
    const separator = colWidths.map((w) => '─'.repeat(w)).join('──┼──');
    stdout.write(`  ${c(headerLine, 'bold')}\n`);
    stdout.write(`  ${c(separator, 'dim')}\n`);
    for (const row of rows) {
      const rowLine = headers.map((_, i) => (row[i] ?? '').padEnd(colWidths[i]!)).join('  │  ');
      stdout.write(`  ${rowLine}\n`);
    }
    stdout.write('\n');
  }
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(2);
}

// ─── System Benchmarks ──────────────────────────────────────────────────────

function benchmarkDiskRead(): BenchmarkMeasurement {
  return withScratchDir('joy-bench-read', (tmpDir) => {
    const file = join(tmpDir, 'sample.bin');
    // 4 MiB scratch file
    const payload = Buffer.alloc(4 * 1024 * 1024, 0xa5);
    writeFileSync(file, payload);

    const iterations = 64;
    const start = now();
    let bytes = 0;
    for (let i = 0; i < iterations; i += 1) {
      const data = readFileSync(file);
      bytes += data.length;
      // Touch the data so the engine can't elide the read.
      if (data[0] !== payload[0]) throw new Error('corrupt');
    }
    const elapsedMs = now() - start;

    return measurement({
      suite: 'system',
      name: 'disk-read-4MiB',
      unit: 'MB/sec',
      value: perSecond(bytes / (1024 * 1024), elapsedMs),
      iterations,
      elapsedMs,
    });
  });
}

function benchmarkDiskWrite(): BenchmarkMeasurement {
  return withScratchDir('joy-bench-write', (tmpDir) => {
    const file = join(tmpDir, 'sample.bin');
    const payload = Buffer.alloc(1024 * 1024, 0x5a);

    const iterations = 32;
    const start = now();
    let bytes = 0;
    for (let i = 0; i < iterations; i += 1) {
      writeFileSync(file, payload);
      bytes += payload.length;
    }
    const elapsedMs = now() - start;

    return measurement({
      suite: 'system',
      name: 'disk-write-1MiB',
      unit: 'MB/sec',
      value: perSecond(bytes / (1024 * 1024), elapsedMs),
      iterations,
      elapsedMs,
    });
  });
}

function benchmarkSqliteTransactions(): BenchmarkMeasurement {
  return withScratchDir('joy-bench-sqlite', (tmpDir) => {
    const dbPath = join(tmpDir, 'bench.sqlite3');

    const db = new DatabaseSync(dbPath);
    const iterations = 5_000;
    let elapsedMs: number;
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
      const insert = db.prepare(
        'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      );

      const start = now();
      db.exec('BEGIN');
      for (let i = 0; i < iterations; i += 1) {
        insert.run(`key-${i}`, i);
      }
      db.exec('COMMIT');
      elapsedMs = now() - start;
    } finally {
      db.close();
    }

    return measurement({
      suite: 'system',
      name: 'sqlite-tx-throughput',
      unit: 'tx/sec',
      value: perSecond(iterations, elapsedMs),
      iterations,
      elapsedMs,
    });
  });
}

function benchmarkHeapAllocation(): BenchmarkMeasurement {
  const iterations = 50_000;
  const payload = { id: 'x', data: [1, 2, 3, 4, 5] };
  const start = now();
  const arr: unknown[] = [];
  for (let i = 0; i < iterations; i += 1) {
    arr.push({ ...payload, i });
  }
  const elapsedMs = now() - start;
  // Sanity: keep the array alive.
  if (arr.length !== iterations) throw new Error('heap bench corrupted');

  return measurement({
    suite: 'system',
    name: 'heap-allocation',
    unit: 'allocs/sec',
    value: perSecond(iterations, elapsedMs),
    iterations,
    elapsedMs,
  });
}

// ─── Media Engine Benchmarks ────────────────────────────────────────────────

interface ClipForBench {
  readonly id: string;
  readonly trackId: string;
  readonly startUs: number;
  readonly durationUs: number;
}

function benchmarkTimelineScrub(): BenchmarkMeasurement {
  const project = createDefaultProject('Benchmark');
  const root = project.compositions['root'];
  if (!root) {
    throw new Error('benchmark project has no root composition');
  }
  const tracks = root.tracks as unknown as Array<{
    id: string;
    clips: ClipForBench[];
  }>;

  // Synthesize a busy timeline so scrub has something to do per tick.
  for (const track of tracks) {
    for (let i = 0; i < 250; i += 1) {
      track.clips.push({
        id: `clip-${track.id}-${i}`,
        trackId: track.id,
        startUs: i * 1_000_000,
        durationUs: 900_000,
      });
    }
  }

  const durationUs = 10_000_000;
  const stepUs = 16_667; // ~60fps scrub step
  const iterations = Math.floor(durationUs / stepUs);

  const start = now();
  let active = 0;
  for (let i = 0; i < iterations; i += 1) {
    const tUs = i * stepUs;
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (tUs >= clip.startUs && tUs < clip.startUs + clip.durationUs) {
          active += 1;
        }
      }
    }
  }
  const elapsedMs = now() - start;
  if (active < 0) throw new Error('bench corrupted');

  return measurement({
    suite: 'media-engine',
    name: 'timeline-scrub',
    unit: 'ops/sec',
    value: perSecond(iterations, elapsedMs),
    iterations,
    elapsedMs,
  });
}

function benchmarkClipCollisionResolution(): BenchmarkMeasurement {
  // Synthetic clips arranged to force the collision resolver to reshuffle.
  const clips: ClipForBench[] = [];
  for (let i = 0; i < 500; i += 1) {
    clips.push({
      id: `c-${i}`,
      trackId: 't',
      startUs: i * 100_000, // 100ms apart, with overlap
      durationUs: 250_000,
    });
  }

  const iterations = 200;
  const start = now();
  let resolved = 0;
  for (let iter = 0; iter < iterations; iter += 1) {
    const sorted = clips.slice().sort((a, b) => a.startUs - b.startUs);
    let cursor = 0;
    let onTrackB = 0;
    for (const clip of sorted) {
      if (clip.startUs < cursor) {
        // Collision — push to alternate lane.
        onTrackB += 1;
      } else {
        cursor = clip.startUs + clip.durationUs;
      }
      resolved += 1;
    }
    if (onTrackB < 0) throw new Error('collision bench corrupted');
  }
  const elapsedMs = now() - start;

  return measurement({
    suite: 'media-engine',
    name: 'clip-collision-resolve',
    unit: 'clips/sec',
    value: perSecond(resolved, elapsedMs),
    iterations: resolved,
    elapsedMs,
  });
}

function benchmarkLivingLookCompile(): BenchmarkMeasurement {
  const definition = editorialClean;
  // Bind every slot the look declares. Without this `compileLook` rejects the
  // input up front ("required slot is not bound") and the benchmark would time
  // the cheap rejection path instead of a real compile.
  const entityBindings: Record<string, string> = {};
  for (const slot of definition.slots) entityBindings[slot.id] = `bench-${slot.id}`;

  const iterations = 500;
  const start = now();
  let compiled = 0;
  for (let i = 0; i < iterations; i += 1) {
    const result = compileLook({
      definition,
      definitionVersion: definition.version,
      compositionId: 'root',
      compositionDurationUs: 5_000_000,
      format: 'portrait',
      entityBindings,
      controlValues: { energy: (i % 100) / 100 },
      overriddenBindingIds: [],
      resetBindingIds: [],
      resolvedFonts: {},
    });
    if (result.ok) compiled += 1;
  }
  const elapsedMs = now() - start;

  return measurement({
    suite: 'media-engine',
    name: 'living-look-compile',
    unit: 'compiles/sec',
    value: perSecond(iterations, elapsedMs),
    iterations,
    failures: iterations - compiled,
    elapsedMs,
  });
}
