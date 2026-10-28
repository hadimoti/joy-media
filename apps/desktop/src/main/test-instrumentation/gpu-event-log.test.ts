import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GPU_EVENT_LOG_CAP_BYTES,
  GPU_EVENT_LOG_FILE,
  GPU_EVENT_LOG_ROTATED_FILE,
  GpuEventLog,
  gpuEventLine,
  normaliseExitCodeHex,
  type GpuEventFileSystem,
} from './gpu-event-log.js';

/** An in-memory file system with the same three operations as the app's. */
function memoryFiles(): {
  readonly files: GpuEventFileSystem;
  readonly contents: Map<string, string>;
} {
  const contents = new Map<string, string>();
  const files: GpuEventFileSystem = {
    size: (file) =>
      contents.has(file) ? Buffer.byteLength(contents.get(file) ?? '', 'utf8') : undefined,
    append: (file, text) => {
      contents.set(file, (contents.get(file) ?? '') + text);
    },
    replace: (from, to) => {
      const text = contents.get(from);
      if (text === undefined) throw new Error('missing source file');
      contents.set(to, text);
      contents.delete(from);
    },
  };
  return { files, contents };
}

const folder = '/test/user-data';
const currentFile = join(folder, GPU_EVENT_LOG_FILE);
const rotatedFile = join(folder, GPU_EVENT_LOG_ROTATED_FILE);
const time = new Date('2026-10-28T12:00:00.000Z');
const gpuGone = {
  type: 'GPU',
  reason: 'crashed',
  exitCode: -1073740791,
  name: 'GPU',
  serviceName: 'x',
};

describe('gpuEventLine', () => {
  it('writes the time, type, reason and exit codes of a GPU exit, and no other field', () => {
    const line = gpuEventLine(gpuGone, time);
    expect(line).toBeDefined();
    expect(JSON.parse(line ?? '{}')).toEqual({
      time: '2026-10-28T12:00:00.000Z',
      type: 'GPU',
      reason: 'crashed',
      exitCode: -1073740791,
      exitCodeHex: '0xC0000409',
    });
  });

  it('writes nothing for an event of another type or a value that is not an object', () => {
    expect(gpuEventLine({ type: 'Utility', reason: 'crashed', exitCode: 1 }, time)).toBeUndefined();
    expect(gpuEventLine(undefined, time)).toBeUndefined();
    expect(gpuEventLine('GPU', time)).toBeUndefined();
  });

  it('keeps a missing exit code as null instead of inventing zero', () => {
    const line = JSON.parse(gpuEventLine({ type: 'GPU', reason: 'killed' }, time) ?? '{}');
    expect(line.exitCode).toBeNull();
    expect(line.exitCodeHex).toBeNull();
  });
});

describe('normaliseExitCodeHex', () => {
  it('gives the same hex for both forms of the fast-fail code', () => {
    expect(normaliseExitCodeHex(-1073740791)).toBe('0xC0000409');
    expect(normaliseExitCodeHex(3221226505)).toBe('0xC0000409');
  });

  it('pads small values to eight digits', () => {
    expect(normaliseExitCodeHex(0)).toBe('0x00000000');
    expect(normaliseExitCodeHex(1)).toBe('0x00000001');
  });
});

describe('GpuEventLog', () => {
  it('appends one line per GPU event to gpu-events.jsonl in the user-data folder', () => {
    const { files, contents } = memoryFiles();
    const log = new GpuEventLog(() => folder, files);
    expect(log.record(gpuGone, time)).toBe(true);
    expect(log.record(gpuGone, time)).toBe(true);
    expect((contents.get(currentFile) ?? '').split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('writes nothing for a non-GPU event', () => {
    const { files, contents } = memoryFiles();
    const log = new GpuEventLog(() => folder, files);
    expect(log.record({ type: 'Utility', reason: 'crashed' }, time)).toBe(false);
    expect(contents.size).toBe(0);
  });

  it('keeps the current file at or under the cap and moves the full one to the rotation file', () => {
    const { files, contents } = memoryFiles();
    const log = new GpuEventLog(() => folder, files, 300);
    for (let index = 0; index < 5; index += 1) log.record(gpuGone, time);
    const current = contents.get(currentFile) ?? '';
    const rotated = contents.get(rotatedFile) ?? '';
    expect(Buffer.byteLength(current, 'utf8')).toBeLessThanOrEqual(300);
    expect(rotated.split('\n').filter(Boolean).length).toBeGreaterThan(0);
  });

  it('replaces the previous rotation rather than keeping older ones', () => {
    const { files, contents } = memoryFiles();
    const log = new GpuEventLog(() => folder, files, 300);
    for (let index = 0; index < 20; index += 1) log.record(gpuGone, time);
    expect([...contents.keys()].sort()).toEqual([currentFile, rotatedFile].sort());
  });

  it('uses the 256 KiB cap by default', () => {
    expect(GPU_EVENT_LOG_CAP_BYTES).toBe(256 * 1024);
  });

  it('drops a failed write without throwing, so the app keeps running', () => {
    const failing: GpuEventFileSystem = {
      size: () => undefined,
      append: () => {
        throw new Error('disk full');
      },
      replace: () => undefined,
    };
    const log = new GpuEventLog(() => folder, failing);
    expect(log.record(gpuGone, time)).toBe(false);
  });

  it('never writes the user-data folder path into a line', () => {
    const { files, contents } = memoryFiles();
    const log = new GpuEventLog(() => folder, files);
    log.record(gpuGone, time);
    expect(contents.get(currentFile)).not.toContain(folder);
  });
});
