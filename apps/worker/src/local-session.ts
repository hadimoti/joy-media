import type { WorkerSessionStore } from './control-plane-client.js';

/**
 * The desktop app runs this Worker as a child process and gives it a per-run bearer token for its
 * loopback job API. The token lives only in process memory: nothing is written to the Worker state file.
 */
export function createLocalSessionStore(token: string): WorkerSessionStore {
  return {
    loadWorkerSession: () => token,
    clearWorkerSession: () => undefined,
  };
}

/** The loopback form the desktop app's local job API is bound to: `http://127.0.0.1:<port>`, and nothing else. */
const LOOPBACK_API_URL = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/;

/**
 * Whether the value is the desktop app's loopback job API: plain HTTP on 127.0.0.1 with an explicit port
 * from 1 to 65535. A path, query, fragment, credential, other host or other scheme is refused.
 */
export function isLoopbackApiUrl(value: string): boolean {
  const match = LOOPBACK_API_URL.exec(value);
  return match !== null && Number(match[1]) <= 65535;
}

/**
 * The control-plane URL this Worker may use, or undefined when none is set. Any other value is refused,
 * so the Worker never sends its work to another machine. The error does not repeat the URL, which may
 * carry credentials.
 */
export function workerApiUrl(value: string | undefined): string | undefined {
  if (value === undefined || isLoopbackApiUrl(value)) return value;
  throw new Error('JOY_MEDIA_API_URL must be http://127.0.0.1:<port>; remote URLs are refused');
}
