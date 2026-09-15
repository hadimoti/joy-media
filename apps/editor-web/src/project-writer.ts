/**
 * Origin-wide, browser-local writer ownership.
 *
 * This deliberately has no lease or timer fallback. If the Web Locks API is
 * unavailable, a caller receives a safe non-owner result and must not mount a
 * writable editor. The durable fence is allocated only while the exclusive
 * origin lock is held, so it remains strictly monotonic across writer lives.
 */

/** The one lock all writable JOY editor instances on this origin contend for. */
export const PROJECT_WRITER_LOCK_NAME = 'joy-media.project-writer.v1';

/**
 * A dedicated counter instead of a project document field. It remains valid
 * while a project is closed and prevents a later writer from reusing a stale
 * receipt fence.
 */
export const PROJECT_WRITER_FENCE_STORAGE_KEY = 'joy-media.project-writer-fence.v1';

/** Minimal storage surface shared by browser persistence adapters. */
export interface ProjectWriterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
  /** Read-only enumeration supports migrations without exposing raw storage. */
  readonly length?: number;
  key?(index: number): string | null;
}

/** A deliberately narrow structural representation of a granted Web Lock. */
export interface OriginWriterLock {
  readonly name: string;
  readonly mode: 'exclusive';
}

/**
 * Injectable Web Locks API. Keeping this narrow makes writer fencing testable
 * without mutating global navigator state.
 */
export interface OriginWriterLockManager {
  request<T>(
    name: string,
    options: {
      readonly mode: 'exclusive';
      readonly ifAvailable: true;
    },
    callback: (lock: OriginWriterLock | null) => T | Promise<T>,
  ): Promise<T>;
}

export interface AcquireProjectWriterOptions {
  readonly storage: ProjectWriterStorage;
  /** Omit in browsers to use navigator.locks; pass null to force safe unsupported mode. */
  readonly lockManager?: OriginWriterLockManager | null;
}

export type ProjectWriterStorageFailure =
  'storage-read-failed' | 'storage-write-failed' | 'invalid-fence' | 'fence-overflow';

export type ProjectWriterAcquireResult =
  | {
      readonly kind: 'owned';
      readonly fence: number;
      readonly writer: ProjectWriterHandle;
    }
  | { readonly kind: 'busy' }
  | { readonly kind: 'unsupported' }
  | {
      readonly kind: 'storage-unavailable';
      readonly reason: ProjectWriterStorageFailure;
    };

const projectWriterHandleBrand: unique symbol = Symbol('project-writer-handle');

/**
 * A capability, not a boolean. The class that implements it is private, so
 * callers cannot construct a live writer or revive it after release.
 */
export interface ProjectWriterHandle {
  /** Nominal brand: only this module can produce a writer capability. */
  readonly [projectWriterHandleBrand]: true;
  readonly fence: number;
  assertActive(): void;
  guardStorage(storage: ProjectWriterStorage): ProjectWriterStorage;
  /** Signals the retained Web Locks callback and waits for it to unwind. */
  release(): Promise<void>;
}

export class ProjectWriterReleasedError extends Error {
  constructor() {
    super('project writer is no longer active');
    this.name = 'ProjectWriterReleasedError';
  }
}

/** The durable origin fence advanced or became unreadable after acquisition. */
export class ProjectWriterFenceMismatchError extends Error {
  constructor() {
    super('project writer fence is no longer current');
    this.name = 'ProjectWriterFenceMismatchError';
  }
}

export class ProjectWriterReservedStorageKeyError extends Error {
  constructor() {
    super('project writer fence storage is reserved');
    this.name = 'ProjectWriterReservedStorageKeyError';
  }
}

/**
 * Acquire the sole writable editor capability for this origin.
 *
 * `ifAvailable` means a second tab receives `busy` immediately rather than
 * waiting and accidentally resuming stale in-memory state after another tab
 * has committed. The lock callback remains pending until `writer.release()`.
 */
export async function acquireProjectWriter(
  options: AcquireProjectWriterOptions,
): Promise<ProjectWriterAcquireResult> {
  const lockManager =
    options.lockManager === undefined ? browserLockManager() : options.lockManager;
  if (lockManager === null || lockManager === undefined) return { kind: 'unsupported' };

  const result = deferred<ProjectWriterAcquireResult>();
  const requestCompletion = deferred<void>();
  let resultSettled = false;
  let writer: ActiveProjectWriter | undefined;
  const settle = (next: ProjectWriterAcquireResult): void => {
    if (resultSettled) return;
    resultSettled = true;
    result.resolve(next);
  };

  try {
    const request = lockManager.request(
      PROJECT_WRITER_LOCK_NAME,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (lock === null) {
          settle({ kind: 'busy' });
          return;
        }
        if (!isGrantedWriterLock(lock)) {
          settle({ kind: 'unsupported' });
          return;
        }

        const fence = allocateFence(options.storage);
        if (typeof fence !== 'number') {
          settle({ kind: 'storage-unavailable', reason: fence });
          return;
        }

        const releaseSignal = deferred<void>();
        writer = new ActiveProjectWriter(
          fence,
          releaseSignal,
          requestCompletion.promise,
          options.storage,
        );
        settle({ kind: 'owned', fence, writer });
        await releaseSignal.promise;
      },
    );
    void request.then(
      () => {
        writer?.invalidateFromLockTermination();
        requestCompletion.resolve();
        settle({ kind: 'unsupported' });
      },
      () => {
        writer?.invalidateFromLockTermination();
        requestCompletion.resolve();
        settle({ kind: 'unsupported' });
      },
    );
  } catch {
    requestCompletion.resolve();
    return { kind: 'unsupported' };
  }

  return result.promise;
}

class ActiveProjectWriter implements ProjectWriterHandle {
  readonly [projectWriterHandleBrand] = true as const;
  #active = true;
  #releasePromise: Promise<void> | undefined;

  constructor(
    readonly fence: number,
    private readonly releaseSignal: Deferred<void>,
    private readonly requestCompletion: Promise<void>,
    private readonly fenceStorage: ProjectWriterStorage,
  ) {}

  assertActive(): void {
    if (!this.#active) throw new ProjectWriterReleasedError();
    try {
      if (this.fenceStorage.getItem(PROJECT_WRITER_FENCE_STORAGE_KEY) === String(this.fence))
        return;
    } catch {
      // A storage failure makes it impossible to prove this handle remains
      // current. Failing closed is safer than continuing an unfenced write.
    }
    this.#active = false;
    throw new ProjectWriterFenceMismatchError();
  }

  guardStorage(storage: ProjectWriterStorage): ProjectWriterStorage {
    const removeItem = storage.removeItem;
    const readOnlyEnumeration = {
      ...(storage.length === undefined ? {} : { length: storage.length }),
      ...(storage.key === undefined ? {} : { key: (index: number) => storage.key!(index) }),
    };
    if (removeItem === undefined) {
      return {
        getItem: (key) => {
          return storage.getItem(key);
        },
        setItem: (key, value) => {
          this.assertActive();
          assertWritableProjectStorageKey(key);
          storage.setItem(key, value);
        },
        ...readOnlyEnumeration,
      };
    }
    return {
      getItem: (key) => {
        return storage.getItem(key);
      },
      setItem: (key, value) => {
        this.assertActive();
        assertWritableProjectStorageKey(key);
        storage.setItem(key, value);
      },
      removeItem: (key) => {
        this.assertActive();
        assertWritableProjectStorageKey(key);
        removeItem.call(storage, key);
      },
      ...readOnlyEnumeration,
    };
  }

  release(): Promise<void> {
    if (this.#releasePromise !== undefined) return this.#releasePromise;
    this.#active = false;
    this.releaseSignal.resolve();
    this.#releasePromise = this.requestCompletion;
    return this.#releasePromise;
  }

  /** The browser lock can never end while its callback is pending, but stay safe for bad adapters. */
  invalidateFromLockTermination(): void {
    this.#active = false;
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function browserLockManager(): OriginWriterLockManager | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const locks = navigator.locks;
  if (locks === undefined || typeof locks.request !== 'function') return undefined;
  return locks as unknown as OriginWriterLockManager;
}

function isGrantedWriterLock(lock: OriginWriterLock): boolean {
  return lock.name === PROJECT_WRITER_LOCK_NAME && lock.mode === 'exclusive';
}

function allocateFence(storage: ProjectWriterStorage): number | ProjectWriterStorageFailure {
  let serialized: string | null;
  try {
    serialized = storage.getItem(PROJECT_WRITER_FENCE_STORAGE_KEY);
  } catch {
    return 'storage-read-failed';
  }

  const current = parseFence(serialized);
  if (typeof current !== 'number') return current;
  if (current >= Number.MAX_SAFE_INTEGER) return 'fence-overflow';

  const next = current + 1;
  try {
    storage.setItem(PROJECT_WRITER_FENCE_STORAGE_KEY, String(next));
    if (storage.getItem(PROJECT_WRITER_FENCE_STORAGE_KEY) !== String(next))
      return 'storage-write-failed';
  } catch {
    return 'storage-write-failed';
  }
  return next;
}

/** Invalid durable values never silently reset to zero or a new authority. */
function parseFence(serialized: string | null): number | 'invalid-fence' {
  if (serialized === null) return 0;
  if (!/^(?:0|[1-9][0-9]*)$/.test(serialized)) return 'invalid-fence';
  const fence = Number(serialized);
  if (!Number.isSafeInteger(fence) || fence < 0 || String(fence) !== serialized)
    return 'invalid-fence';
  return fence;
}

function assertWritableProjectStorageKey(key: string): void {
  if (key === PROJECT_WRITER_FENCE_STORAGE_KEY) throw new ProjectWriterReservedStorageKeyError();
}
