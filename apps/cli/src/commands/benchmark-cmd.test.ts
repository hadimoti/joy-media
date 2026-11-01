import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { runCli } from '../cli.js';
import { perSecond, runBenchmark } from './benchmark-cmd.js';

class StringWritable extends Writable {
  public chunks: Buffer[] = [];
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    cb();
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function redirectStdout(target: StringWritable): () => void {
  const original = process.stdout.write.bind(process.stdout);
  const replacement = ((chunk: string | Buffer, ...rest: unknown[]): boolean => {
    target.write(chunk);
    return original(chunk as string, ...(rest as []));
  }) as typeof process.stdout.write;
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = replacement;
  return () => {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = original;
  };
}

describe('joy benchmark (diagnostic & benchmark command)', () => {
  it('runs both suites by default and prints formatted tables', async () => {
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    try {
      const result = await runBenchmark({ stdout: capture });
      expect(result.exitCode).toBe(0);
    } finally {
      restore();
    }

    const output = capture.text();
    expect(output).toContain('System Benchmarks');
    expect(output).toContain('Media Engine Benchmarks');
    const names = [
      'disk-read-4MiB',
      'disk-write-1MiB',
      'sqlite-tx-throughput',
      'heap-allocation',
      'timeline-scrub',
      'clip-collision-resolve',
      'living-look-compile',
    ];
    for (const n of names) {
      expect(output).toContain(n);
    }
  });

  it('runs only --system suite when requested', async () => {
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    try {
      const result = await runBenchmark({ system: true, stdout: capture });
      expect(result.exitCode).toBe(0);
      expect(result.summaries.length).toBe(1);
      expect(result.summaries[0]!.suite).toBe('system');
      expect(result.measurements.every((m) => m.suite === 'system')).toBe(true);
    } finally {
      restore();
    }
  });

  it('runs only --media-engine suite when requested', async () => {
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    try {
      const result = await runBenchmark({ 'media-engine': true, stdout: capture });
      expect(result.exitCode).toBe(0);
      expect(result.summaries.length).toBe(1);
      expect(result.summaries[0]!.suite).toBe('media-engine');
      expect(result.measurements.every((m) => m.suite === 'media-engine')).toBe(true);
    } finally {
      restore();
    }
  });

  it('streams newline-delimited JSON events when --json is set', async () => {
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    try {
      const result = await runBenchmark({ json: true, stdout: capture });
      expect(result.exitCode).toBe(0);
    } finally {
      restore();
    }
    const lines = capture
      .text()
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const events = lines.map((line) => JSON.parse(line));
    const types = new Set(events.map((e: { type: string }) => e.type));
    expect(types.has('measurement')).toBe(true);
    expect(types.has('summary')).toBe(true);
    expect(types.has('complete')).toBe(true);
  });

  it('routes through runCli with --system, --media-engine, --json flags', async () => {
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    try {
      const code = await runCli(['benchmark', '--system', '--json']);
      expect(code).toBe(0);
    } finally {
      restore();
    }
    const output = capture.text();
    // When --json is enabled, no human-formatted table headers are emitted.
    expect(output).not.toContain('System Benchmarks');
  });

  it('reports at least one measurement with a positive value for every benchmark', async () => {
    const capture = new StringWritable();
    const result = await runBenchmark({ stdout: capture });
    expect(result.measurements.length).toBeGreaterThanOrEqual(7);
    for (const m of result.measurements) {
      expect(m.value).toBeGreaterThan(0);
      expect(m.iterations).toBeGreaterThan(0);
      expect(m.totalMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('only reports finite numbers, so nothing turns into null in JSON', async () => {
    const capture = new StringWritable();
    const result = await runBenchmark({ stdout: capture });
    for (const m of result.measurements) {
      for (const field of [m.value, m.iterations, m.totalMs, m.perOpMs ?? 0]) {
        expect(Number.isFinite(field)).toBe(true);
      }
    }
  });

  it('compiles the Living Look for real instead of timing an instant rejection', async () => {
    const capture = new StringWritable();
    const result = await runBenchmark({ 'media-engine': true, stdout: capture });
    const look = result.measurements.find((m) => m.name === 'living-look-compile');
    expect(look?.failures).toBe(0);
  });

  it('gives each suite its own total time instead of the whole run for both', async () => {
    const capture = new StringWritable();
    const result = await runBenchmark({ json: true, stdout: capture });
    const events = capture
      .text()
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const complete = events[events.length - 1];
    expect(complete.type).toBe('complete');
    expect(result.summaries).toHaveLength(2);
    const sumOfSuites = result.summaries.reduce((sum, s) => sum + s.totalMs, 0);
    expect(sumOfSuites).toBeLessThanOrEqual(complete.totalMs + 0.01);
    for (const summary of result.summaries) {
      const own = summary.measurements.reduce((sum, m) => sum + m.totalMs, 0);
      expect(summary.totalMs).toBeGreaterThanOrEqual(own - 0.01);
    }
  });
});

describe('perSecond', () => {
  it('never returns Infinity or NaN, even for a loop too fast to time', () => {
    expect(perSecond(1000, 0)).toBeGreaterThan(0);
    expect(Number.isFinite(perSecond(1000, 0))).toBe(true);
    expect(Number.isFinite(perSecond(1000, Number.NaN))).toBe(true);
    expect(Number.isFinite(perSecond(1000, -3))).toBe(true);
    expect(perSecond(1000, 500)).toBe(2000);
  });
});

describe('benchmark scratch files', () => {
  function withTmpdir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const tempKeys = ['TMPDIR', 'TMP', 'TEMP'] as const;
    const previous = new Map(tempKeys.map((key) => [key, process.env[key]]));
    const dir = mkdtempSync(join(tmpdir(), 'joy-bench-unit-'));
    for (const key of tempKeys) process.env[key] = dir;
    return fn(dir).finally(() => {
      for (const key of tempKeys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    });
  }

  it('removes its scratch directories when it is done', async () => {
    await withTmpdir(async (dir) => {
      const result = await runBenchmark({ system: true, json: true, stdout: new StringWritable() });
      expect(result.exitCode).toBe(0);
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it('ends the JSON stream with an error event and exit code 1 when scratch space is unusable', async () => {
    await withTmpdir(async (dir) => {
      const file = join(dir, 'a-file');
      writeFileSync(file, 'x');
      for (const key of ['TMPDIR', 'TMP', 'TEMP'] as const) {
        process.env[key] = join(file, 'nested');
      }
      const capture = new StringWritable();
      const result = await runBenchmark({ system: true, json: true, stdout: capture });
      expect(result.exitCode).toBe(1);
      const lines = capture
        .text()
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      expect(lines[lines.length - 1]).toMatchObject({ type: 'error' });
      expect(lines[lines.length - 1].message).toMatch(/Benchmark failed/);
    });
  });
});
