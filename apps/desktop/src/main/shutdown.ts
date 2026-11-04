/**
 * Crash-safe shutdown wiring. Dependency-injected so it can be unit-tested without a real
 * Electron `app` object or OS signal delivery.
 *
 * Order matters: the Worker child process is asked to stop before any pending
 * persistence flush, so a mid-export crash can't race a project-store write against a
 * Worker that is still holding a file open.
 */
export interface ShutdownDeps {
  readonly onAppEvent: (
    event: 'before-quit' | 'window-all-closed',
    listener: (event?: { preventDefault(): void }) => void,
  ) => void;
  readonly onProcessSignal: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => void;
  readonly stopWorker: () => void | Promise<void>;
  /** Drops unfinished chunked uploads and their temporary files. */
  readonly discardUploads: () => void | Promise<void>;
  readonly flush: () => void | Promise<void>;
  readonly quit: () => void;
  readonly onQuitRequested?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly platform?: NodeJS.Platform;
}

export function registerShutdownHooks(deps: ShutdownDeps): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  let quitPromise: Promise<void> | undefined;
  let allowQuit = false;

  function shutdown(): Promise<void> {
    if (shutdownPromise === undefined) {
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('Shutdown timed out'));
        }, 30_000);
      });
      const work = (async () => {
        const errors: unknown[] = [];
        for (const step of [deps.stopWorker, deps.discardUploads, deps.flush]) {
          if (timedOut) return;
          try {
            await step();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, 'Shutdown did not complete');
      })();
      shutdownPromise = Promise.race([work, deadline]).finally(() => clearTimeout(timer));
    }
    return shutdownPromise;
  }

  function quitAfterShutdown(): void {
    deps.onQuitRequested?.();
    quitPromise ??= shutdown()
      .catch((error: unknown) => {
        deps.onError?.(error);
      })
      .then(() => {
        allowQuit = true;
        deps.quit();
      });
  }

  deps.onAppEvent('before-quit', (event) => {
    if (allowQuit) return;
    event?.preventDefault();
    quitAfterShutdown();
  });
  deps.onAppEvent('window-all-closed', () => {
    if ((deps.platform ?? process.platform) !== 'darwin') quitAfterShutdown();
    else
      void shutdown().catch((error: unknown) => {
        deps.onError?.(error);
      });
  });
  deps.onProcessSignal('SIGINT', () => {
    quitAfterShutdown();
  });
  deps.onProcessSignal('SIGTERM', () => {
    quitAfterShutdown();
  });
  return shutdown;
}
