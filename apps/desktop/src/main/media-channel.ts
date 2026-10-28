import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { DispatchJob, JobDispatchStore } from '../jobs/job-dispatch.js';
import type { CancelResult, JobOrchestrator, SubmitResult } from '../jobs/job-orchestrator.js';

/**
 * The `desktop.media.*` channels (PLAN-v4 §6i). The editor reaches the local host through these,
 * and each one calls the existing job orchestrator directly. There is no second job API.
 *
 * Paths never leave the main process: a job's derivative path is read here, and only its bytes
 * and checksum are returned. Operations whose local stores are not built yet return an explicit
 * "not available" result. They are not silently routed to a remote host.
 */

export type MediaResult = {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
};

export const MEDIA_CHANNELS = [
  'desktop.media.asset.register',
  'desktop.media.asset.upload-original',
  'desktop.media.project.document.get',
  'desktop.media.project.document.put',
  'desktop.media.render.enqueue',
  'desktop.media.job.status',
  'desktop.media.job.cancel',
  'desktop.media.derivative.bytes',
  'desktop.media.audio.denoise',
  'desktop.media.preview.frame',
  'desktop.media.workers.list',
] as const;

export type MediaChannel = (typeof MEDIA_CHANNELS)[number];

export interface MediaChannelDeps {
  readonly orchestrator: JobOrchestrator;
  readonly jobStore: JobDispatchStore;
  /** Test seam for reading a derivative file. Defaults to the real filesystem. */
  readonly readDerivative?: (path: string) => Promise<Uint8Array>;
}

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_PAYLOAD_JSON_BYTES = 1024 * 1024;

const NOT_AVAILABLE_YET =
  'This media operation is not available in this build yet; its local store is still being built';

function asId(value: unknown): string | undefined {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined;
}

function asRequest(
  payload: unknown,
): { refId: string; payload: Record<string, unknown> } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as Record<string, unknown>;
  const refId = asId(candidate['refId']);
  const body = candidate['payload'];
  if (refId === undefined) return undefined;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_PAYLOAD_JSON_BYTES) return undefined;
  return { refId, payload: body as Record<string, unknown> };
}

function asJobId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  return asId((payload as Record<string, unknown>)['jobId']);
}

/** The job as the editor may see it: never the lease token, the worker ID, or any path. */
function publicJob(job: DispatchJob): Record<string, unknown> {
  return {
    id: job.id,
    jobType: job.jobType,
    status: job.status,
    progress: job.progress,
    attempts: job.attempts,
    error: job.error,
    cancelRequested: job.cancelRequested,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.derivative === undefined
      ? {}
      : {
          derivative: {
            sha256: job.derivative.sha256,
            bytes: job.derivative.bytes,
            mimeType: job.derivative.mimeType,
          },
        }),
  };
}

function fromSubmit(result: SubmitResult): MediaResult {
  if (result.ok) return { ok: true, data: { jobId: result.jobId } };
  return { ok: false, error: result.message };
}

function fromCancel(result: CancelResult): MediaResult {
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, data: publicJob(result.job) };
}

export function createMediaChannelHandlers(
  deps: MediaChannelDeps,
): Readonly<Record<MediaChannel, (payload: unknown) => MediaResult | Promise<MediaResult>>> {
  const readDerivative = deps.readDerivative ?? ((path: string) => readFile(path));

  const submitJob = (jobType: string, payload: unknown): MediaResult => {
    const request = asRequest(payload);
    if (request === undefined) return { ok: false, error: 'Invalid media request' };
    return fromSubmit(
      deps.orchestrator.submit({
        jobType,
        refId: request.refId,
        kind: jobType,
        payload: request.payload,
      }),
    );
  };

  const notAvailable = (): MediaResult => ({ ok: false, error: NOT_AVAILABLE_YET });

  return {
    'desktop.media.asset.register': notAvailable,
    'desktop.media.asset.upload-original': notAvailable,
    'desktop.media.project.document.get': notAvailable,
    'desktop.media.project.document.put': notAvailable,
    'desktop.media.preview.frame': notAvailable,
    'desktop.media.render.enqueue': (payload) => submitJob('render.export', payload),
    // The orchestrator does not dispatch audio.ml-denoise yet (only asset.thumbnail, render.export
    // and upscale.image), so denoise is refused rather than queued.
    'desktop.media.audio.denoise': notAvailable,
    'desktop.media.job.status': (payload) => {
      const jobId = asJobId(payload);
      if (jobId === undefined) return { ok: false, error: 'Invalid job id' };
      const job = deps.orchestrator.get(jobId);
      if (job === undefined) return { ok: false, error: 'Unknown job' };
      return { ok: true, data: publicJob(job) };
    },
    'desktop.media.job.cancel': (payload) => {
      const jobId = asJobId(payload);
      if (jobId === undefined) return { ok: false, error: 'Invalid job id' };
      return fromCancel(deps.orchestrator.requestCancel(jobId));
    },
    'desktop.media.derivative.bytes': async (payload) => {
      const jobId = asJobId(payload);
      if (jobId === undefined) return { ok: false, error: 'Invalid job id' };
      const job = deps.orchestrator.get(jobId);
      if (job?.derivative === undefined) return { ok: false, error: 'No derivative for this job' };
      let bytes: Uint8Array;
      try {
        bytes = await readDerivative(job.derivative.path);
      } catch {
        return { ok: false, error: 'Derivative file is not available' };
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== job.derivative.sha256) {
        return { ok: false, error: 'Derivative failed its checksum' };
      }
      return { ok: true, data: { mimeType: job.derivative.mimeType, sha256, bytes } };
    },
    'desktop.media.workers.list': () => {
      const presence = deps.jobStore.presence();
      if (presence === undefined) return { ok: true, data: [] };
      return {
        ok: true,
        data: [
          {
            workerId: presence.workerId,
            capabilities: [...presence.capabilities],
            lastHelloAt: presence.lastHelloAt,
          },
        ],
      };
    },
  };
}
