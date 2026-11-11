import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ProviderUnavailableError, evaluateEndpoint } from '@joy-media/provider-sdk';
import type { DispatchJob, JobDispatchStore } from '../jobs/job-dispatch.js';
import type { CancelResult, JobOrchestrator, SubmitResult } from '../jobs/job-orchestrator.js';
import type {
  LocalAssetRegistration,
  LocalAssetRegistrationResult,
} from '@joy-media/local-asset-store';
import type { AssetLibraryPort } from '../store/asset-library.js';
import type {
  ProjectDocumentWrite,
  ProjectDocumentWriteResult,
  StoredProjectDocument,
} from '@joy-media/local-asset-store';
import {
  MAX_LOCAL_ORIGINAL_BYTES,
  MAX_ORIGINAL_CHUNK_BYTES,
  type LocalOriginalWriter,
} from './local-originals.js';

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
  'desktop.asset-library.remove-entry',
  'desktop.media.speech.transcribe',
  'desktop.media.asset.register',
  'desktop.media.asset.upload-original',
  'desktop.media.asset.upload-original-chunk',
  'desktop.media.asset.upload-original-finish',
  'desktop.media.asset.upload-original-abort',
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
  readonly library?: AssetLibraryPort;
  readonly whisper?: {
    readonly getEndpoint: () => { readonly endpoint: string; readonly modelId: string } | undefined;
  };
  /** Test seam for reading a derivative file. Defaults to the real filesystem. */
  readonly readDerivative?: (path: string) => Promise<Uint8Array>;
}

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_PAYLOAD_JSON_BYTES = 1024 * 1024;
const MAX_DOCUMENT_JSON_BYTES = 32 * 1024 * 1024;
const MAX_REVISION_ID_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 255;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_LIBRARY_ENTRY_ID_PATTERN = /^joylib-[a-f0-9]{64}$/;
const ASSET_KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SPEECH_LANGUAGES = ['fa-IR', 'en-US'] as const;
const MAX_WHISPER_MEDIA_BYTES = 200 * 1024 * 1024;
const MAX_WHISPER_RESPONSE_BYTES = 64 * 1024 * 1024;
const WHISPER_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const WHISPER_UNAVAILABLE = 'The local Whisper server could not process the media.';
const WHISPER_MEDIA_TOO_LARGE = 'Local Whisper media exceeds the 200 MB limit.';
const WHISPER_RESPONSE_TOO_LARGE = 'The local Whisper server response exceeds the 64 MB limit.';

function requestWhisper(
  url: URL,
  boundary: string,
  body: readonly Buffer[],
  bodyLength: number,
): Promise<{ statusCode: number; body: Buffer; tooLarge: boolean }> {
  let request: ReturnType<typeof httpRequest>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const requestPromise = new Promise<{ statusCode: number; body: Buffer; tooLarge: boolean }>(
    (resolve, reject) => {
      let settled = false;
      let responseTooLarge = false;
      const finish = (result: { statusCode: number; body: Buffer; tooLarge: boolean }) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const options = {
        protocol: url.protocol,
        hostname: '127.0.0.1',
        ...(url.port.length > 0 ? { port: Number(url.port) } : {}),
        ...(url.protocol === 'https:' && url.hostname === 'localhost'
          ? { servername: 'localhost' }
          : {}),
        method: 'POST',
        path: `${url.pathname.replace(/\/+$/, '')}/audio/transcriptions`,
        headers: {
          Host: url.host,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(bodyLength),
        },
      };
      request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        options,
        (response: IncomingMessage) => {
          response.on('error', (error) => {
            if (!responseTooLarge) fail(error);
          });
          const statusCode = response.statusCode ?? 0;
          if (statusCode >= 300 && statusCode < 400) {
            request.destroy();
            finish({ statusCode, body: Buffer.alloc(0), tooLarge: false });
            return;
          }
          const contentLength = response.headers['content-length'];
          if (contentLength !== undefined && Number(contentLength) > MAX_WHISPER_RESPONSE_BYTES) {
            responseTooLarge = true;
            request.destroy();
            finish({ statusCode, body: Buffer.alloc(0), tooLarge: true });
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          response.on('data', (chunk: Buffer | Uint8Array) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += bytes.byteLength;
            if (received > MAX_WHISPER_RESPONSE_BYTES) {
              responseTooLarge = true;
              request.destroy();
              finish({ statusCode, body: Buffer.alloc(0), tooLarge: true });
              return;
            }
            chunks.push(bytes);
          });
          response.on('end', () =>
            finish({ statusCode, body: Buffer.concat(chunks, received), tooLarge: false }),
          );
        },
      );
      request.on('error', (error) => {
        if (responseTooLarge) return;
        fail(error);
      });

      timer = setTimeout(
        () => request.destroy(new Error('Local Whisper request timed out')),
        WHISPER_REQUEST_TIMEOUT_MS,
      );
      void (async () => {
        try {
          for (const part of body) {
            for (let offset = 0; offset < part.byteLength; offset += 64 * 1024) {
              if (!request.write(part.subarray(offset, offset + 64 * 1024))) {
                await new Promise<void>((resolveDrain, rejectDrain) => {
                  request.once('drain', resolveDrain);
                  request.once('error', rejectDrain);
                });
              }
            }
          }
          request.end();
        } catch (error) {
          request.destroy(error instanceof Error ? error : new Error('Request body write failed'));
        }
      })();
    },
  );
  return (async () => {
    try {
      return await requestPromise;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  })();
}

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

/**
 * A Worker error can name the file a job failed on, so an error with a path separator is replaced
 * by a fixed sentence. The job record keeps the full text.
 */
export function publicJobError(error: string | undefined): string | undefined {
  if (error === undefined) return undefined;
  return /[\\/]/.test(error) ? 'The job failed. Its details are not shown here.' : error;
}

/** The job as the editor may see it: never the lease token, the worker ID, or any path. */
function publicJob(job: DispatchJob): Record<string, unknown> {
  return {
    id: job.id,
    jobType: job.jobType,
    status: job.status,
    progress: job.progress,
    attempts: job.attempts,
    error: publicJobError(job.error),
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
  if (lookInstances !== undefined) {
    if (typeof lookInstances !== 'object' || lookInstances === null) return undefined;
    if (Buffer.byteLength(JSON.stringify(lookInstances)) > MAX_DOCUMENT_JSON_BYTES)
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
  const descriptor = candidate['descriptor'];
  if (id === undefined || typeof kind !== 'string' || !ASSET_KIND_PATTERN.test(kind)) {
    return undefined;
  }
  if (typeof displayName !== 'string' || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return undefined;
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) return undefined;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes)) return undefined;
  if (bytes < 0 || bytes > MAX_LOCAL_ORIGINAL_BYTES) return undefined;
  if (descriptor !== undefined && !isPlainObject(descriptor)) return undefined;
  return {
    id,
    kind,
    displayName,
    sha256,
    bytes,
    ...(descriptor === undefined ? {} : { descriptor }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Says why an original is refused when it is above the local limit, so the editor can tell the user. */
const OVERSIZED_ORIGINAL_MESSAGE = `The original is larger than the ${MAX_LOCAL_ORIGINAL_BYTES / 1024 ** 3} GiB local limit`;

function isOversizedRegistration(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const bytes = (payload as Record<string, unknown>)['bytes'];
  return typeof bytes === 'number' && bytes > MAX_LOCAL_ORIGINAL_BYTES;
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

/** One piece of a chunked upload: which asset, where the piece starts in the file, and its bytes. */
function asOriginalChunk(
  payload: unknown,
): { assetId: string; offset: number; bytes: Uint8Array } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as Record<string, unknown>;
  const assetId = asId(candidate['assetId']);
  const offset = candidate['offset'];
  const raw = candidate['bytes'];
  if (assetId === undefined || typeof offset !== 'number' || !Number.isSafeInteger(offset)) {
    return undefined;
  }
  if (offset < 0) return undefined;
  const bytes =
    raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : undefined;
  if (bytes === undefined || bytes.byteLength > MAX_ORIGINAL_CHUNK_BYTES) return undefined;
  return { assetId, offset, bytes };
}

/** A request about one chunked upload, identified by its asset. */
function asAssetRequest(payload: unknown): { assetId: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const assetId = asId((payload as Record<string, unknown>)['assetId']);
  return assetId === undefined ? undefined : { assetId };
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

  const removeLibraryEntry = async (payload: unknown): Promise<MediaResult> => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'Invalid asset library entry id' };
    }
    const id = (payload as Record<string, unknown>)['id'];
    if (
      typeof id !== 'string' ||
      !ASSET_LIBRARY_ENTRY_ID_PATTERN.test(id) ||
      id.includes('..') ||
      /[\\/]/.test(id)
    ) {
      return {
        ok: false,
        error:
          'Invalid asset library entry id: expected joylib- followed by 64 lowercase hexadecimal characters',
      };
    }
    if (deps.library === undefined) {
      return { ok: false, error: 'Asset library is not available in this build' };
    }
    try {
      return { ok: true, data: await deps.library.removeEntry(id) };
    } catch (error) {
      console.error('Catalog removal failed', error);
      const errorMessage = error instanceof Error ? error.message : undefined;
      if (
        errorMessage === 'The asset library is busy. Try the import again.' ||
        errorMessage ===
          'Invalid asset library entry id: expected joylib- followed by 64 lowercase hexadecimal characters'
      ) {
        return { ok: false, error: errorMessage };
      }
      return { ok: false, error: 'Catalog removal failed' };
    }
  };

  const notAvailable = (): MediaResult => ({ ok: false, error: NOT_AVAILABLE_YET });

  const transcribeSpeech = async (payload: unknown): Promise<MediaResult> => {
    const unavailable = (message: string): never => {
      throw new ProviderUnavailableError(message);
    };
    if (deps.whisper === undefined) return unavailable('Local Whisper is not configured.');
    if (!isPlainObject(payload)) return unavailable('Invalid local Whisper request.');
    const language = payload['language'];
    const mediaType = payload['mediaType'];
    const rawMedia = payload['media'];
    const media =
      rawMedia instanceof Uint8Array
        ? rawMedia
        : rawMedia instanceof ArrayBuffer
          ? new Uint8Array(rawMedia)
          : undefined;
    if (
      typeof mediaType !== 'string' ||
      !/^(audio|video)\/[^\s;\r\n]+(?:\s*;[^\r\n]*)?$/i.test(mediaType)
    ) {
      return unavailable('Local Whisper only accepts audio or video media.');
    }
    if (
      !(SPEECH_LANGUAGES as readonly unknown[]).includes(language) ||
      media === undefined ||
      media.byteLength === 0
    ) {
      return unavailable('Invalid local Whisper request.');
    }
    if (media.byteLength > MAX_WHISPER_MEDIA_BYTES) return unavailable(WHISPER_MEDIA_TOO_LARGE);
    const saved = deps.whisper.getEndpoint();
    if (saved === undefined) return unavailable('Local Whisper is not configured.');
    const { endpoint, modelId } = saved;
    const verdict = evaluateEndpoint('custom', endpoint);
    if (!verdict.allowed || verdict.kind !== 'loopback') {
      return unavailable('The saved local Whisper endpoint was refused.');
    }
    const url = new URL(endpoint);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      return unavailable('The saved local Whisper endpoint was refused.');
    }

    const boundary = `joy-whisper-${randomBytes(18).toString('hex')}`;
    const fields = [
      ['model', modelId],
      ['language', language === 'fa-IR' ? 'fa' : 'en'],
      ['response_format', 'verbose_json'],
      ['timestamp_granularities[]', 'word'],
    ] as const;
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio"\r\nContent-Type: ${mediaType}\r\n\r\n`,
    );
    const fieldParts = fields.map(([name, value]) =>
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`,
      ),
    );
    const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = [
      prefix,
      Buffer.from(media.buffer, media.byteOffset, media.byteLength),
      ...fieldParts,
      ending,
    ];
    const bodyLength = body.reduce((sum, part) => sum + part.length, 0);
    let response: { statusCode: number; body: Buffer; tooLarge: boolean };
    try {
      response = await requestWhisper(url, boundary, body, bodyLength);
    } catch {
      return unavailable(WHISPER_UNAVAILABLE);
    }
    if (response.tooLarge) return unavailable(WHISPER_RESPONSE_TOO_LARGE);
    if (response.statusCode >= 300 && response.statusCode < 400)
      return unavailable(WHISPER_UNAVAILABLE);
    if (response.statusCode < 200 || response.statusCode >= 300)
      return unavailable(WHISPER_UNAVAILABLE);

    let reply: unknown;
    try {
      reply = JSON.parse(response.body.toString('utf8')) as unknown;
    } catch {
      return unavailable('The local Whisper server returned an invalid reply.');
    }
    const candidates: unknown[] = [];
    if (isPlainObject(reply)) {
      if (Array.isArray(reply['words'])) candidates.push(...reply['words']);
      if (Array.isArray(reply['segments'])) {
        for (const segment of reply['segments']) {
          if (isPlainObject(segment) && Array.isArray(segment['words'])) {
            candidates.push(...segment['words']);
          }
        }
      }
    }
    const words = candidates.flatMap((candidate) => {
      if (!isPlainObject(candidate)) return [];
      const text = candidate['word'] ?? candidate['text'];
      const start = candidate['start'];
      const end = candidate['end'];
      if (
        typeof text !== 'string' ||
        text.trim().length === 0 ||
        typeof start !== 'number' ||
        !Number.isFinite(start) ||
        start < 0 ||
        typeof end !== 'number' ||
        !Number.isFinite(end) ||
        end < start ||
        !Number.isSafeInteger(Math.round(start * 1_000_000)) ||
        !Number.isSafeInteger(Math.round(end * 1_000_000))
      ) {
        return [];
      }
      const probability = candidate['probability'];
      return [
        {
          text,
          startUs: Math.round(start * 1_000_000),
          endUs: Math.round(end * 1_000_000),
          ...(typeof probability === 'number' &&
          Number.isFinite(probability) &&
          probability >= 0 &&
          probability <= 1
            ? { confidence: probability }
            : {}),
        },
      ];
    });
    if (words.length === 0) return unavailable('The local Whisper reply has no timed words.');
    return {
      ok: true,
      data: {
        language,
        words,
        speakers: [],
        provenance: {
          providerId: 'joy.local-whisper',
          modelId,
          createdAt: new Date().toISOString(),
        },
      },
    };
  };

  const registerAsset = (payload: unknown): MediaResult => {
    const registration = asAssetRegistration(payload);
    if (registration === undefined) {
      return isOversizedRegistration(payload)
        ? { ok: false, error: OVERSIZED_ORIGINAL_MESSAGE }
        : { ok: false, error: 'Invalid media request' };
    }
    if (deps.assets.register(registration).kind === 'conflict') {
      return { ok: false, error: 'Asset ID is already registered with other content' };
    }
    return { ok: true, data: { id: registration.id } };
  };

  const storeOriginal = async (payload: unknown): Promise<MediaResult> => {
    const upload = asOriginalUpload(payload);
    if (upload === undefined) return { ok: false, error: 'Invalid media request' };
    const result = await deps.originals.storeOriginal(upload.assetId, upload.bytes);
    if (!result.ok) return { ok: false, error: result.error };
    if (deps.library !== undefined) {
      const libraryResult = await deps.library.addAsset(upload.assetId);
      if (!libraryResult.ok) return { ok: false, error: libraryResult.error };
    }
    return { ok: true, data: { assetId: upload.assetId } };
  };

  const appendOriginalChunk = async (payload: unknown): Promise<MediaResult> => {
    const chunk = asOriginalChunk(payload);
    if (chunk === undefined) return { ok: false, error: 'Invalid media request' };
    const result = await deps.originals.appendOriginalChunk(
      chunk.assetId,
      chunk.offset,
      chunk.bytes,
    );
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, data: { assetId: chunk.assetId } };
  };

  const finishOriginalUpload = async (payload: unknown): Promise<MediaResult> => {
    const request = asAssetRequest(payload);
    if (request === undefined) return { ok: false, error: 'Invalid media request' };
    const result = await deps.originals.finishOriginalUpload(request.assetId);
    if (!result.ok) return { ok: false, error: result.error };
    if (deps.library !== undefined) {
      const libraryResult = await deps.library.addAsset(request.assetId);
      if (!libraryResult.ok) return { ok: false, error: libraryResult.error };
    }
    return { ok: true, data: { assetId: request.assetId } };
  };

  const abortOriginalUpload = async (payload: unknown): Promise<MediaResult> => {
    const request = asAssetRequest(payload);
    if (request === undefined) return { ok: false, error: 'Invalid media request' };
    await deps.originals.abortOriginalUpload(request.assetId);
    return { ok: true, data: { assetId: request.assetId } };
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
    'desktop.asset-library.remove-entry': removeLibraryEntry,
    'desktop.media.speech.transcribe': transcribeSpeech,
    'desktop.media.asset.register': registerAsset,
    'desktop.media.asset.upload-original': storeOriginal,
    'desktop.media.asset.upload-original-chunk': appendOriginalChunk,
    'desktop.media.asset.upload-original-finish': finishOriginalUpload,
    'desktop.media.asset.upload-original-abort': abortOriginalUpload,
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
