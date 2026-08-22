import type { BrowserJob, BrowserWorker } from './control-plane-client.js';

export type WorkerPresence = 'connected' | 'disconnected' | 'revoked';

const AI_CAPS = ['text.lm-studio', 'text.openrouter', 'video.runway', 'edit.higgsfield'] as const;
const LOCAL_GPU_CAPS = ['image.comfy', 'audio.ml-denoise', ...AI_CAPS] as const;

export function workerPresence(worker: BrowserWorker, now = Date.now()): WorkerPresence {
  if (worker.revoked) return 'revoked';
  return worker.lastSeenAt !== undefined && worker.lastSeenAt > now - 35_000
    ? 'connected'
    : 'disconnected';
}

/** True when any connected Worker advertises a local GPU capability (ADR-0018). */
export function hasLocalGpuWorker(workers: readonly BrowserWorker[], now = Date.now()): boolean {
  return workers.some(
    (worker) =>
      workerPresence(worker, now) === 'connected' &&
      LOCAL_GPU_CAPS.some((cap) => worker.capabilities.includes(cap)),
  );
}

export function hasAiCapability(worker: BrowserWorker): boolean {
  return AI_CAPS.some((cap) => worker.capabilities.includes(cap));
}

export function projectJobStatus(
  projectMissing: boolean,
  workers: readonly BrowserWorker[],
  now = Date.now(),
): string {
  const connected = workers.some((worker) => workerPresence(worker, now) === 'connected');
  const gpu = hasLocalGpuWorker(workers, now);
  if (projectMissing)
    return connected
      ? 'آمادهٔ راه‌اندازی · Worker متصل است'
      : 'آمادهٔ راه‌اندازی · هیچ Workerی متصل نیست';
  return connected
    ? `راه‌اندازی شد · Worker متصل است${gpu ? ' · GPU آماده است' : ''}`
    : 'راه‌اندازی شد · هیچ Workerی متصل نیست';
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
