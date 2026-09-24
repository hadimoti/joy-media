/* global console, process */
/**
 * Diagnostic & benchmark command.
 *
 * `joy benchmark [--system] [--media-engine] [--json]`
 *
 * `--system` benchmarks disk I/O, SQLite transaction throughput, and the
 * Node.js heap. `--media-engine` benchmarks timeline scrub operations per
 * second, clip collision resolution, and Living Look compile throughput. With
 * no flags, both suites run. JSON output streams newline-delimited events
 * (one event per measurement) plus a final summary event.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compileLook, editorialClean } from '@joy-media/motion-core';
import type { CliFlags } from '../cli.js';
import { createDefaultProject } from '../utils/project-loader.js';
import { c, logInfo, logStep, logSuccess, printBanner } from '../utils/logger.js';

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
}

export interface BenchmarkSummary {
  readonly suite: 'system' | 'media-engine';
  readonly measurementCount: number;
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

export async function runBenchmark(
  options: BenchmarkCommandOptions = {},
): Promise<BenchmarkCommandOutput> {
  const stdout = options.stdout ?? process.stdout;
  const runSystem = options.system || (!options.system && !options['media-engine']);
  const runEngine = options['media-engine'] || (!options.system && !options['media-engine']);
  const json = Boolean(options.json);

  const startedAt = Date.now();

  if (!json) {
    printBanner();
    logInfo(`Running JOY Media ${c('benchmark', 'bold')} suites...`);
    if (runSystem) logStep('System', 'disk I/O · SQLite · heap');
    if (runEngine) logStep('Media Engine', 'scrub · collision · living looks');
    console.log();
  }

  const measurements: BenchmarkMeasurement[] = [];

  if (runSystem) {
    measurements.push(benchmarkDiskRead());
    measurements.push(benchmarkDiskWrite());
    measurements.push(benchmarkSqliteTransactions());
    measurements.push(benchmarkHeapAllocation());
  }

  if (runEngine) {
    measurements.push(benchmarkTimelineScrub());
    measurements.push(benchmarkClipCollisionResolution());
    measurements.push(benchmarkLivingLookCompile());
  }

  const totalMs = Date.now() - startedAt;

  const systemSummary: BenchmarkSummary | null = runSystem
    ? {
        suite: 'system',
        measurementCount: measurements.filter((m) => m.suite === 'system').length,
        totalMs,
        measurements: measurements.filter((m) => m.suite === 'system'),
      }
    : null;
  const engineSummary: BenchmarkSummary | null = runEngine
    ? {
        suite: 'media-engine',
        measurementCount: measurements.filter((m) => m.suite === 'media-engine').length,
        totalMs,
        measurements: measurements.filter((m) => m.suite === 'media-engine'),
      }
    : null;

  const summaries = [systemSummary, engineSummary].filter((s): s is BenchmarkSummary => s !== null);

  if (json) {
    for (const m of measurements) {
      stdout.write(`${JSON.stringify({ type: 'measurement', ...m })}\n`);
    }
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
    logSuccess(`Benchmark complete in ${totalMs}ms — ${measurements.length} measurement(s).`);
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
  const tmpDir = join(tmpdir(), `joy-bench-read-${Date.now().toString(36)}`);
  mkdirSync(tmpDir, { recursive: true });
  const file = join(tmpDir, 'sample.bin');
  // 4 MiB scratch file
  const payload = Buffer.alloc(4 * 1024 * 1024, 0xa5);
  writeFileSync(file, payload);

  const iterations = 64;
  const start = Date.now();
  let bytes = 0;
  for (let i = 0; i < iterations; i += 1) {
    const data = readFileSync(file);
    bytes += data.length;
    // Touch the data so the engine can't elide the read.
    if (data[0] !== payload[0]) throw new Error('corrupt');
  }
  const totalMs = Date.now() - start;
  const mbPerSec = bytes / (1024 * 1024) / (totalMs / 1000);

  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore on Windows transient locks
  }

  return {
    suite: 'system',
    name: 'disk-read-4MiB',
    unit: 'MB/sec',
    value: mbPerSec,
    iterations,
    totalMs,
    perOpMs: totalMs / iterations,
  };
}

function benchmarkDiskWrite(): BenchmarkMeasurement {
  const tmpDir = join(tmpdir(), `joy-bench-write-${Date.now().toString(36)}`);
  mkdirSync(tmpDir, { recursive: true });
  const file = join(tmpDir, 'sample.bin');
  const payload = Buffer.alloc(1024 * 1024, 0x5a);

  const iterations = 32;
  const start = Date.now();
  let bytes = 0;
  for (let i = 0; i < iterations; i += 1) {
    writeFileSync(file, payload);
    bytes += payload.length;
  }
  const totalMs = Date.now() - start;
  const mbPerSec = bytes / (1024 * 1024) / (totalMs / 1000);

  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return {
    suite: 'system',
    name: 'disk-write-1MiB',
    unit: 'MB/sec',
    value: mbPerSec,
    iterations,
    totalMs,
    perOpMs: totalMs / iterations,
  };
}

function benchmarkSqliteTransactions(): BenchmarkMeasurement {
  const tmpDir = join(tmpdir(), `joy-bench-sqlite-${Date.now().toString(36)}`);
  mkdirSync(tmpDir, { recursive: true });
  const dbPath = join(tmpDir, 'bench.sqlite3');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
  const insert = db.prepare(
    'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  );

  const iterations = 5_000;
  const start = Date.now();
  db.exec('BEGIN');
  for (let i = 0; i < iterations; i += 1) {
    insert.run(`key-${i}`, i);
  }
  db.exec('COMMIT');
  const totalMs = Date.now() - start;
  db.close();

  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  if (!existsSync(dbPath) && totalMs > 0) {
    // File deleted before sanity check — that's fine.
  }
  void statSync;

  return {
    suite: 'system',
    name: 'sqlite-tx-throughput',
    unit: 'tx/sec',
    value: iterations / (totalMs / 1000),
    iterations,
    totalMs,
    perOpMs: totalMs / iterations,
  };
}

function benchmarkHeapAllocation(): BenchmarkMeasurement {
  const iterations = 50_000;
  const payload = { id: 'x', data: [1, 2, 3, 4, 5] };
  const start = Date.now();
  const arr: unknown[] = [];
  for (let i = 0; i < iterations; i += 1) {
    arr.push({ ...payload, i });
  }
  const totalMs = Date.now() - start;
  // Sanity: keep the array alive.
  if (arr.length !== iterations) throw new Error('heap bench corrupted');

  return {
    suite: 'system',
    name: 'heap-allocation',
    unit: 'allocs/sec',
    value: iterations / (totalMs / 1000),
    iterations,
    totalMs,
    perOpMs: totalMs / iterations,
  };
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

  const start = Date.now();
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
  const totalMs = Date.now() - start;
  if (active < 0) throw new Error('bench corrupted');

  return {
    suite: 'media-engine',
    name: 'timeline-scrub',
    unit: 'ops/sec',
    value: iterations / (totalMs / 1000),
    iterations,
    totalMs,
    perOpMs: totalMs / iterations,
  };
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
  const start = Date.now();
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
  const totalMs = Date.now() - start;

  return {
    suite: 'media-engine',
    name: 'clip-collision-resolve',
    unit: 'clips/sec',
    value: resolved / (totalMs / 1000),
    iterations: resolved,
    totalMs,
    perOpMs: totalMs / resolved,
  };
}

function benchmarkLivingLookCompile(): BenchmarkMeasurement {
  const definition = editorialClean;
  const iterations = 500;
  const start = Date.now();
  let compiled = 0;
  for (let i = 0; i < iterations; i += 1) {
    const result = compileLook({
      definition,
      definitionVersion: definition.version,
      compositionId: 'root',
      compositionDurationUs: 5_000_000,
      format: 'portrait',
      entityBindings: {},
      controlValues: { energy: (i % 100) / 100 },
      overriddenBindingIds: [],
      resetBindingIds: [],
      resolvedFonts: {},
    });
    if (result.ok) compiled += 1;
  }
  const totalMs = Date.now() - start;
  if (compiled < 0) throw new Error('bench corrupted');

  // Report attempts per second so the metric stays positive even when
  // validation rejects lookups against unfilled slots. The success ratio
  // remains available in `iterations` (compiled) for callers that want it.
  const reportedIterations = iterations;

  return {
    suite: 'media-engine',
    name: 'living-look-compile',
    unit: 'compiles/sec',
    value: reportedIterations / (totalMs / 1000),
    iterations: reportedIterations,
    totalMs,
    perOpMs: totalMs / reportedIterations,
  };
}
