export interface StorageFlushController {
  /** Records that renderer storage changed, and flushes it now. */
  readonly markDirty: () => void;
  /** Flushes unconditionally. Renderer writes still inside its debounce window are not dirty yet. */
  readonly flushNow: () => void;
  readonly flushIfDirty: () => void;
  readonly isDirty: () => boolean;
}

/**
 * Flushes Electron's DOM storage to disk and tracks failed flushes so the main-process safety timer
 * can retry them. Failures are reported through `onError` and never thrown.
 */
export function createStorageFlushController(
  flushStorageData: () => void,
  onError?: (error: unknown) => void,
): StorageFlushController {
  let dirty = false;

  const flushNow = (): void => {
    try {
      flushStorageData();
      dirty = false;
    } catch (error) {
      // Keep the flag set so the safety interval retries the flush.
      dirty = true;
      onError?.(error);
    }
  };

  const flushIfDirty = (): void => {
    if (dirty) flushNow();
  };

  return {
    markDirty: () => {
      dirty = true;
      flushNow();
    },
    flushNow,
    flushIfDirty,
    isDirty: () => dirty,
  };
}
