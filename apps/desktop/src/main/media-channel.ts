import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { DispatchJob, JobDispatchStore } from '../jobs/job-dispatch.js';
import type { CancelResult, JobOrchestrator, SubmitResult } from '../jobs/job-orchestrator.js';
import type {
  LocalAssetRegistration,
  LocalAssetRegistrationResult,
} from '../store/local-assets.js';
import type {
  ProjectDocumentWrite,
  ProjectDocumentWriteResult,
  StoredProjectDocument,
} from '../store/project-documents.js';
import { MAX_LOCAL_ORIGINAL_BYTES, type LocalOriginalWriter } from './local-originals.js';

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

export interface ProjectDocumentPort {
  get(projectId: string, revisionId?: string): StoredProjectDocument | undefined;
  put(write: ProjectDocumentWrite): ProjectDocumentWriteResult;
}

export interface LocalAssetPort {
  register(asset: LocalAssetRegistration): LocalAssetRegistrationResult;
}

export interface MediaChannelDeps {
  readonly orchestrator: JobOrchestrator;
  readonly jobStore: JobDispatchStore;
  readonly projectDocuments: ProjectDocumentPort;
  readonly assets: LocalAssetPort;
  readonly originals: LocalOriginalWriter;
  /** Test seam for reading a derivative file. Defaults to the real filesystem. */
  readonly readDerivative?: (path: string) => Promise<Uint8Array>;
}

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_PAYLOAD_JSON_BYTES = 1024 * 1024;
const MAX_DOCUMENT_JSON_BYTES = 32 * 1024 * 1024;
const MAX_REVISION_ID_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 255;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

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

function asRevisionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_REVISION_ID_LENGTH
    ? value
    : undefined;
}

function asDocumentRead(payload: unknown): { projectId: string; revisionId?: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as Record<string, unknown>;
  const projectId = asId(candidate['projectId']);
  if (projectId === undefined) return undefined;
  if (candidate['revisionId'] === undefined) return { projectId };
  const revisionId = asRevisionId(candidate['revisionId']);
  return revisionId === undefined ? undefined : { projectId, revisionId };
}

function asDocumentWrite(payload: unknown): ProjectDocumentWrite | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as Record<string, unknown>;
  const projectId = asId(candidate['projectId']);
  const revisionId = asRevisionId(candidate['revisionId']);
  // The empty string is the base of a project's first save.
  const baseRevisionId =
    candidate['baseRevisionId'] === '' ? '' : asRevisionId(candidate['baseRevisionId']);
  const document = candidate['document'];
  const lookInstances = candidate['lookInstances'];
  if (projectId === undefined || revisionId === undefined || baseRevisionId === undefined) {
    return undefined;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document))
    return undefined;
  if (Buffer.byteLength(JSON.stringify(document)) > MAX_DOCUMENT_JSON_BYTES) return undefined;
  if (
    lookInstances !== undefined &&
    (typeof lookInstances !== 'object' || lookInstances === null)
  ) {
    return undefined;
  }
  return {
    projectId,
    baseRevisionId,
    revisionId,
    document,
    ...(lookInstances === undefined ? {} : { lookInstances }),
  };
}

function asAssetRegistration(payload: unknown): LocalAssetRegistration | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as Record<string, unknown>;
  const id = asId(candidate['id']);
  const kind = candidate['kind'];
  const displayName = candidate['displayName'];
  const sha256 = candidate['sha256'];
  const bytes = candidate['bytes'];
  if (id === undefined || typeof kind !== 'string' || !ASSET_KIND_PATTERN.test(kind)) {
    return undefined;
  }
  if (typeof displayName !== 'string' || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return undefined;
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) return undefined;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes)) return undefined;
  if (bytes < 0 || bytes > MAX_LOCAL_ORIGINAL_BYTES) return undefined;
  return { id, kind, displayName, sha256, bytes };
}

function asOriginalUpload(payload: unknown): { assetId: string; bytes: Uint8Array } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as Record<string, unknown>;
  const assetId = asId(candidate['assetId']);
  const raw = candidate['bytes'];
  if (assetId === undefined) return undefined;
  const bytes =
    raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : undefined;
  if (bytes === undefined || bytes.byteLength > MAX_LOCAL_ORIGINAL_BYTES) return undefined;
  return { assetId, bytes };
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

  const registerAsset = (payload: unknown): MediaResult => {
    const registration = asAssetRegistration(payload);
    if (registration === undefined) return { ok: false, error: 'Invalid media request' };
    if (deps.assets.register(registration).kind === 'conflict') {
      return { ok: false, error: 'Asset ID is already registered with other content' };
    }
    return { ok: true, data: { id: registration.id } };
  };

  const storeOriginal = async (payload: unknown): Promise<MediaResult> => {
    const upload = asOriginalUpload(payload);
    if (upload === undefined) return { ok: false, error: 'Invalid media request' };
    const result = await deps.originals.storeOriginal(upload.assetId, upload.bytes);
    return result.ok
      ? { ok: true, data: { assetId: upload.assetId } }
      : { ok: false, error: result.error };
  };

  const getDocument = (payload: unknown): MediaResult => {
    const request = asDocumentRead(payload);
    if (request === undefined) return { ok: false, error: 'Invalid media request' };
    const stored = deps.projectDocuments.get(request.projectId, request.revisionId);
    return { ok: true, data: stored ?? null };
  };

  const putDocument = (payload: unknown): MediaResult => {
    const write = asDocumentWrite(payload);
    if (write === undefined) return { ok: false, error: 'Invalid media request' };
    // A conflict or a missing project is an answer, not a failure: the preload only passes a
    // result's data through, so the outcome travels in `data.kind`.
    const result = deps.projectDocuments.put(write);
    if (result.kind === 'saved') {
      return {
        ok: true,
        data: { kind: 'saved', projectId: write.projectId, revisionId: result.revisionId },
      };
    }
    if (result.kind === 'conflict') {
      return { ok: true, data: { kind: 'conflict', revisionId: result.revisionId } };
    }
    return { ok: true, data: { kind: 'missing' } };
  };

  return {
    'desktop.media.asset.register': registerAsset,
    'desktop.media.asset.upload-original': storeOriginal,
    'desktop.media.project.document.get': getDocument,
    'desktop.media.project.document.put': putDocument,
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
