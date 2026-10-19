/** Shared signal state for operations that must finish cleanup before exit. */
export let currentLongRunning = 0;
export let longRunningCancellationExitCode = 130;

export function requestLongRunningCancellation(exitCode = 130): void {
  currentLongRunning = -1;
  longRunningCancellationExitCode = exitCode;
}

export function trackLongRunning<T>(fn: () => Promise<T>): Promise<T> {
  if (currentLongRunning === 0) longRunningCancellationExitCode = 130;
  currentLongRunning++;
  return fn().finally(() => {
    currentLongRunning = Math.max(0, currentLongRunning - 1);
  });
}
