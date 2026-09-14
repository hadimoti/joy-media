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
  options: { readonly cwd?: string },
) => SupervisedChild;

export interface WorkerSupervisorOptions {
  readonly spawn: SpawnFn;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Consecutive crash-restarts allowed before the worker is marked degraded. Default 3. */
  readonly maxRestarts?: number;
  /** Schedules a restart attempt; overridable so tests can run synchronously. */
  readonly scheduleRestart?: (run: () => void, delayMs: number) => void;
  readonly restartDelayMs?: number;
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

export function createWorkerSupervisor(options: WorkerSupervisorOptions): WorkerSupervisor {
  const {
    spawn,
    command,
    args = [],
    cwd,
    maxRestarts = DEFAULT_MAX_RESTARTS,
    scheduleRestart = (run, delayMs) => {
      setTimeout(run, delayMs);
    },
    restartDelayMs = DEFAULT_RESTART_DELAY_MS,
    now = () => new Date().toISOString(),
    workerId = () => crypto.randomUUID(),
  } = options;

  let child: SupervisedChild | undefined;
  let connection: WorkerConnection = 'unknown';
  let currentWorkerId: string | undefined;
  let lastSeenAt: string | undefined;
  let restarts = 0;
  let stopRequested = false;

  function spawnChild(): void {
    stopRequested = false;
    connection = 'starting';
    currentWorkerId = workerId();
    const proc = spawn(command, args, cwd === undefined ? {} : { cwd });
    child = proc;
    proc.once('error', () => {
      handleExit();
    });
    proc.once('exit', () => {
      handleExit();
    });
    connection = 'online';
    lastSeenAt = now();
  }

  function handleExit(): void {
    child = undefined;
    if (stopRequested) {
      connection = 'offline';
      return;
    }
    if (restarts >= maxRestarts) {
      connection = 'degraded';
      return;
    }
    restarts += 1;
    connection = 'starting';
    scheduleRestart(() => spawnChild(), restartDelayMs);
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
      };
    },
  };
}
