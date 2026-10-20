import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';

// Every creation and removal of an owner or lock record happens while holding its recovery
// mutex. Creators write a complete record before releasing the mutex, so an incomplete record
// found under the mutex has no living creator and can be removed immediately without a grace
// period.
//
// Residual limits. A stale steal verifies the token through a second name and then unlinks the
// well-known name. Two recoverers stealing the same dead mutex at once can race, so a live mutex
// taken between that check and the unlink can be lost, because link and unlink cannot make the
// sequence atomic. On volumes without hard links, the wx-and-write fallback can still leave an
// incomplete mutex if the process crashes between creating the file and writing its complete
// record.

export const RECOVERY_MUTEX_RETRY_MS = 5_000;
const RECOVERY_MUTEX_RETRY_INTERVAL_MS = 10;

export type KillProcess = (pid: number, signal: number) => void;

export function processIsAlive(pid: number, kill: KillProcess = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ESRCH';
  }
}

export class ExclusiveRecordBusyError extends Error {
  public readonly code: string;

  constructor(code: string, path: string) {
    super(`Exclusive record is busy at ${path}.`);
    this.name = 'ExclusiveRecordBusyError';
    this.code = code;
  }
}

export type ExclusiveRecordFileSystem = Pick<
  typeof nodeFs,
  'openSync' | 'closeSync' | 'writeFileSync' | 'readFileSync' | 'linkSync' | 'unlinkSync'
>;

export interface RecoveryMutexOptions {
  readonly busyCode?: string;
  readonly timeoutMs?: number;
  readonly retryIntervalMs?: number;
  readonly pid?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => void;
  readonly isAlive?: (pid: number) => boolean;
  readonly fs?: ExclusiveRecordFileSystem;
}

interface MutexRecord {
  readonly pid: number;
  readonly token: string;
  readonly time: number;
}

export function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function createMutexRecord(
  mutexPath: string,
  record: string,
  fs: ExclusiveRecordFileSystem,
): boolean {
  const stagedPath = `${mutexPath}.staged-${randomUUID()}`;
  try {
    fs.writeFileSync(stagedPath, record, { flag: 'wx' });
    try {
      fs.linkSync(stagedPath, mutexPath);
      return true;
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code === 'EEXIST') return false;

      // Hard links are unavailable on some volumes; this fallback can still leave an incomplete
      // mutex if the process crashes between exclusive creation and writing the record.
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(mutexPath, 'wx');
        fs.writeFileSync(descriptor, record);
        fs.closeSync(descriptor);
        descriptor = undefined;
        return true;
      } catch (error) {
        if (descriptor !== undefined) {
          try {
            fs.closeSync(descriptor);
          } catch {
            // The descriptor may already be closed.
          }
          try {
            fs.unlinkSync(mutexPath);
          } catch {
            // Best effort cleanup while this caller still owns the mutex creation.
          }
        }
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    }
  } finally {
    try {
      fs.unlinkSync(stagedPath);
    } catch {
      // Staged names are unique and temporary; cleanup is best effort.
    }
  }
}

function readMutex(path: string, fs: ExclusiveRecordFileSystem): MutexRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Number.isSafeInteger((parsed as MutexRecord).pid) &&
      typeof (parsed as MutexRecord).token === 'string' &&
      typeof (parsed as MutexRecord).time === 'number'
    )
      return parsed as MutexRecord;
  } catch {
    // A mutex without a complete holder pid cannot be declared stale safely.
  }
  return undefined;
}

export function withRecoveryMutex<T>(
  targetPath: string,
  action: () => T,
  options: RecoveryMutexOptions = {},
): T {
  const mutexPath = `${targetPath}.recover`;
  const fs = options.fs ?? nodeFs;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepSync;
  const timeoutMs = options.timeoutMs ?? RECOVERY_MUTEX_RETRY_MS;
  const retryIntervalMs = options.retryIntervalMs ?? RECOVERY_MUTEX_RETRY_INTERVAL_MS;
  const holderPid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  const deadline = now() + timeoutMs;

  while (true) {
    const token = randomUUID();
    const created = createMutexRecord(
      mutexPath,
      `${JSON.stringify({ pid: holderPid, token, time: now() })}\n`,
      fs,
    );
    if (!created) {
      const observed = readMutex(mutexPath, fs);
      if (observed && !isAlive(observed.pid)) {
        const uniquePath = `${mutexPath}.unique-${randomUUID()}`;
        let removedObservedMutex = false;
        try {
          fs.linkSync(mutexPath, uniquePath);
          const linked = readMutex(uniquePath, fs);
          const current = readMutex(mutexPath, fs);
          if (linked?.token === observed.token && current?.token === observed.token) {
            try {
              fs.unlinkSync(mutexPath);
              removedObservedMutex = true;
            } catch (unlinkError) {
              if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
            }
          }
        } catch {
          // Another recovery may have changed the well-known mutex while this link was made.
        }
        try {
          fs.unlinkSync(uniquePath);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
        }
        if (removedObservedMutex) continue;
      }
      if (now() >= deadline)
        throw new ExclusiveRecordBusyError(options.busyCode ?? 'BUSY', targetPath);
      sleep(Math.min(retryIntervalMs, Math.max(1, deadline - now())));
      continue;
    }

    let result: T | undefined;
    let actionError: unknown;
    try {
      result = action();
    } catch (error) {
      actionError = error;
    }
    let unlockError: unknown;
    if (readMutex(mutexPath, fs)?.token === token) {
      try {
        fs.unlinkSync(mutexPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unlockError = error;
      }
    }
    if (actionError !== undefined) throw actionError;
    if (unlockError !== undefined) throw unlockError;
    return result as T;
  }
}

export function replaceRecordUnderMutex<T>(
  path: string,
  record: T,
  fs: ExclusiveRecordFileSystem = nodeFs,
): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(path, 'wx');
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
    fs.closeSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The descriptor may already be closed.
      }
      try {
        fs.unlinkSync(path);
      } catch {
        // This helper is called under the recovery mutex, so this is the caller's own record.
      }
    }
    throw error;
  }
}

export interface AcquireRecordOptions<T> {
  readonly isComplete: (value: unknown) => value is T;
  readonly pidOf: (record: T) => number;
  readonly makeRecord: () => T;
  readonly isAlive?: (pid: number) => boolean;
  readonly fs?: ExclusiveRecordFileSystem;
}

/** Acquire or recover a record while the caller holds `withRecoveryMutex(path, ...)`. */
export function acquireRecord<T>(path: string, options: AcquireRecordOptions<T>): T | null {
  const fs = options.fs ?? nodeFs;
  let existing: unknown;
  let contents: string | undefined;
  try {
    contents = fs.readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (contents !== undefined) {
    try {
      existing = JSON.parse(contents) as unknown;
    } catch {
      // Invalid or incomplete record contents may be removed while the recovery mutex is held.
    }
  }
  if (existing !== undefined && options.isComplete(existing)) {
    if ((options.isAlive ?? processIsAlive)(options.pidOf(existing))) return null;
  }
  try {
    fs.unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const record = options.makeRecord();
  replaceRecordUnderMutex(path, record, fs);
  return record;
}
