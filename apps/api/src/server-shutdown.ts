import type { Server } from 'node:http';

export type ApiShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface ApiShutdownProcess {
  on(signal: ApiShutdownSignal, listener: () => void): unknown;
  removeListener(signal: ApiShutdownSignal, listener: () => void): unknown;
  exit(code: number): unknown;
}

export function installApiShutdownHandlers(
  server: Pick<Server, 'close'>,
  processLike: ApiShutdownProcess = process,
  timeoutMs = 5_000,
  getAbandonedCount: () => number = () => 0,
): () => void {
  let shuttingDown = false;
  let finished = false;
  let timeout: NodeJS.Timeout | undefined;

  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    if (timeout !== undefined) clearTimeout(timeout);
    processLike.removeListener('SIGINT', onSignal);
    processLike.removeListener('SIGTERM', onSignal);
    processLike.exit(code);
  };

  const onSignal = () => {
    if (shuttingDown) {
      // A second signal is an explicit force-stop and remains unsuccessful.
      finish(1);
      return;
    }
    shuttingDown = true;
    timeout = setTimeout(() => {
      console.warn('JOY Media API graceful shutdown timed out', {
        abandonedCount: Math.max(0, getAbandonedCount()),
      });
      // The process is stopping intentionally; systemd should record a successful stop.
      finish(0);
    }, timeoutMs);
    timeout.unref();
    try {
      server.close((error) => finish(error === undefined ? 0 : 1));
    } catch {
      finish(1);
    }
  };

  processLike.on('SIGINT', onSignal);
  processLike.on('SIGTERM', onSignal);
  return () => {
    if (timeout !== undefined) clearTimeout(timeout);
    processLike.removeListener('SIGINT', onSignal);
    processLike.removeListener('SIGTERM', onSignal);
  };
}
