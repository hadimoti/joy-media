export interface StorageFlushController {
  readonly markDirty: () => void;
  readonly flushIfDirty: () => void;
  readonly isDirty: () => boolean;
}

/** Tracks failed DOM-storage flushes so the main-process safety timer can retry them. */
export function createStorageFlushController(flushStorageData: () => void): StorageFlushController {
  let dirty = false;

  const flushIfDirty = (): void => {
    if (!dirty) return;
    try {
      flushStorageData();
      dirty = false;
    } catch {
      // Keep the flag set so the safety interval retries the flush.
    }
  };

  return {
    markDirty: () => {
      dirty = true;
      flushIfDirty();
    },
    flushIfDirty,
    isDirty: () => dirty,
  };
}
