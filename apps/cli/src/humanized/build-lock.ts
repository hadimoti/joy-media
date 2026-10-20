import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import {
  ExclusiveRecordBusyError,
  RECOVERY_MUTEX_RETRY_MS,
  StaleRecoveryLockError,
  UnreadableRecoveryLockError,
  acquireRecord,
  processIsAlive,
  sleepSync,
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

export function tryAcquireBuildLock(
  path: string,
  options: { readonly mutexTimeoutMs?: number } = {},
): BuildLockOwner | null {
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
      {
        busyCode: 'BUILD_LOCK_BUSY',
        timeoutMs: options.mutexTimeoutMs ?? RECOVERY_MUTEX_RETRY_MS,
      },
    );
    if (!record) return null;
    return {
      ...record,
      release: () => {
        try {
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
            {
              busyCode: 'BUILD_LOCK_BUSY',
              timeoutMs: options.mutexTimeoutMs ?? RECOVERY_MUTEX_RETRY_MS,
            },
          );
        } catch (error) {
          if (
            error instanceof ExclusiveRecordBusyError ||
            error instanceof StaleRecoveryLockError ||
            error instanceof UnreadableRecoveryLockError
          ) {
            // Keep the owner record: releasing without its mutex could remove a newer owner. A
            // stale or unreadable recovery lock is reported by the next acquisition instead.
            return;
          }
          throw error;
        }
      },
    };
  } catch (error) {
    if (error instanceof ExclusiveRecordBusyError) return null;
    throw error;
  }
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
