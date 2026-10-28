import type { WorkerSessionStore } from './control-plane-client.js';

/**
 * The desktop app runs this Worker as a child process and gives it a per-run bearer token for its
 * loopback job API. That token stands in for a paired cloud session, so pairing is skipped. The
 * token lives only in process memory: nothing is written to the Worker state file.
 */
export function createLocalSessionStore(token: string): WorkerSessionStore {
  return {
    loadWorkerSession: () => token,
    saveWorkerSession: () => undefined,
    clearWorkerSession: () => undefined,
  };
}

/** A local session may only talk to the loopback address the desktop app bound. */
export function isLoopbackApiUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' && url.hostname === '127.0.0.1';
}
