import type { WorkerConnection, WorkerStatus } from '../worker-status.js';

/** Minimal shape of `node:child_process`'s `ChildProcess` this module depends on. */
export interface SupervisedChild {
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
  /** Consecutive crash-restarts allowed before the worker is marked degraded. Default 3. */
  readonly maxRestarts?: number;
  /** Schedules a restart attempt; overridable so tests can run synchronously. */
  readonly scheduleRestart?: (run: () => void, delayMs: number) => void;
  readonly restartDelayMs?: number;
  /** A run that lasted this long was healthy: its crash does not use up the restart budget. Default 60 s. */
  readonly stableRunMs?: number;
  readonly now?: () => string;
  readonly workerId?: () => string;
}

export interface WorkerSupervisor {
  /** Starts the child process if not already running. Idempotent. */
  start(): void;
  /** Requests a graceful stop; SIGTERM then SIGKILL after `killTimeoutMs`. */
  stop(killTimeoutMs?: number): void;
  status(): WorkerStatus;
}

const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_RESTART_DELAY_MS = 1000;
const DEFAULT_STABLE_RUN_MS = 60_000;

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
  let spawnedAtMs = 0;

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
    proc.once('error', (error) => {
      handleExit(`Worker could not run: ${error.message}`);
    });
    proc.once('exit', (code, signal) => {
      handleExit(
        signal === null
          ? `Worker exited with code ${code ?? 'unknown'}`
          : `Worker was stopped by ${signal}`,
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
  function handleExit(reason: string): void {
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
    scheduleRestart(() => spawnChild(), restartDelayMs * 2 ** (restarts - 1));
  }

  return {
    start() {
      if (child !== undefined) return;
      restarts = 0;
      spawnChild();
    },
    stop(killTimeoutMs = 5000) {
      stopRequested = true;
      connection = 'stopping';
      if (child === undefined) {
        connection = 'offline';
        return;
      }
      const proc = child;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (child === proc) proc.kill('SIGKILL');
      }, killTimeoutMs);
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
