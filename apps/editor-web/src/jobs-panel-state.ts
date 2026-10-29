import type { DesktopWorkerConnection } from './desktop-client.js';
import type { BrowserJob, BrowserWorker } from './control-plane-client.js';

export type WorkerPresence = 'connected' | 'disconnected';

const AI_CAPS = ['text.lm-studio', 'text.openrouter'] as const;
const LOCAL_GPU_CAPS = [
  'render.preview.gpu',
  'image.comfy',
  'audio.ml-denoise',
  ...AI_CAPS,
] as const;

export function workerPresence(worker: BrowserWorker, now = Date.now()): WorkerPresence {
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
      ? 'Ready to initialize · Worker connected'
      : 'Ready to initialize · No worker connected';
  return connected
    ? `Initialized · Worker connected${gpu ? ' · GPU ready' : ''}`
    : 'Initialized · No worker connected';
}

export interface WorkerProcessView {
  readonly label: string;
  /** The pill colour, shared with the Workers list. */
  readonly tone: 'connected' | 'queued' | 'disconnected';
  readonly canRetry: boolean;
}

/**
 * How the desktop's own Worker process reads in the Workers tab. A Worker that stopped on its own, and used up
 * its automatic restarts (`degraded`), or was stopped (`offline`), can be started again by the owner.
 */
export function workerProcessView(connection: DesktopWorkerConnection): WorkerProcessView {
  switch (connection) {
    case 'online':
      return { label: 'running', tone: 'connected', canRetry: false };
    case 'starting':
    case 'stopping':
      return { label: connection, tone: 'queued', canRetry: false };
    case 'unknown':
      return { label: 'checking', tone: 'queued', canRetry: false };
    case 'degraded':
    case 'offline':
      return { label: 'stopped', tone: 'disconnected', canRetry: true };
  }
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
