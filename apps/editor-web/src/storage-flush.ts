import type { DesktopJoyBridge } from './desktop-client.js';

export const STORAGE_FLUSH_DEBOUNCE_MS = 500;

export interface StorageFlushNotifier {
  readonly markDirty: () => void;
  readonly dispose: () => void;
}

/** Debounces DOM-storage flush requests and remains inert without the desktop bridge. */
export function createStorageFlushNotifier(
  bridge: Pick<DesktopJoyBridge, 'invoke'> | undefined,
  delayMs = STORAGE_FLUSH_DEBOUNCE_MS,
): StorageFlushNotifier {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const markDirty = (): void => {
    if (disposed || bridge === undefined) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void bridge.invoke('desktop.storage.flush').catch(() => undefined);
    }, delayMs);
  };

  return {
    markDirty,
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
