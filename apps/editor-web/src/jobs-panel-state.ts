import type { BrowserJob, BrowserWorker } from './control-plane-client.js';

export type WorkerPresence = 'connected' | 'disconnected' | 'revoked';

export function workerPresence(worker: BrowserWorker, now = Date.now()): WorkerPresence {
  if (worker.revoked) return 'revoked';
  return worker.lastSeenAt !== undefined && worker.lastSeenAt > now - 35_000
    ? 'connected'
    : 'disconnected';
}

export function projectJobStatus(
  projectMissing: boolean,
  workers: readonly BrowserWorker[],
  now = Date.now(),
): string {
  const connected = workers.some((worker) => workerPresence(worker, now) === 'connected');
  if (projectMissing)
    return connected
      ? 'Project is ready to initialize · a local Worker is connected.'
      : 'Project is ready to initialize · no local Worker is connected.';
  return connected
    ? 'Project initialized · a local Worker is connected.'
    : 'Project initialized · no local Worker is connected.';
}

export function jobStateLabel(job: Pick<BrowserJob, 'state' | 'cancelRequested'>): string {
  if (job.cancelRequested) return 'Cancel requested';
  switch (job.state) {
    case 'queued':
      return 'Queued';
    case 'leased':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'canceled':
      return 'Canceled';
    case 'failed':
      return 'Failed';
  }
}
