import { spawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ExclusiveRecordBusyError,
  type ExclusiveRecordFileSystem,
  StaleRecoveryLockError,
  UnreadableRecoveryLockError,
  acquireRecord,
  processIsAlive,
  withRecoveryMutex,
} from './exclusive-record.js';

type TestRecord = { pid: number; token: string; createdAt: number };

const recordOptions = {
  isComplete: (value: unknown): value is TestRecord =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TestRecord).pid === 'number' &&
    typeof (value as TestRecord).token === 'string' &&
    typeof (value as TestRecord).createdAt === 'number',
  pidOf: (record: TestRecord) => record.pid,
  makeRecord: (): TestRecord => ({ pid: process.pid, token: 'new-token', createdAt: Date.now() }),
};

describe('exclusive record protocol', () => {
  it('blocks acquisition when a complete record has a live pid', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-exclusive-live-'));
    const path = join(directory, 'owner');
    writeFileSync(path, JSON.stringify({ pid: process.pid, token: 'live', createdAt: 1 }));
    try {
      const result = withRecoveryMutex(path, () =>
        acquireRecord(path, { ...recordOptions, isAlive: () => true }),
      );
      expect(result).toBeNull();
      expect(JSON.parse(readFileSync(path, 'utf8')).token).toBe('live');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('replaces a complete record whose pid is dead', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-exclusive-dead-'));
    const path = join(directory, 'owner');
    writeFileSync(path, JSON.stringify({ pid: 2_147_000_000, token: 'dead', createdAt: 1 }));
    try {
      const result = withRecoveryMutex(path, () =>
        acquireRecord(path, {
          ...recordOptions,
          isAlive: (pid) => pid !== 2_147_000_000,
        }),
      );
      expect(result?.token).toBe('new-token');
      expect(JSON.parse(readFileSync(path, 'utf8')).token).toBe('new-token');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes an incomplete record immediately while holding the mutex', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-exclusive-incomplete-'));
    const path = join(directory, 'owner');
    writeFileSync(path, '{partial');
    try {
      const result = withRecoveryMutex(path, () =>
        acquireRecord(path, { ...recordOptions, isAlive: () => true }),
      );
      expect(result?.token).toBe('new-token');
      expect(JSON.parse(readFileSync(path, 'utf8')).token).toBe('new-token');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('treats EPERM from kill as alive', () => {
    expect(
      processIsAlive(42, () => {
        const error = Object.assign(new Error('permission denied'), { code: 'EPERM' });
        throw error;
      }),
    ).toBe(true);
  });

  it('treats ESRCH as dead, other kill errors as alive, and the current pid as alive', () => {
    expect(
      processIsAlive(42, () => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      }),
    ).toBe(false);
    expect(
      processIsAlive(42, () => {
        throw Object.assign(new Error('invalid pid'), { code: 'EINVAL' });
      }),
    ).toBe(true);
    expect(processIsAlive(process.pid)).toBe(true);
  });

  it('removes its staged file and leaves no mutex when the fallback write fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-exclusive-staged-failure-'));
    const path = join(directory, 'owner');
    const mutexPath = `${path}.recover`;
    try {
      // No hard links: the staged file is written, linking fails, and the fallback write fails.
      const fs = {
        ...nodeFs,
        linkSync: () => {
          throw Object.assign(new Error('hard links unavailable'), { code: 'EPERM' });
        },
        writeFileSync: (
          file: number | nodeFs.PathOrFileDescriptor,
          data: string | NodeJS.ArrayBufferView,
          ...args: unknown[]
        ) => {
          if (typeof file === 'number') throw new Error('fallback write failed');
          return (nodeFs.writeFileSync as (...values: unknown[]) => void)(file, data, ...args);
        },
      } as unknown as ExclusiveRecordFileSystem;
      expect(() => withRecoveryMutex(path, () => 'unexpected', { fs })).toThrow(
        'fallback write failed',
      );
      expect(nodeFs.existsSync(mutexPath)).toBe(false);
      expect(readdirSync(directory)).toEqual([]);
      expect(withRecoveryMutex(path, () => 'acquired')).toBe('acquired');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('leaves no staged file and no mutex when the staged write itself fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-exclusive-staged-write-'));
    const path = join(directory, 'owner');
    const mutexPath = `${path}.recover`;
    try {
      // A partly written staged file must not survive the failed write.
      const fs = {
        ...nodeFs,
        writeFileSync: (
          file: number | nodeFs.PathOrFileDescriptor,
          data: string | NodeJS.ArrayBufferView,
          ...args: unknown[]
        ) => {
          const write = nodeFs.writeFileSync as (...values: unknown[]) => void;
          if (typeof file === 'string' && file.includes('.staged-')) {
            write(file, String(data).slice(0, 4), ...args);
            throw new Error('staged write failed');
          }
          return write(file, data, ...args);
        },
      } as unknown as ExclusiveRecordFileSystem;
      expect(() => withRecoveryMutex(path, () => 'unexpected', { fs })).toThrow(
        'staged write failed',
      );
      expect(nodeFs.existsSync(mutexPath)).toBe(false);
      expect(readdirSync(directory)).toEqual([]);
      expect(withRecoveryMutex(path, () => 'acquired')).toBe('acquired');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports an unreadable recovery lock by name instead of a generic busy error', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-exclusive-unreadable-'));
    const path = join(directory, 'owner');
    const mutexPath = `${path}.recover`;
    try {
      writeFileSync(mutexPath, '');
      const action = vi.fn(() => 'unexpected');
      expect(() => withRecoveryMutex(path, action, { timeoutMs: 0 })).toThrow(
        UnreadableRecoveryLockError,
      );
      expect(action).not.toHaveBeenCalled();
      expect(readFileSync(mutexPath, 'utf8')).toBe('');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a stale recovery lock without removing it, but keeps a live mutex', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-exclusive-stale-'));
    const path = join(directory, 'owner');
    const mutexPath = `${path}.recover`;
    try {
      writeFileSync(mutexPath, JSON.stringify({ pid: 2_147_000_000, token: 'stale', time: 1 }));
      const unlinked: string[] = [];
      const fs = {
        ...nodeFs,
        unlinkSync: (target: nodeFs.PathLike) => {
          unlinked.push(String(target));
          return nodeFs.unlinkSync(target);
        },
      } as unknown as ExclusiveRecordFileSystem;
      const action = vi.fn(() => 'unexpected');
      expect(() =>
        withRecoveryMutex(path, action, {
          fs,
          isAlive: (pid) => pid !== 2_147_000_000,
        }),
      ).toThrow(StaleRecoveryLockError);
      expect(action).not.toHaveBeenCalled();
      expect(unlinked).not.toContain(mutexPath);
      expect(readdirSync(directory)).toEqual(['owner.recover']);
      expect(JSON.parse(readFileSync(mutexPath, 'utf8')).token).toBe('stale');

      writeFileSync(mutexPath, JSON.stringify({ pid: process.pid, token: 'live', time: 2 }));
      expect(() =>
        withRecoveryMutex(path, () => 'unexpected', {
          timeoutMs: 0,
          isAlive: () => true,
        }),
      ).toThrow(ExclusiveRecordBusyError);
      expect(JSON.parse(readFileSync(mutexPath, 'utf8')).token).toBe('live');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('makes both of two real Node processes refuse a stale recovery lock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-exclusive-stale-race-'));
    const path = join(directory, 'owner');
    writeFileSync(
      `${path}.recover`,
      JSON.stringify({ pid: 2_147_000_000, token: 'stale', time: 1 }),
    );
    const moduleUrl = new URL('./exclusive-record.ts', import.meta.url).href;
    const tsxEntry = readdirSync(join(process.cwd(), 'node_modules', '.pnpm')).find((entry) =>
      entry.startsWith('tsx@'),
    );
    expect(tsxEntry).toBeTruthy();
    const tsxLoader = join(
      process.cwd(),
      'node_modules',
      '.pnpm',
      tsxEntry!,
      'node_modules',
      'tsx',
      'dist',
      'loader.mjs',
    );
    const worker = `
      import { withRecoveryMutex } from ${JSON.stringify(moduleUrl)};
      import { writeFileSync } from 'node:fs';
      const [path, role] = process.argv.slice(1);
      try {
        withRecoveryMutex(path, () => {
          writeFileSync(path + '.' + role + '.acquired', 'acquired');
          return 'acquired';
        });
      } catch (error) {
        const kind = error && error.name === 'StaleRecoveryLockError' ? 'refused' : 'error';
        writeFileSync(path + '.' + role + '.' + kind, kind);
      }
    `;
    try {
      const children = ['one', 'two'].map(
        (role) =>
          new Promise<{ code: number; stderr: string }>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                '--import',
                pathToFileURL(tsxLoader).href,
                '--input-type=module',
                '-e',
                worker,
                path,
                role,
              ],
              { stdio: ['ignore', 'ignore', 'pipe'] },
            );
            let stderr = '';
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk: string) => (stderr += chunk));
            const timer = setTimeout(() => child.kill(), 8_000);
            child.once('error', reject);
            child.once('exit', (code) => {
              clearTimeout(timer);
              resolve({ code: code ?? -1, stderr });
            });
          }),
      );
      expect(await Promise.all(children)).toEqual([
        { code: 0, stderr: '' },
        { code: 0, stderr: '' },
      ]);
      expect(readdirSync(directory).filter((entry) => entry.endsWith('.acquired'))).toEqual([]);
      expect(readdirSync(directory).filter((entry) => entry.endsWith('.error'))).toEqual([]);
      expect(readdirSync(directory).filter((entry) => entry.endsWith('.refused'))).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('serializes two real Node processes racing to own the same record', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-exclusive-process-race-'));
    const path = join(directory, 'owner');
    const moduleUrl = new URL('./exclusive-record.ts', import.meta.url).href;
    const tsxEntry = readdirSync(join(process.cwd(), 'node_modules', '.pnpm')).find((entry) =>
      entry.startsWith('tsx@'),
    );
    expect(tsxEntry).toBeTruthy();
    const tsxLoader = join(
      process.cwd(),
      'node_modules',
      '.pnpm',
      tsxEntry!,
      'node_modules',
      'tsx',
      'dist',
      'loader.mjs',
    );
    const worker = `
      import { acquireRecord, withRecoveryMutex } from ${JSON.stringify(moduleUrl)};
      import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
      const [path, role] = process.argv.slice(1);
      writeFileSync(path + '.' + role + '.attempt', 'attempt');
      const record = { pid: process.pid, token: role, createdAt: Date.now() };
      const result = withRecoveryMutex(path, () => acquireRecord(path, {
        isComplete: (v) => !!v && typeof v.pid === 'number' && typeof v.token === 'string' && typeof v.createdAt === 'number',
        pidOf: (v) => v.pid,
        makeRecord: () => record,
      }));
      if (result) {
        writeFileSync(path + '.' + role + '.held', 'held');
        const until = Date.now() + 3000;
        while (Date.now() < until) {
          try { readFileSync(path + '.' + (role === 'one' ? 'two' : 'one') + '.busy'); break; } catch {}
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        try { unlinkSync(path); } catch {}
      } else {
        writeFileSync(path + '.' + role + '.busy', 'busy');
      }
    `;
    try {
      const children = ['one', 'two'].map(
        (role) =>
          new Promise<{ code: number; stderr: string }>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                '--import',
                pathToFileURL(tsxLoader).href,
                '--input-type=module',
                '-e',
                worker,
                path,
                role,
              ],
              { stdio: ['ignore', 'ignore', 'pipe'] },
            );
            let stderr = '';
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk: string) => (stderr += chunk));
            const timer = setTimeout(() => child.kill(), 8_000);
            child.once('error', reject);
            child.once('exit', (code) => {
              clearTimeout(timer);
              resolve({ code: code ?? -1, stderr });
            });
          }),
      );
      expect(await Promise.all(children)).toEqual([
        { code: 0, stderr: '' },
        { code: 0, stderr: '' },
      ]);
      expect(readdirSync(directory).filter((entry) => entry.endsWith('.held'))).toHaveLength(1);
      expect(readdirSync(directory).filter((entry) => entry.endsWith('.busy'))).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
