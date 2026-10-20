import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import {
  ExclusiveRecordBusyError,
  acquireRecord,
  processIsAlive,
  withRecoveryMutex,
} from '../utils/exclusive-record.js';

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

export function readBuildLockToken(path: string): string | undefined {
  return readRecord(path)?.token;
}

export function tryAcquireBuildLock(path: string): BuildLockOwner | null {
  try {
    const record = withRecoveryMutex(
      path,
      () =>
        acquireRecord(path, {
          isComplete: (value): value is BuildLockRecord =>
            typeof value === 'object' &&
            value !== null &&
            typeof (value as BuildLockRecord).token === 'string' &&
            typeof (value as BuildLockRecord).pid === 'number' &&
            Number.isSafeInteger((value as BuildLockRecord).pid) &&
            typeof (value as BuildLockRecord).createdAt === 'number',
          pidOf: (value) => value.pid,
          makeRecord: () => ({ token: randomUUID(), pid: process.pid, createdAt: Date.now() }),
        }),
      { busyCode: 'BUILD_LOCK_BUSY' },
    );
    if (!record) return null;
    return {
      ...record,
      release: () => {
        withRecoveryMutex(
          path,
          () => {
            if (readRecord(path)?.token !== record.token) return;
            try {
              unlinkSync(path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          },
          { busyCode: 'BUILD_LOCK_BUSY' },
        );
      },
    };
  } catch (error) {
    if (error instanceof ExclusiveRecordBusyError) return null;
    throw error;
  }
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
      if (!owner || owner.token !== token || !processIsAlive(owner.pid)) return;
    }
    sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  if (existsSync(markerPath) && readFileSync(markerPath, 'utf8').trim() === token) return;
  throw new Error(`Timed out waiting for completed CLI build marker ${markerPath}`);
}
