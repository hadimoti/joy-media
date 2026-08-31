/* global setInterval, clearInterval */

export function throwIfLeaseCanceled(cancelRequested) {
  if (cancelRequested) throw new Error('render export was canceled by the control plane');
}

/**
 * Keeps a leased-job heartbeat single-flight. The control plane extends a
 * lease from the timestamp of each request, so an older response must never
 * be allowed to arrive after a newer request and move the expiry backwards.
 */
export function createLeaseHeartbeatLoop({ heartbeat, intervalMs = 10_000, onHeartbeat }) {
  let heartbeatInFlight;
  let lastError;
  let stopped = false;
  let timer;

  const send = () => {
    if (stopped) return Promise.resolve();
    if (heartbeatInFlight !== undefined) return heartbeatInFlight;
    heartbeatInFlight = Promise.resolve()
      .then(() => heartbeat())
      .then((result) => {
        onHeartbeat?.(result);
      })
      .catch((error) => {
        lastError = error;
        throw error;
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
    return heartbeatInFlight;
  };

  const start = () => {
    timer = setInterval(() => {
      void send().catch(() => undefined);
    }, intervalMs);
  };

  const stop = async () => {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    if (heartbeatInFlight !== undefined) await heartbeatInFlight.catch(() => undefined);
    if (lastError !== undefined) throw lastError;
  };

  return {
    send,
    start,
    stop,
    get lastError() {
      return lastError;
    },
  };
}
