import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { runCli } from '../cli.js';
import { runBenchmark } from './benchmark-cmd.js';

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
});
