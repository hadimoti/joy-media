import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tryAcquireBuildLock, waitForBuildComplete } from './build-lock.js';
import { StaleRecoveryLockError } from '../utils/exclusive-record.js';

describe('CLI build lock', () => {
  it('does not evict a live owner', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-build-lock-live-'));
    const lockPath = join(directory, '.build.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ token: 'live-owner', pid: process.pid, createdAt: 1 }),
    );
    try {
      expect(tryAcquireBuildLock(lockPath)).toBeNull();
      expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).toBe('live-owner');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('evicts a dead owner lock', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-build-lock-dead-'));
    const lockPath = join(directory, '.build.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ token: 'dead-owner', pid: 2_147_000_000, createdAt: 1 }),
    );
    try {
      const owner = tryAcquireBuildLock(lockPath);
      expect(owner).not.toBeNull();
      expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).toBe(owner?.token);
      owner?.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('allows only one of two real Node processes to acquire the same build lock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-build-lock-race-'));
    const lockPath = join(directory, '.build.lock');
    const moduleUrl = new URL('./build-lock.ts', import.meta.url).href;
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
      import { tryAcquireBuildLock } from ${JSON.stringify(moduleUrl)};
      import { readFileSync, writeFileSync } from 'node:fs';
      const [path, role] = process.argv.slice(1);
      writeFileSync(path + '.' + role + '.attempt', 'attempt');
      const owner = tryAcquireBuildLock(path);
      if (owner) {
        writeFileSync(path + '.' + role + '.held', 'held');
        const until = Date.now() + 3000;
        while (Date.now() < until) {
          try { readFileSync(path + '.' + (role === 'one' ? 'two' : 'one') + '.busy'); break; } catch {}
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        owner.release();
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
                lockPath,
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

  it('recovers an incomplete lock immediately under the recovery mutex', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-build-lock-malformed-'));
    const lockPath = join(directory, '.build.lock');
    try {
      writeFileSync(lockPath, '{partial');
      const owner = tryAcquireBuildLock(lockPath);
      expect(owner).not.toBeNull();
      expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).toBe(owner?.token);
      owner?.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not release another owner token', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-build-lock-token-'));
    const lockPath = join(directory, '.build.lock');
    try {
      const owner = tryAcquireBuildLock(lockPath);
      expect(owner).not.toBeNull();
      writeFileSync(
        lockPath,
        JSON.stringify({ token: 'replacement-owner', pid: process.pid, createdAt: Date.now() }),
      );
      owner?.release();
      expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).toBe('replacement-owner');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not throw or release the build lock when its recovery mutex is busy', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-build-lock-release-busy-'));
    const lockPath = join(directory, '.build.lock');
    try {
      const owner = tryAcquireBuildLock(lockPath, { mutexTimeoutMs: 0 });
      expect(owner).not.toBeNull();
      const recoverPath = `${lockPath}.recover`;
      writeFileSync(
        recoverPath,
        JSON.stringify({ pid: process.pid, token: 'busy-recovery', time: Date.now() }),
      );
      expect(() => owner?.release()).not.toThrow();
      expect(JSON.parse(readFileSync(recoverPath, 'utf8')).token).toBe('busy-recovery');
      expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).toBe(owner?.token);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses to acquire while a recovery lock from an exited process is present', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-build-lock-stale-'));
    const lockPath = join(directory, '.build.lock');
    const recoverPath = `${lockPath}.recover`;
    try {
      writeFileSync(
        recoverPath,
        JSON.stringify({ pid: 2_147_000_000, token: 'stale-recovery', time: 1 }),
      );
      expect(() => tryAcquireBuildLock(lockPath)).toThrow(StaleRecoveryLockError);
      expect(JSON.parse(readFileSync(recoverPath, 'utf8')).token).toBe('stale-recovery');
      expect(() => readFileSync(lockPath, 'utf8')).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('waits until the completed-build marker exists', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-build-marker-'));
    const markerPath = join(directory, '.build.complete');
    try {
      let polls = 0;
      waitForBuildComplete(markerPath, Date.now() + 1_000, 'complete', () => {
        polls += 1;
        if (polls === 2) writeFileSync(markerPath, 'complete');
      });
      expect(polls).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
