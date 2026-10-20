import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export interface BuildLockOwner {
  readonly token: string;
  readonly pid: number;
  readonly createdAt: number;
  readonly release: () => void;
}

interface BuildLockRecord {
  readonly token: string;
  readonly pid: number;
  readonly createdAt: number;
}

function readRecord(path: string): BuildLockRecord | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as BuildLockRecord).token === 'string' &&
      typeof (value as BuildLockRecord).pid === 'number' &&
      Number.isSafeInteger((value as BuildLockRecord).pid) &&
      typeof (value as BuildLockRecord).createdAt === 'number'
    )
      return value as BuildLockRecord;
  } catch {
    // A partially written or malformed lock cannot safely be declared stale.
  }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readBuildLockToken(path: string): string | undefined {
  return readRecord(path)?.token;
}

export function tryAcquireBuildLock(path: string): BuildLockOwner | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    const pid = process.pid;
    const createdAt = Date.now();
    let descriptor: number;
    try {
      descriptor = openSync(path, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const record = readRecord(path);
      if (!record || isProcessAlive(record.pid)) return null;
      if (readRecord(path)?.token !== record.token) continue;
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
      continue;
    }
    try {
      writeFileSync(descriptor, `${JSON.stringify({ token, pid, createdAt })}\n`);
    } catch (error) {
      closeSync(descriptor);
      try {
        unlinkSync(path);
      } catch {
        /* best effort */
      }
      throw error;
    }
    closeSync(descriptor);
    return {
      token,
      pid,
      createdAt,
      release: () => {
        if (readRecord(path)?.token !== token) return;
        try {
          unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      },
    };
  }
  return null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function waitForBuildComplete(
  markerPath: string,
  deadline: number,
  token: string,
  sleep: (milliseconds: number) => void = sleepSync,
  lockPath?: string,
): void {
  while (Date.now() < deadline) {
    try {
      if (readFileSync(markerPath, 'utf8').trim() === token) return;
    } catch {
      // The builder has not published completion yet.
    }
    if (lockPath) {
      const owner = readRecord(lockPath);
      if (!owner || owner.token !== token || !isProcessAlive(owner.pid)) return;
    }
    sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  if (existsSync(markerPath) && readFileSync(markerPath, 'utf8').trim() === token) return;
  throw new Error(`Timed out waiting for completed CLI build marker ${markerPath}`);
}
