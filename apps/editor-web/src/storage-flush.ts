import type { DesktopJoyBridge } from './desktop-client.js';

export const STORAGE_FLUSH_DEBOUNCE_MS = 500;
/** The longest a written value may wait for the desktop shell, however many writes follow it. */
export const STORAGE_FLUSH_MAX_WAIT_MS = 2_000;

export interface StorageFlushNotifier {
  readonly markDirty: () => void;
  /** Sends a pending flush now, such as on page hide. Does nothing when nothing is pending. */
  readonly flushNow: () => void;
  /** Sends a pending flush, then stops the notifier so later writes schedule nothing. */
  readonly dispose: () => void;
}

/**
 * Debounces DOM-storage flush requests and remains inert without the desktop bridge.
 *
 * The trailing debounce alone never fires while writes keep arriving closer together than its
 * delay, so the first unflushed write also sets a deadline: a flush is sent at most `maxWaitMs`
 * after it.
 */
export function createStorageFlushNotifier(
  bridge: Pick<DesktopJoyBridge, 'invoke'> | undefined,
  delayMs = STORAGE_FLUSH_DEBOUNCE_MS,
  maxWaitMs = STORAGE_FLUSH_MAX_WAIT_MS,
): StorageFlushNotifier {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingSince: number | undefined;
  let disposed = false;

  const send = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (pendingSince === undefined || bridge === undefined) return;
    pendingSince = undefined;
    void bridge.invoke('desktop.storage.flush').catch(() => undefined);
  };

  const markDirty = (): void => {
    if (disposed || bridge === undefined) return;
    const now = Date.now();
    pendingSince ??= now;
    if (timer !== undefined) clearTimeout(timer);
    const untilMaxWait = pendingSince + maxWaitMs - now;
    timer = setTimeout(send, Math.max(0, Math.min(delayMs, untilMaxWait)));
  };

  return {
    markDirty,
    flushNow: send,
    dispose: () => {
      send();
      disposed = true;
    },
  };
}
