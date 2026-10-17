/** Shared signal state for operations that must finish cleanup before exit. */
export let currentLongRunning = 0;

export function requestLongRunningCancellation(): void {
  currentLongRunning = -1;
}

export function trackLongRunning<T>(fn: () => Promise<T>): Promise<T> {
  currentLongRunning++;
  return fn().finally(() => {
    currentLongRunning = Math.max(0, currentLongRunning - 1);
  });
}
