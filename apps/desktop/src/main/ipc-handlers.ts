import fs from 'node:fs';
import path from 'node:path';
import { isAllowedIpcRequest } from '../ipc.js';
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
import { validateProviderProfileInput } from '@joy-media/provider-sdk';
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
    action: 'minimize' | 'maximize' | 'close' | 'is-maximized',
  ) => Promise<boolean | void> | boolean | void;
  readonly now?: () => string;
  readonly newId?: () => string;
}

export interface IpcResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export type IpcHandler = (payload: unknown) => Promise<IpcResult> | IpcResult;

/** Builds the channel -> handler dispatch table. Never exposed directly to the renderer. */
export function createIpcHandlers(deps: IpcHandlerDeps): Record<IpcChannel, IpcHandler> {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => crypto.randomUUID());

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
        const job = deps.localDatabase.enqueueJob(`derivative:${request.kind}`, request.ref.id);
        return { ok: true, data: { ...approval, jobId: job.id } };
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
      const job = deps.localDatabase.getJob(jobId);
      if (job === undefined) return { ok: false, error: 'Unknown job id' };
      return { ok: true, data: job };
    },
    'desktop.cancel-job': (payload): IpcResult => {
      const jobId = asJobId(payload);
      if (jobId === undefined) return { ok: false, error: 'Invalid job id' };
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
          cachedModels: candidate['cachedModels'].filter(
            (m): m is string => typeof m === 'string',
          ),
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
