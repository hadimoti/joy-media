import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { isAllowedIpcRequest } from '../ipc.js';
import { SYNCHRONOUS_IPC_CHANNELS } from '../ipc.js';
import type { IpcChannel, IpcRequest } from '../ipc.js';
import type { DerivativeKind, OpaqueFileRef } from '../file-boundary.js';
import { normalizeStartupPreference } from '../worker-status.js';
import type { WorkerStatus } from '../worker-status.js';
import type { FileRegistry } from './file-registry.js';
import type { WorkerSupervisor } from './worker-supervisor.js';
import type {
  JobRecord,
  LocalDatabase,
  MediaKind,
  ProviderProfile,
} from '../store/local-database.js';
import type { DispatchJob } from '../jobs/job-dispatch.js';
import { createJobOrchestrator } from '../jobs/job-orchestrator.js';
import type { MediaStage, StageBeginRequest } from './media-stage.js';
import { probeAudioPresence, type AudioPresence } from './media-presence.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateProviderProfileInput } from '@joy-media/provider-sdk';
import {
  isEditorProjectStorageKey,
  MAX_EDITOR_PROJECT_STORAGE_KEY_LENGTH,
  MAX_EDITOR_PROJECT_STORAGE_VALUE_BYTES,
} from '@joy-media/project-persistence/editor-storage';
import type { DirectProviderProbeReport, SecretStore } from '@joy-media/provider-sdk';
import type { AutoUpdateDecision, SignedReleaseManifest } from './auto-update-policy.js';

/** Native "select a file" prompt, injected so main-process wiring stays unit-testable. */
export type ShowOpenDialog = () => Promise<{
  readonly canceled: boolean;
  readonly path: string | undefined;
}>;

/** Records a freshly selected file into the media manifest. Injected so ipc-handlers.ts never
 * touches real disk I/O directly — see main/media-checksum.ts for the real implementation. */
export type ProbeMedia = (path: string) => Promise<{
  readonly checksum: string;
  readonly byteSize: number;
  readonly kind: MediaKind;
}>;

/** Runs the host-side direct-provider connectivity probe (never exposes the key to the
 * renderer). Injected — see main/electron-entry.ts for the real wiring to
 * provider-sdk's `probeOpenAiCompatibleProvider` + global `fetch`. */
export type ProbeProvider = (request: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
}) => Promise<DirectProviderProbeReport>;

/** Evaluates a release manifest the renderer already fetched from the public
 * `GET /v1/releases/:channel` route against the pinned release-signing public key and the
 * running app's own version. Injected so the two pieces of trust material a compromised
 * renderer must never be able to supply itself — the pinned public key and the app's real
 * running version (`app.getVersion()`) — stay main-process-only; see main/electron-entry.ts
 * for the real wiring to `../auto-update-policy.js`'s `evaluateAutoUpdate`. This never
 * downloads or installs anything — see that module's own doc comment. */
export type CheckForUpdate = (request: {
  readonly manifest: SignedReleaseManifest;
  readonly subscriptionActive: boolean;
}) => AutoUpdateDecision;

export interface IpcHandlerDeps {
  readonly fileRegistry: FileRegistry;
  readonly workerSupervisor: WorkerSupervisor;
  readonly showOpenDialog: ShowOpenDialog;
  readonly showOpenDirectoryDialog?: ShowOpenDialog;
  readonly localDatabase: LocalDatabase;
  readonly probeMedia: ProbeMedia;
  readonly secretStore: SecretStore;
  readonly probeProvider: ProbeProvider;
  readonly checkForUpdate: CheckForUpdate;
  readonly handleWindowControl?: (
    action: 'minimize' | 'maximize' | 'close' | 'is-maximized' | 'toggle-fullscreen',
  ) => Promise<boolean | void> | boolean | void;
  readonly now?: () => string;
  readonly newId?: () => string;
  /** Verified copies of editor-imported originals; absent when the staging root is unavailable. */
  readonly mediaStage?: MediaStage;
  /** ffprobe-backed audio check; injected so unit tests never spawn a process. */
  readonly probeAudio?: (path: string) => Promise<AudioPresence>;
}

/** Largest derivative the renderer may read back (thumbnails are far smaller). */
export const MAX_DERIVATIVE_READ_BYTES = 16 * 1024 * 1024;

export interface IpcResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export type IpcHandler = (payload: unknown) => Promise<IpcResult> | IpcResult;

/** Builds the channel -> handler dispatch table. Never exposed directly to the renderer. */
/** Maps a renderer-visible derivative kind onto the Worker job type that produces it. */
function derivativeJobType(kind: DerivativeKind): string {
  return kind === 'thumbnail' ? 'asset.thumbnail' : 'render.export';
}

/** Renderer-safe view of a dispatched job: never the lease token or a local derivative path. */
function publicJob(job: DispatchJob): Record<string, unknown> {
  return {
    id: job.id,
    kind: job.kind,
    jobType: job.jobType,
    refId: job.refId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    progress: job.progress,
    attempts: job.attempts,
    cancelRequested: job.cancelRequested,
    ...(job.error === undefined ? {} : { error: job.error }),
  };
}

export function createIpcHandlers(deps: IpcHandlerDeps): Record<IpcChannel, IpcHandler> {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const jobs = createJobOrchestrator({
    store: deps.localDatabase.jobDispatch,
    now,
    newId: () => deps.localDatabase.nextJobId(),
  });

  return {
    'desktop.select-file': async () => {
      const result = await deps.showOpenDialog();
      if (result.canceled || result.path === undefined) return { ok: true, data: undefined };
      const ref = deps.fileRegistry.registerSelection(result.path);
      // Record what we know locally right away; the Worker remains the owner of real probing
      // (demuxing, precise duration/codec) once it picks up a job for this ref.
      const probe = await deps.probeMedia(result.path);
      deps.localDatabase.recordMedia({
        refId: ref.id,
        checksum: probe.checksum,
        kind: probe.kind,
        byteSize: probe.byteSize,
        lastVerifiedAt: now(),
      });
      return { ok: true, data: ref };
    },
    'desktop.revoke-file': (payload) => {
      const ref = asOpaqueFileRef(payload);
      if (ref === undefined) return { ok: false, error: 'Invalid file reference' };
      deps.fileRegistry.revoke(ref);
      deps.localDatabase.removeMedia(ref.id);
      return { ok: true };
    },
    'desktop.request-derivative': (payload) => {
      const request = asDerivativeRequest(payload);
      if (request === undefined) return { ok: false, error: 'Invalid derivative request' };
      try {
        const approval = deps.fileRegistry.requestDerivative(request.ref, request.kind);
        const submitted = jobs.submit({
          jobType: derivativeJobType(request.kind),
          refId: request.ref.id,
          kind: `derivative:${request.kind}`,
        });
        if (!submitted.ok) return { ok: false, error: `${submitted.code}: ${submitted.message}` };
        return { ok: true, data: { ...approval, jobId: submitted.jobId } };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
    'desktop.worker-status': (): IpcResult => ({ ok: true, data: deps.workerSupervisor.status() }),
    'desktop.startup-preference': (payload): IpcResult => {
      const preference = normalizeStartupPreference(payload);
      if (preference === 'start-worker') deps.workerSupervisor.start();
      return { ok: true, data: preference };
    },
    'desktop.job-status': (payload): IpcResult => {
      const jobId = asJobId(payload);
      if (jobId === undefined) return { ok: false, error: 'Invalid job id' };
      const dispatched = jobs.get(jobId);
      if (dispatched !== undefined) return { ok: true, data: publicJob(dispatched) };
      const job = deps.localDatabase.getJob(jobId);
      if (job === undefined) return { ok: false, error: 'Unknown job id' };
      return { ok: true, data: job };
    },
    'desktop.cancel-job': (payload): IpcResult => {
      const jobId = asJobId(payload);
      if (jobId === undefined) return { ok: false, error: 'Invalid job id' };
      if (jobs.get(jobId) !== undefined) {
        // Worker-dispatched jobs are cancelled through the orchestrator: a running job is flagged
        // and the Worker stops it on its next heartbeat, so the status never claims more than it did.
        const cancelled = jobs.requestCancel(jobId);
        if (!cancelled.ok) return { ok: false, error: cancelled.error };
        return { ok: true, data: publicJob(cancelled.job) };
      }
      const job = deps.localDatabase.getJob(jobId);
      if (job === undefined) return { ok: false, error: 'Unknown job id' };
      if (job.status !== 'queued' && job.status !== 'running') {
        return { ok: false, error: `Cannot cancel a job in status "${job.status}"` };
      }
      const updated: JobRecord | undefined = deps.localDatabase.updateJobStatus(
        jobId,
        'cancelled',
        'cancelled by user',
      );
      return { ok: true, data: updated };
    },
    'desktop.job-derivative.read': async (payload): Promise<IpcResult> => {
      const jobId = asJobId(payload);
      if (jobId === undefined) return { ok: false, error: 'Invalid job id' };
      const derivative = deps.localDatabase.jobDispatch.get(jobId)?.derivative;
      if (derivative === undefined) return { ok: false, error: 'This job has no derivative yet' };
      if (derivative.bytes > MAX_DERIVATIVE_READ_BYTES)
        return { ok: false, error: 'Derivative is too large to show here' };
      return guarded(async () => {
        const bytes = await readFile(derivative.path);
        // The file is re-hashed before it reaches the renderer, so the derivative the editor shows
        // is the exact one the Worker verified and stored.
        if (createHash('sha256').update(bytes).digest('hex') !== derivative.sha256)
          throw new Error('Derivative failed integrity verification');
        return { mimeType: derivative.mimeType, bytes: new Uint8Array(bytes) };
      });
    },
    'desktop.media-stage.begin': (payload): Promise<IpcResult> => {
      const stage = deps.mediaStage;
      if (stage === undefined) return Promise.resolve(STAGE_UNAVAILABLE);
      const request = asStageBeginRequest(payload);
      if (request === undefined)
        return Promise.resolve({ ok: false, error: 'Invalid media stage request' });
      return guarded(() => stage.begin(request));
    },
    'desktop.media-stage.chunk': (payload): Promise<IpcResult> => {
      const stage = deps.mediaStage;
      if (stage === undefined) return Promise.resolve(STAGE_UNAVAILABLE);
      const request = asStageChunkRequest(payload);
      if (request === undefined)
        return Promise.resolve({ ok: false, error: 'Invalid media chunk' });
      return guarded(() => stage.chunk(request));
    },
    'desktop.media-stage.finish': (payload): Promise<IpcResult> => {
      const stage = deps.mediaStage;
      if (stage === undefined) return Promise.resolve(STAGE_UNAVAILABLE);
      const uploadId = asUploadId(payload);
      if (uploadId === undefined)
        return Promise.resolve({ ok: false, error: 'Invalid media upload' });
      return guarded(() => stage.finish({ uploadId }));
    },
    'desktop.media-stage.abort': (payload): Promise<IpcResult> => {
      const stage = deps.mediaStage;
      if (stage === undefined) return Promise.resolve(STAGE_UNAVAILABLE);
      const uploadId = asUploadId(payload);
      if (uploadId === undefined)
        return Promise.resolve({ ok: false, error: 'Invalid media upload' });
      return guarded(async () => {
        await stage.abort({ uploadId });
        return undefined;
      });
    },
    'desktop.media-audio-presence': (payload): Promise<IpcResult> => {
      const stage = deps.mediaStage;
      if (stage === undefined) return Promise.resolve(STAGE_UNAVAILABLE);
      const request = asAudioPresenceRequest(payload);
      if (request === undefined) return Promise.resolve({ ok: false, error: 'Invalid media hash' });
      return guarded(async (): Promise<AudioPresence> => {
        const path = await stage.cachedPath(request.sha256, request.bytes);
        // Only a verified staged copy can be probed; anything else is reported as unknown.
        if (path === undefined) return { status: 'unknown', reason: 'not-staged' };
        return (deps.probeAudio ?? ((file: string) => probeAudioPresence(file)))(path);
      });
    },
    'desktop.provider-profile.save': async (payload): Promise<IpcResult> => {
      const request = asSaveProviderProfileRequest(payload);
      if (request === undefined) {
        return { ok: false, error: 'Invalid provider profile request' };
      }
      const issues = validateProviderProfileInput(request);
      if (issues.length > 0) {
        return { ok: false, error: issues.map((issue) => issue.message).join('; ') };
      }

      const timestamp = now();
      let id = request.id;
      let secretHandleId: string;
      let createdAt: string;
      if (id !== undefined) {
        const existing = deps.localDatabase.getProviderProfile(id);
        if (existing === undefined) return { ok: false, error: 'Unknown provider profile id' };
        secretHandleId = existing.secretHandleId;
        createdAt = existing.createdAt;
      } else {
        id = newId();
        secretHandleId = newId();
        createdAt = timestamp;
      }

      // The key is written to OS-protected storage before the (secret-free) profile metadata
      // is saved, so a crash between the two calls never leaves a profile pointing at a
      // handle that was never actually written.
      await deps.secretStore.set(secretHandleId, request.apiKey);
      const profile: ProviderProfile = {
        id,
        ...(request.name !== undefined ? { name: request.name } : {}),
        provider: request.provider,
        baseUrl: request.baseUrl,
        modelId: request.modelId,
        ...(request.cachedModels !== undefined ? { cachedModels: request.cachedModels } : {}),
        secretHandleId,
        createdAt,
        updatedAt: timestamp,
      };
      deps.localDatabase.saveProviderProfile(profile);
      return { ok: true, data: profile };
    },
    'desktop.provider-profile.list': (): IpcResult => ({
      ok: true,
      data: deps.localDatabase.listProviderProfiles(),
    }),
    'desktop.provider-profile.delete': async (payload): Promise<IpcResult> => {
      const id = asProfileId(payload);
      if (id === undefined) return { ok: false, error: 'Invalid profile id' };
      const existing = deps.localDatabase.getProviderProfile(id);
      if (existing === undefined) return { ok: false, error: 'Unknown provider profile id' };
      await deps.secretStore.delete(existing.secretHandleId);
      deps.localDatabase.deleteProviderProfile(id);
      return { ok: true };
    },
    'desktop.provider-profile.begin-session': async (payload): Promise<IpcResult> => {
      const id = asProfileId(payload);
      if (id === undefined) return { ok: false, error: 'Invalid profile id' };
      const profile = deps.localDatabase.getProviderProfile(id);
      if (profile === undefined) return { ok: false, error: 'Unknown provider profile id' };
      const apiKey = await deps.secretStore.get(profile.secretHandleId);
      if (apiKey === null) return { ok: false, error: 'Provider key is no longer available' };
      // Volatile, one-time handoff: the caller must discard this plaintext key when the
      // session ends and never persist or log it — mirrors
      // apps/editor-web/src/joy-agent/byok-session.ts's forgetByokConfig semantics for the
      // existing manual-entry BYOK flow this is designed to slot into.
      return {
        ok: true,
        data: {
          provider: profile.provider,
          baseUrl: profile.baseUrl,
          modelId: profile.modelId,
          apiKey,
        },
      };
    },
    'desktop.provider-profile.test': async (payload): Promise<IpcResult> => {
      const id = asProfileId(payload);
      if (id === undefined) return { ok: false, error: 'Invalid profile id' };
      const profile = deps.localDatabase.getProviderProfile(id);
      if (profile === undefined) return { ok: false, error: 'Unknown provider profile id' };
      const apiKey = await deps.secretStore.get(profile.secretHandleId);
      if (apiKey === null) return { ok: false, error: 'Provider key is no longer available' };
      // The key is used for exactly this one probe call and never returned to the caller —
      // `report` is the redacted shape documented in provider-sdk's openai-compatible adapter.
      const report = await deps.probeProvider({
        baseUrl: profile.baseUrl,
        apiKey,
        modelId: profile.modelId,
      });
      return { ok: true, data: report };
    },
    'desktop.provider-profile.fetch-models': async (payload): Promise<IpcResult> => {
      try {
        const p = (payload && typeof payload === 'object' ? payload : {}) as {
          id?: string;
          baseUrl?: string;
          apiKey?: string;
        };
        let baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '';
        let apiKey = typeof p.apiKey === 'string' ? p.apiKey.trim() : '';
        if (p.id) {
          const profile = deps.localDatabase.getProviderProfile(p.id);
          if (!profile) return { ok: false, error: 'Unknown provider profile' };
          baseUrl = profile.baseUrl;
          const storedKey = await deps.secretStore.get(profile.secretHandleId);
          if (storedKey) {
            apiKey = storedKey;
          }
        }
        if (!baseUrl) return { ok: false, error: 'Base URL required' };
        const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
        const endpoint = `${normalizedBaseUrl}/models`;
        const headers: Record<string, string> = {};
        if (apiKey && apiKey !== 'not-provided') {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(endpoint, {
          headers,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          return {
            ok: false,
            error: `Provider returned status ${res.status}: ${errText.slice(0, 100)}`,
          };
        }
        const json = (await res.json()) as { data?: unknown };
        const rawList = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
        const models = rawList
          .map((item) => {
            if (typeof item === 'string') return { id: item, name: item };
            if (item && typeof item === 'object') {
              const id = (item as { id?: string }).id || '';
              const name = (item as { name?: string }).name || id;
              return { id, name };
            }
            return null;
          })
          .filter((m): m is { id: string; name: string } => Boolean(m && m.id));
        return { ok: true, data: models };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    'desktop.check-for-update': (payload): IpcResult => {
      const request = asCheckForUpdateRequest(payload);
      if (request === undefined) return { ok: false, error: 'Invalid update check request' };
      return { ok: true, data: deps.checkForUpdate(request) };
    },
    'desktop.window-minimize': async () => {
      await deps.handleWindowControl?.('minimize');
      return { ok: true, data: undefined };
    },
    'desktop.window-maximize': async () => {
      const isMax = await deps.handleWindowControl?.('maximize');
      return { ok: true, data: isMax };
    },
    'desktop.window-close': async () => {
      await deps.handleWindowControl?.('close');
      return { ok: true, data: undefined };
    },
    'desktop.window-toggle-fullscreen': async () => {
      const isFull = await deps.handleWindowControl?.('toggle-fullscreen');
      return { ok: true, data: Boolean(isFull) };
    },
    'desktop.window-is-maximized': async () => {
      const isMax = await deps.handleWindowControl?.('is-maximized');
      return { ok: true, data: Boolean(isMax) };
    },
    'desktop.asset-library.get-settings': async () => {
      const info = deps.localDatabase.getAssetLibraryInfo();
      return { ok: true, data: info };
    },
    'desktop.asset-library.set-directory': async (payload) => {
      if (typeof payload !== 'object' || payload === null) {
        return { ok: false, error: 'Payload must be an object' };
      }
      const dir = (payload as { directory?: unknown }).directory;
      if (typeof dir !== 'string' || dir.trim().length === 0) {
        return { ok: false, error: 'Directory path must be a non-empty string' };
      }
      deps.localDatabase.setAssetLibraryDirectory(dir.trim());
      const info = deps.localDatabase.getAssetLibraryInfo();
      return { ok: true, data: info };
    },
    'desktop.asset-library.select-directory': async () => {
      if (!deps.showOpenDirectoryDialog) {
        return { ok: false, error: 'Directory selection is unavailable in this environment' };
      }
      const result = await deps.showOpenDirectoryDialog();
      if (result.canceled || !result.path) {
        return { ok: true, data: null };
      }
      deps.localDatabase.setAssetLibraryDirectory(result.path);
      const info = deps.localDatabase.getAssetLibraryInfo();
      return { ok: true, data: info };
    },
    'desktop.asset-library.reset-directory': async () => {
      deps.localDatabase.resetAssetLibraryDirectory();
      const info = deps.localDatabase.getAssetLibraryInfo();
      return { ok: true, data: info };
    },
    'desktop.asset-library.get-catalog': async () => {
      const dir = deps.localDatabase.getAssetLibraryDirectory();
      const catalogPath = path.join(dir, 'catalog.json');
      if (!fs.existsSync(catalogPath)) {
        return {
          ok: true,
          data: { version: 1, counts: { total: 0, audio: 0, image: 0 }, assets: [] },
        };
      }
      try {
        const raw = fs.readFileSync(catalogPath, 'utf8');
        const catalog = JSON.parse(raw);
        return { ok: true, data: catalog };
      } catch (err: unknown) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Failed to read asset catalog',
        };
      }
    },
    'desktop.project-storage.get': (payload): IpcResult => {
      const key = asEditorStorageKey(payload);
      if (key === undefined) return { ok: false, error: 'Invalid editor project storage key' };
      return { ok: true, data: deps.localDatabase.getEditorStorageItem(key) };
    },
    'desktop.project-storage.set': (payload): IpcResult => {
      const request = asEditorStorageWrite(payload);
      if (request === undefined)
        return { ok: false, error: 'Invalid editor project storage value' };
      deps.localDatabase.setEditorStorageItem(request.key, request.value);
      return { ok: true };
    },
    'desktop.project-storage.remove': (payload): IpcResult => {
      const key = asEditorStorageKey(payload);
      if (key === undefined) return { ok: false, error: 'Invalid editor project storage key' };
      deps.localDatabase.deleteEditorStorageItem(key);
      return { ok: true };
    },
    'desktop.project-storage.keys': (): IpcResult => ({
      ok: true,
      data: deps.localDatabase.listEditorStorageKeys().filter(isEditorProjectStorageKey),
    }),
  };
}

/**
 * Dispatches a raw IPC request through the origin/channel policy in `../ipc.ts` before
 * running the matching handler. This is the only place a request payload should touch
 * a handler function.
 */
/** isAllowedIpcRequest throws on a disallowed origin (see ../ipc.ts) and returns false for a
 * disallowed channel; both must fail closed here without ever reaching a handler. */
function safeIsAllowedIpcRequest(
  request: IpcRequest,
): request is IpcRequest & { channel: IpcChannel } {
  try {
    return isAllowedIpcRequest(request);
  } catch {
    return false;
  }
}

export async function dispatchIpcRequest(
  handlers: Record<IpcChannel, IpcHandler>,
  request: IpcRequest,
): Promise<IpcResult> {
  if (!safeIsAllowedIpcRequest(request)) {
    return { ok: false, error: `Blocked IPC request: ${request.channel}` };
  }
  return handlers[request.channel](request.payload);
}

/** Dispatches only synchronous project-storage handlers for Electron's sendSync bridge. */
export function dispatchSynchronousIpcRequest(
  handlers: Record<IpcChannel, IpcHandler>,
  request: IpcRequest,
): IpcResult {
  if (typeof request !== 'object' || request === null || !safeIsAllowedIpcRequest(request)) {
    const channel =
      typeof request === 'object' && request !== null && typeof request.channel === 'string'
        ? request.channel
        : 'unknown';
    return { ok: false, error: `Blocked IPC request: ${channel}` };
  }
  if (!(SYNCHRONOUS_IPC_CHANNELS as readonly string[]).includes(request.channel)) {
    return { ok: false, error: `Blocked synchronous IPC request: ${request.channel}` };
  }
  try {
    const result = handlers[request.channel](request.payload);
    if (isPromiseLike(result))
      return { ok: false, error: 'Synchronous IPC handler returned a promise' };
    return result;
  } catch {
    return { ok: false, error: 'Synchronous IPC request failed' };
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<IpcResult> {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  return typeof (value as { then?: unknown }).then === 'function';
}

function asEditorStorageKey(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const key = (payload as { key?: unknown }).key;
  return typeof key === 'string' &&
    key.length <= MAX_EDITOR_PROJECT_STORAGE_KEY_LENGTH &&
    isEditorProjectStorageKey(key)
    ? key
    : undefined;
}

function asEditorStorageWrite(
  payload: unknown,
): { readonly key: string; readonly value: string } | undefined {
  const key = asEditorStorageKey(payload);
  if (key === undefined || typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as { value?: unknown }).value;
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_EDITOR_PROJECT_STORAGE_VALUE_BYTES
  ) {
    return undefined;
  }
  return { key, value };
}

function asOpaqueFileRef(value: unknown): OpaqueFileRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<OpaqueFileRef>;
  if (
    candidate.kind === 'local-file' &&
    typeof candidate.id === 'string' &&
    typeof candidate.displayName === 'string'
  ) {
    return { kind: 'local-file', id: candidate.id, displayName: candidate.displayName };
  }
  return undefined;
}

function asDerivativeRequest(
  value: unknown,
): { readonly ref: OpaqueFileRef; readonly kind: DerivativeKind } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { ref?: unknown; kind?: unknown };
  const ref = asOpaqueFileRef(candidate.ref);
  if (ref === undefined) return undefined;
  if (candidate.kind !== 'thumbnail' && candidate.kind !== 'proxy') return undefined;
  return { ref, kind: candidate.kind };
}

function asJobId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as { jobId?: unknown }).jobId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

const STAGE_UNAVAILABLE: IpcResult = { ok: false, error: 'Media staging is unavailable' };

/** Runs a staging or read operation and turns a thrown error into a refusal the renderer can show. */
async function guarded(run: () => Promise<unknown>): Promise<IpcResult> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

function asUploadId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as { uploadId?: unknown }).uploadId;
  return typeof candidate === 'string' && /^[0-9a-f-]{36}$/.test(candidate) ? candidate : undefined;
}

function asStageBeginRequest(value: unknown): StageBeginRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<Record<keyof StageBeginRequest, unknown>>;
  if (typeof candidate.sha256 !== 'string' || typeof candidate.displayName !== 'string')
    return undefined;
  if (typeof candidate.bytes !== 'number') return undefined;
  return { sha256: candidate.sha256, bytes: candidate.bytes, displayName: candidate.displayName };
}

function asStageChunkRequest(
  value: unknown,
): { readonly uploadId: string; readonly offset: number; readonly data: Uint8Array } | undefined {
  const uploadId = asUploadId(value);
  if (uploadId === undefined) return undefined;
  const candidate = value as { offset?: unknown; data?: unknown };
  if (typeof candidate.offset !== 'number' || !(candidate.data instanceof Uint8Array))
    return undefined;
  return { uploadId, offset: candidate.offset, data: candidate.data };
}

function asAudioPresenceRequest(
  value: unknown,
): { readonly sha256: string; readonly bytes: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { sha256?: unknown; bytes?: unknown };
  if (typeof candidate.sha256 !== 'string' || typeof candidate.bytes !== 'number') return undefined;
  return { sha256: candidate.sha256, bytes: candidate.bytes };
}

function asProfileId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as { id?: unknown }).id;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

interface SaveProviderProfileRequest {
  readonly id?: string;
  readonly name?: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly cachedModels?: readonly string[];
  readonly apiKey: string;
}

function asSaveProviderProfileRequest(value: unknown): SaveProviderProfileRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['provider'] !== 'string') return undefined;
  if (typeof candidate['baseUrl'] !== 'string') return undefined;
  if (typeof candidate['modelId'] !== 'string') return undefined;
  if (typeof candidate['apiKey'] !== 'string' || candidate['apiKey'].length === 0) return undefined;
  if (candidate['id'] !== undefined && typeof candidate['id'] !== 'string') return undefined;
  return {
    ...(candidate['id'] !== undefined ? { id: candidate['id'] as string } : {}),
    ...(typeof candidate['name'] === 'string' ? { name: candidate['name'] } : {}),
    provider: candidate['provider'],
    baseUrl: candidate['baseUrl'],
    modelId: candidate['modelId'],
    ...(Array.isArray(candidate['cachedModels'])
      ? {
          cachedModels: candidate['cachedModels'].filter((m): m is string => typeof m === 'string'),
        }
      : {}),
    apiKey: candidate['apiKey'],
  };
}

function asCheckForUpdateRequest(
  value: unknown,
): { manifest: SignedReleaseManifest; subscriptionActive: boolean } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const manifest = candidate['manifest'];
  if (typeof candidate['subscriptionActive'] !== 'boolean') return undefined;
  if (typeof manifest !== 'object' || manifest === null) return undefined;
  const manifestCandidate = manifest as Record<string, unknown>;
  const payload = manifestCandidate['payload'];
  if (typeof manifestCandidate['signature'] !== 'string') return undefined;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const payloadCandidate = payload as Record<string, unknown>;
  if (payloadCandidate['channel'] !== 'stable' && payloadCandidate['channel'] !== 'beta') {
    return undefined;
  }
  if (typeof payloadCandidate['version'] !== 'string') return undefined;
  if (typeof payloadCandidate['downloadUrl'] !== 'string') return undefined;
  if (typeof payloadCandidate['sha256'] !== 'string') return undefined;
  if (
    payloadCandidate['minSupportedVersion'] !== undefined &&
    typeof payloadCandidate['minSupportedVersion'] !== 'string'
  ) {
    return undefined;
  }
  return {
    manifest: manifest as SignedReleaseManifest,
    subscriptionActive: candidate['subscriptionActive'],
  };
}

export type { WorkerStatus };
