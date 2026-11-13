import type { WorkerConnection, WorkerStatus } from '../worker-status.js';

/** Minimal shape of `node:child_process`'s `ChildProcess` this module depends on. */
export interface SupervisedChild {
  readonly pid?: number | undefined;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
) => SupervisedChild;

export interface WorkerSupervisorOptions {
  readonly spawn: SpawnFn;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /**
   * Environment for each spawn, read at spawn time. The local route needs it, because the
   * loopback URL and token exist only after the local job API has started (see localWorkerEnv).
   */
  readonly env?: () => NodeJS.ProcessEnv | undefined;
  /**
   * Automatic restarts allowed before the Local service is marked degraded. Default 2: the first two
   * crashes restart it and the third crash stops it, where the owner's Retry starts it again (T-F24).
   */
  readonly maxRestarts?: number;
  /** Schedules a restart attempt; overridable so tests can run synchronously. */
  readonly scheduleRestart?: (run: () => void, delayMs: number) => void;
  readonly restartDelayMs?: number;
  /** A run that lasted this long was healthy: its crash starts the restart budget again. Default 10 min. */
  readonly stableRunMs?: number;
  readonly now?: () => string;
  readonly workerId?: () => string;
}

export interface WorkerSupervisor {
  /** Starts the child process if not already running. Idempotent. */
  start(): void;
  /** Requests a graceful stop; SIGTERM then SIGKILL after `killTimeoutMs`. */
  stop(killTimeoutMs?: number): void;
  /** Stops the child and resolves only after it has exited. */
  stopAndWait(killTimeoutMs?: number): Promise<void>;
  status(): WorkerStatus;
}

const DEFAULT_MAX_RESTARTS = 2;
const DEFAULT_RESTART_DELAY_MS = 1000;
const DEFAULT_STABLE_RUN_MS = 10 * 60_000;

export function createWorkerSupervisor(options: WorkerSupervisorOptions): WorkerSupervisor {
  const {
    spawn,
    command,
    args = [],
    cwd,
    env,
    maxRestarts = DEFAULT_MAX_RESTARTS,
    scheduleRestart = (run, delayMs) => {
      setTimeout(run, delayMs);
    },
    restartDelayMs = DEFAULT_RESTART_DELAY_MS,
    stableRunMs = DEFAULT_STABLE_RUN_MS,
    now = () => new Date().toISOString(),
    workerId = () => crypto.randomUUID(),
  } = options;

  let child: SupervisedChild | undefined;
  let connection: WorkerConnection = 'unknown';
  let currentWorkerId: string | undefined;
  let lastSeenAt: string | undefined;
  let lastError: string | undefined;
  let restarts = 0;
  let stopRequested = false;
  let shuttingDown = false;
  let spawnedAtMs = 0;
  // The automatic restart that is waiting for its delay, if any. Stopping the Worker cancels it.
  let pendingRestart: { cancelled: boolean } | undefined;

  function spawnChild(): void {
    stopRequested = false;
    connection = 'starting';
    lastError = undefined;
    currentWorkerId = workerId();
    const childEnv = env?.();
    const proc = spawn(command, args, {
      ...(cwd === undefined ? {} : { cwd }),
      ...(childEnv === undefined ? {} : { env: childEnv }),
    });
    child = proc;
    spawnedAtMs = Date.parse(now());
    function onChildError(error: Error): void {
      if (child !== proc) return;
      if (proc.pid === undefined) {
        handleExit(proc, `Local service could not run: ${error.message}`);
      } else {
        lastError = `Local service process error: ${error.message}`;
        if (!stopRequested) connection = 'degraded';
        proc.once('error', onChildError);
      }
    }
    proc.once('error', onChildError);
    proc.once('exit', (code, signal) => {
      handleExit(
        proc,
        signal === null
          ? `Local service exited with code ${code ?? 'unknown'}`
          : `Local service was stopped by ${signal}`,
      );
    });
    connection = 'online';
    lastSeenAt = now();
  }

  /**
   * Restarts a crashed Worker a bounded number of times, with growing delays. Each later attempt waits
   * twice as long as the one before. The crash reason is kept, so the desktop can show it. After the
   * last attempt the Worker stays degraded until the owner asks for a retry with `start()`.
   */
  function handleExit(exited: SupervisedChild, reason: string): void {
    // Node can report one failure as both an error and an exit. Only the first report counts.
    if (child !== exited) return;
    child = undefined;
    if (stopRequested) {
      connection = 'offline';
      return;
    }
    // A run that lasted long enough was healthy, so its crash starts a new budget.
    if (Date.parse(now()) - spawnedAtMs >= stableRunMs) restarts = 0;
    lastError = reason;
    if (restarts >= maxRestarts) {
      connection = 'degraded';
      return;
    }
    restarts += 1;
    connection = 'starting';
    const attempt = { cancelled: false };
    pendingRestart = attempt;
    scheduleRestart(
      () => {
        if (attempt.cancelled) return;
        pendingRestart = undefined;
        spawnChild();
      },
      restartDelayMs * 2 ** (restarts - 1),
    );
  }

  function stop(killTimeoutMs = 5000): void {
    stopRequested = true;
    connection = 'stopping';
    if (pendingRestart !== undefined) {
      pendingRestart.cancelled = true;
      pendingRestart = undefined;
    }
    if (child === undefined) {
      connection = 'offline';
      return;
    }
    const proc = child;
    let signalled = false;
    try {
      signalled = proc.kill('SIGTERM');
    } catch (error) {
      lastError = `Local service stop request failed: ${String(error)}`;
    }
    if (!signalled && proc.pid !== undefined) proc.kill('SIGKILL');
    setTimeout(() => {
      if (child === proc) {
        try {
          proc.kill('SIGKILL');
        } catch (error) {
          lastError = `Local service could not be stopped: ${String(error)}`;
        }
      }
    }, killTimeoutMs).unref();
  }

  return {
    start() {
      // A restart that is already waiting will start the Worker, so a second spawn now would leak a child.
      if (shuttingDown || child !== undefined || pendingRestart !== undefined) return;
      restarts = 0;
      spawnChild();
    },
    stop,
    stopAndWait(killTimeoutMs = 5000) {
      shuttingDown = true;
      const proc = child;
      if (proc === undefined) {
        stop(killTimeoutMs);
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Local service did not stop')),
          killTimeoutMs + 5000,
        );
        proc.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        proc.once('error', () => {
          if (proc.pid === undefined) {
            clearTimeout(timeout);
            resolve();
            return;
          }
          proc.once('error', (forceError) => {
            clearTimeout(timeout);
            reject(forceError);
          });
          try {
            proc.kill('SIGKILL');
          } catch (forceError) {
            clearTimeout(timeout);
            reject(forceError);
          }
        });
        try {
          stop(killTimeoutMs);
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
    },
    status() {
      return {
        connection,
        ...(currentWorkerId !== undefined ? { workerId: currentWorkerId } : {}),
        capabilities: [],
        ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
        ...(lastError !== undefined ? { lastError } : {}),
      };
    },
  };
}
