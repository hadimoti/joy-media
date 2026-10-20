import { spawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ExclusiveRecordBusyError,
  type ExclusiveRecordFileSystem,
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

  it('steals a stale mutex through link, token verification, and unlink, but keeps a live mutex', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-exclusive-mutex-'));
    const path = join(directory, 'owner');
    const mutexPath = `${path}.recover`;
    try {
      writeFileSync(mutexPath, JSON.stringify({ pid: 2_147_000_000, token: 'stale', time: 1 }));
      expect(
        withRecoveryMutex(path, () => 'acquired', {
          isAlive: (pid) => pid !== 2_147_000_000,
        }),
      ).toBe('acquired');
      expect(readdirSync(directory).filter((entry) => entry.includes('.unique-'))).toEqual([]);

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

  it('abandons stale-mutex stealing when the linked inode token differs from the observed token', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-exclusive-mismatch-'));
    const path = join(directory, 'owner');
    const mutexPath = `${path}.recover`;
    writeFileSync(mutexPath, JSON.stringify({ pid: 2_147_000_000, token: 'observed', time: 1 }));
    try {
      const fs = {
        ...nodeFs,
        readFileSync: (readPath: string, encoding: BufferEncoding) => {
          const value = readFileSync(readPath, encoding);
          return readPath.includes('.unique-')
            ? JSON.stringify({ pid: 2_147_000_000, token: 'changed', time: 1 })
            : value;
        },
      } as unknown as ExclusiveRecordFileSystem;
      expect(() =>
        withRecoveryMutex(path, () => 'unexpected', {
          fs,
          isAlive: () => false,
          timeoutMs: 0,
        }),
      ).toThrow(ExclusiveRecordBusyError);
      expect(JSON.parse(readFileSync(mutexPath, 'utf8')).token).toBe('observed');
      expect(readdirSync(directory).filter((entry) => entry.includes('.unique-'))).toEqual([]);
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
