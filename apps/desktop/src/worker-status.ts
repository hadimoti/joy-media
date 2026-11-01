export type WorkerConnection =
  'unknown' | 'starting' | 'offline' | 'online' | 'degraded' | 'stopping';
export interface WorkerStatus {
  readonly connection: WorkerConnection;
  readonly workerId?: string;
  readonly capabilities: readonly string[];
  readonly lastSeenAt?: string;
  /** Why the Worker stopped, when it did not stop on purpose. Shown to the owner with a retry action. */
  readonly lastError?: string;
}
export type StartupPreference = 'start-worker' | 'leave-worker-alone';
export function normalizeStartupPreference(value: unknown): StartupPreference {
  return value === 'start-worker' || value === 'leave-worker-alone' ? value : 'leave-worker-alone';
}
export function canSubmitWorkerJob(status: WorkerStatus): boolean {
  return status.connection === 'online' && !!status.workerId;
}
