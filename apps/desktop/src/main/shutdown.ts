/**
 * Crash-safe shutdown wiring. Dependency-injected so it can be unit-tested without a real
 * Electron `app` object or OS signal delivery.
 *
 * Order matters: the Worker child process is asked to stop before any pending
 * persistence flush, so a mid-export crash can't race a project-store write against a
 * Worker that is still holding a file open.
 */
export interface ShutdownDeps {
  readonly onAppEvent: (event: 'before-quit' | 'window-all-closed', listener: () => void) => void;
  readonly onProcessSignal: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => void;
  readonly stopWorker: () => void;
  readonly flush: () => void | Promise<void>;
  readonly quit: () => void;
  readonly platform?: NodeJS.Platform;
}

export function registerShutdownHooks(deps: ShutdownDeps): void {
  let shutdownPromise: Promise<void> | undefined;

  function shutdown(): Promise<void> {
    if (shutdownPromise === undefined) {
      shutdownPromise = (async () => {
        deps.stopWorker();
        await deps.flush();
      })();
    }
    return shutdownPromise;
  }

  deps.onAppEvent('before-quit', () => {
    void shutdown();
  });
  deps.onAppEvent('window-all-closed', () => {
    void shutdown().then(() => {
      if ((deps.platform ?? process.platform) !== 'darwin') deps.quit();
    });
  });
  deps.onProcessSignal('SIGINT', () => {
    void shutdown().then(() => deps.quit());
  });
  deps.onProcessSignal('SIGTERM', () => {
    void shutdown().then(() => deps.quit());
  });
}
