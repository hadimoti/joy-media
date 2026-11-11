import { Worker } from 'node:worker_threads';
import type {
  ProjectFolderRequestOp,
  ProjectFolderRequestPort,
  ProjectFolderWorkerReply,
} from '@joy-media/project-store';

/**
 * The main-process side of the project-folder worker (project-folder-worker.ts). It starts the worker on the first
 * request and starts it again after it stops, so a crashed worker is not fatal. A request that gets no reply in time
 * is refused, and a late reply to it is dropped. Nothing here reads a folder or the registry.
 */

export interface ProjectFolderWorkerData {
  readonly registryPath: string;
  readonly directory: string;
}

export interface ProjectFolderClientOptions {
  /** The compiled worker script (project-folder-worker.js). */
  readonly workerFile: string;
  readonly registryPath: string;
  /** The folder that holds the project folders (defaultProjectFoldersDirectory). */
  readonly directory: string;
  /** How long a request waits for its reply. Claims wait for locks and Windows' volume check, so this is generous. */
  readonly timeoutMs?: number;
  /** Starts the worker. The app uses worker_threads; tests pass a fake. */
  readonly startWorker?: (workerFile: string, data: ProjectFolderWorkerData) => Worker;
}

export interface ProjectFolderClient extends ProjectFolderRequestPort {
  /** Asks the worker to close the claim registry and stops it. Requests after this start a new worker. */
  shutdown(options?: { readonly final?: boolean }): Promise<void>;
}

/**
 * A claim can run several Windows volume checks, each up to 10 seconds, and then wait for locks. The reply must not
 * come back as "took too long" while the claim still completes, so the wait is generous.
 */
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * An idle worker exits at once on shutdown. A claim already in flight is let finish within this wait. A claim that runs
 * longer is stopped, and what it had partly saved is then the store's documented partial state.
 */
const SHUTDOWN_WAIT_MS = 15_000;

interface PendingRequest {
  /** The worker the request was sent to. Only that worker's exit fails the request. */
  readonly owner: Worker;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createProjectFolderClient(
  options: ProjectFolderClientOptions,
): ProjectFolderClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startWorker =
    options.startWorker ??
    ((workerFile: string, data: ProjectFolderWorkerData) =>
      new Worker(workerFile, { workerData: data }));
  const data: ProjectFolderWorkerData = {
    registryPath: options.registryPath,
    directory: options.directory,
  };
  const pending = new Map<number, PendingRequest>();
  let worker: Worker | undefined;
  let nextId = 1;
  // Set by a final shutdown, when the app quits. A request that arrives then is refused, and no worker is started for it.
  let quitting = false;

  function ensureWorker(): Worker {
    if (worker !== undefined) return worker;
    const started = startWorker(options.workerFile, data);
    started.on('message', (message: unknown) => settle(message));
    started.on('error', () => stopped(started));
    started.on('exit', () => stopped(started));
    worker = started;
    return started;
  }

  function settle(message: unknown): void {
    const reply = asReply(message);
    if (reply === undefined) return;
    const waiting = pending.get(reply.id);
    if (waiting === undefined) return;
    pending.delete(reply.id);
    clearTimeout(waiting.timer);
    if (reply.ok) waiting.resolve(reply.value);
    else waiting.reject(new Error(reply.error));
  }

  /** A worker that stopped fails only the requests it was given. A late exit cannot fail its replacement's requests. */
  function stopped(from: Worker): void {
    if (worker === from) worker = undefined;
    for (const [id, waiting] of pending) {
      if (waiting.owner !== from) continue;
      pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(new Error('The project folder worker stopped'));
    }
  }

  return {
    request(op: ProjectFolderRequestOp, payload: unknown): Promise<unknown> {
      return new Promise<unknown>((resolve, reject) => {
        if (quitting) {
          reject(new Error('The project folder worker stopped'));
          return;
        }
        let target: Worker;
        try {
          target = ensureWorker();
        } catch {
          // A start error can name the app's own paths, so the caller gets a fixed message.
          reject(new Error('The project folder worker could not start'));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('The project folder check took too long'));
        }, timeoutMs);
        pending.set(id, { owner: target, resolve, reject, timer });
        try {
          target.postMessage({ id, op, payload });
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error('The project folder worker stopped'));
        }
      });
    },

    async shutdown(options: { readonly final?: boolean } = {}): Promise<void> {
      if (options.final === true) quitting = true;
      const target = worker;
      if (target === undefined) return;
      worker = undefined;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          void target.terminate();
          resolve();
        }, SHUTDOWN_WAIT_MS);
        target.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        target.postMessage({ id: nextId++, op: 'shutdown', payload: {} });
      });
    },
  };
}

function asReply(message: unknown): ProjectFolderWorkerReply | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const candidate = message as { readonly id?: unknown; readonly ok?: unknown };
  if (typeof candidate.id !== 'number') return undefined;
  if (candidate.ok === true) {
    return { id: candidate.id, ok: true, value: (message as { readonly value?: unknown }).value };
  }
  if (candidate.ok === false) {
    const error = (message as { readonly error?: unknown }).error;
    return { id: candidate.id, ok: false, error: typeof error === 'string' ? error : 'failed' };
  }
  return undefined;
}
