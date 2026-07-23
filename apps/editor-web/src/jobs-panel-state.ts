import type { BrowserJob, BrowserWorker } from './control-plane-client.js';

export type WorkerPresence = 'connected' | 'disconnected' | 'revoked';

const LOCAL_GPU_CAPS = ['image.comfy', 'audio.ml-denoise'] as const;

export function workerPresence(worker: BrowserWorker, now = Date.now()): WorkerPresence {
  if (worker.revoked) return 'revoked';
  return worker.lastSeenAt !== undefined && worker.lastSeenAt > now - 35_000
    ? 'connected'
    : 'disconnected';
}

/** True when any connected Worker advertises a local GPU capability (ADR-0018). */
export function hasLocalGpuWorker(
  workers: readonly BrowserWorker[],
  now = Date.now(),
): boolean {
  return workers.some(
    (worker) =>
      workerPresence(worker, now) === 'connected' &&
      LOCAL_GPU_CAPS.some((cap) => worker.capabilities.includes(cap)),
  );
}

export function projectJobStatus(
  projectMissing: boolean,
  workers: readonly BrowserWorker[],
  now = Date.now(),
): string {
  const connected = workers.some((worker) => workerPresence(worker, now) === 'connected');
  const gpu = hasLocalGpuWorker(workers, now);
  const gpuNote = gpu
    ? ' Local GPU Worker capabilities are available (Comfy / ML denoise).'
    : ' Comfy / ML denoise need a local GPU Worker on your PC (not the VPS).';
  if (projectMissing)
    return connected
      ? `Project is ready to initialize · a local Worker is connected.${gpuNote}`
      : 'Project is ready to initialize · no local Worker is connected.';
  return connected
    ? `Project initialized · a local Worker is connected.${gpuNote}`
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
