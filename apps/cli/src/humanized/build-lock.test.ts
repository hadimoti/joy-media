import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryAcquireBuildLock, waitForBuildComplete } from './build-lock.js';

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

  it('allows only one recoverer to acquire an atomically reclaimed stale lock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-build-lock-race-'));
    const lockPath = join(directory, '.build.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ token: 'dead-owner', pid: 2_147_000_000, createdAt: 1 }),
    );
    try {
      const owners = await Promise.all([
        Promise.resolve().then(() => tryAcquireBuildLock(lockPath)),
        Promise.resolve().then(() => tryAcquireBuildLock(lockPath)),
      ]);
      const acquired = owners.filter((owner) => owner !== null);
      expect(acquired).toHaveLength(1);
      expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).toBe(acquired[0]?.token);
      acquired[0]?.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recovers a malformed lock only after its grace period', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-build-lock-malformed-'));
    const lockPath = join(directory, '.build.lock');
    try {
      writeFileSync(lockPath, '{partial');
      expect(tryAcquireBuildLock(lockPath)).toBeNull();
      const old = new Date(Date.now() - 5_000);
      utimesSync(lockPath, old, old);
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
