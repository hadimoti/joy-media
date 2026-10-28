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
import { LEGACY_PROVIDER_IDS } from '../store/migrations.js';
import { MEDIA_CHANNELS, type MediaChannel, type MediaResult } from './media-channel.js';
import { validateProviderProfileInput } from '@joy-media/provider-sdk';
import { evaluateEndpoint } from '@joy-media/provider-sdk';
import type { SecretStore } from '@joy-media/provider-sdk';
import {
  endpointBindingDigest,
  type ProviderBroker,
  type ProviderDraft,
} from './providers/provider-broker.js';

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

export interface IpcHandlerDeps {
  readonly fileRegistry: FileRegistry;
  readonly workerSupervisor: WorkerSupervisor;
  /** The `desktop.media.*` handlers (media-channel.ts). Absent means every media call is refused. */
  readonly mediaChannel?: Readonly<
    Record<MediaChannel, (payload: unknown) => MediaResult | Promise<MediaResult>>
  >;
  readonly showOpenDialog: ShowOpenDialog;
  readonly showOpenDirectoryDialog?: ShowOpenDialog;
  readonly localDatabase: LocalDatabase;
  readonly probeMedia: ProbeMedia;
  readonly secretStore: SecretStore;
  /** Every provider call goes through the broker (providers/provider-broker.ts). */
  readonly providerBroker: ProviderBroker;
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
    ...mediaChannelTable(deps.mediaChannel),
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
      // v1.1.0 no longer offers these providers, so nothing new can be saved under them.
      if (LEGACY_PROVIDER_IDS.includes(request.provider)) {
        return { ok: false, error: 'This provider is no longer offered in v1.1.0' };
      }

      const timestamp = now();
      let id = request.id;
      let secretHandleId: string;
      let createdAt: string;
      if (id !== undefined) {
        const existing = deps.localDatabase.getProviderProfile(id);
        if (existing === undefined) return { ok: false, error: 'Unknown provider profile id' };
        // The stored key may stay only while it still belongs to this exact endpoint (PLAN-v4 §6c).
        if (
          request.apiKey === undefined &&
          (existing.provider !== request.provider ||
            normalizeUrl(existing.baseUrl) !== normalizeUrl(request.baseUrl))
        ) {
          return { ok: false, error: 'Enter the key again to change the endpoint' };
        }
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
      // The endpoint is bound to the saved key (PLAN-v4 §6c). Validation already refused any URL the
      // policy would not allow, so the verdict is allowed here.
      const verdict = evaluateEndpoint(request.provider, request.baseUrl);
      if (!verdict.allowed) return { ok: false, error: verdict.reason };
      const bindingDigest = endpointBindingDigest(id, verdict.origin, verdict.basePath);

      if (request.apiKey !== undefined) {
        await deps.secretStore.set(secretHandleId, request.apiKey);
      }
      const profile: ProviderProfile = {
        id,
        ...(request.name !== undefined ? { name: request.name } : {}),
        provider: request.provider,
        baseUrl: request.baseUrl,
        modelId: request.modelId,
        ...(request.cachedModels !== undefined ? { cachedModels: request.cachedModels } : {}),
        secretHandleId,
        bindingDigest,
        createdAt,
        updatedAt: timestamp,
      };
      deps.localDatabase.saveProviderProfile(profile);
      // A key saved again makes the profile usable again, without waiting for a restart.
      deps.localDatabase.clearProfileCredentialUnavailable(id);
      return { ok: true, data: profile };
    },
    'desktop.provider-profile.list': (): IpcResult => {
      // Metadata only: no key, and no field that could carry one.
      const states = new Map(deps.localDatabase.listProfileStates().map((s) => [s.profileId, s]));
      return {
        ok: true,
        data: deps.localDatabase.listProviderProfiles().map((profile) => {
          const state = states.get(profile.id);
          return {
            ...listedProfile(profile),
            state: state?.state ?? 'active',
            ...(state?.decision === undefined ? {} : { decision: state.decision }),
          };
        }),
      };
    },
    'desktop.provider-profile.later': (payload): IpcResult => {
      const id = asProfileId(payload);
      if (id === undefined) return { ok: false, error: 'Invalid profile id' };
      const profile = deps.localDatabase.getProviderProfile(id);
      if (profile === undefined) return { ok: false, error: 'Unknown provider profile id' };
      // "Later" only applies to a legacy profile. Any other profile is left alone.
      if (!LEGACY_PROVIDER_IDS.includes(profile.provider)) {
        return { ok: false, error: 'Only a legacy profile can be deferred' };
      }
      deps.localDatabase.recordProfileLater(id);
      return { ok: true };
    },
    'desktop.provider-profile.delete': async (payload): Promise<IpcResult> => {
      const id = asProfileId(payload);
      if (id === undefined) return { ok: false, error: 'Invalid profile id' };
      const existing = deps.localDatabase.getProviderProfile(id);
      if (existing === undefined) return { ok: false, error: 'Unknown provider profile id' };
      await deps.secretStore.delete(existing.secretHandleId);
      deps.localDatabase.deleteProviderProfile(id);
      return { ok: true };
    },
    'desktop.provider.test': async (payload): Promise<IpcResult> => {
      const id = asProfileId(payload);
      if (id === undefined) return { ok: false, error: 'Invalid profile id' };
      // The broker reads the key for this one probe, and the report it returns is redacted.
      return { ok: true, data: await deps.providerBroker.probe(id) };
    },
    'desktop.provider.models': async (payload): Promise<IpcResult> => {
      const source = asModelSource(payload);
      if (source === undefined) return { ok: false, error: 'Invalid model source' };
      const result = await deps.providerBroker.listModels(source);
      return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.message };
    },
    'desktop.agent.request': async (payload): Promise<IpcResult> => {
      const request = asAgentRequest(payload);
      if (request === undefined) return { ok: false, error: 'Invalid agent request' };
      // A refusal is data, not a handler error, so the renderer keeps the broker's code.
      const result = await deps.providerBroker.complete(request);
      return {
        ok: true,
        data: result.ok
          ? { ok: true, text: result.data.text }
          : { ok: false, code: result.code, message: result.message },
      };
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
  try {
    return await handlers[request.channel](request.payload);
  } catch (error) {
    // A thrown message can carry a file path, so the renderer gets a fixed message. The detail
    // stays in the main process log.
    console.error(`[joy-desktop] IPC ${request.channel} failed`, error);
    return { ok: false, error: 'The request failed' };
  }
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

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** The profile as the renderer sees it: the binding digest stays in the main process. */
function listedProfile(profile: ProviderProfile): Omit<ProviderProfile, 'bindingDigest'> {
  const { bindingDigest: _bindingDigest, ...visible } = profile;
  return visible;
}

/** A saved profile by id, or an unsaved draft. A draft's key is used for this one call only. */
function asModelSource(
  value: unknown,
): { profileId: string } | { draft: ProviderDraft } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate['draft'] !== undefined) {
    const draft = candidate['draft'];
    if (typeof draft !== 'object' || draft === null) return undefined;
    const fields = draft as Record<string, unknown>;
    if (
      typeof fields['provider'] !== 'string' ||
      typeof fields['baseUrl'] !== 'string' ||
      typeof fields['apiKey'] !== 'string'
    ) {
      return undefined;
    }
    return {
      draft: { provider: fields['provider'], baseUrl: fields['baseUrl'], apiKey: fields['apiKey'] },
    };
  }
  const id = asProfileId(value);
  return id === undefined ? undefined : { profileId: id };
}

function asAgentRequest(
  value: unknown,
): { profileId: string; body: unknown; baseUrl: string; modelId?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const profileId = candidate['profileId'];
  const baseUrl = candidate['baseUrl'];
  if (typeof profileId !== 'string' || profileId.length === 0) return undefined;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0 || baseUrl.length > 2048)
    return undefined;
  const modelId = candidate['modelId'];
  return {
    profileId,
    baseUrl,
    body: candidate['body'],
    ...(typeof modelId === 'string' ? { modelId } : {}),
  };
}

interface SaveProviderProfileRequest {
  readonly id?: string;
  readonly name?: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly cachedModels?: readonly string[];
  /** Omitted to keep the stored key. Allowed only while the endpoint is unchanged. */
  readonly apiKey?: string | undefined;
}

function asSaveProviderProfileRequest(value: unknown): SaveProviderProfileRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['provider'] !== 'string') return undefined;
  if (typeof candidate['baseUrl'] !== 'string') return undefined;
  if (typeof candidate['modelId'] !== 'string') return undefined;
  const apiKey = candidate['apiKey'];
  const keyOmitted = apiKey === undefined || apiKey === '';
  if (!keyOmitted && typeof apiKey !== 'string') return undefined;
  if (keyOmitted && candidate['id'] === undefined) return undefined;
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
    ...(keyOmitted ? {} : { apiKey: apiKey as string }),
  };
}

/** Every `desktop.media.*` channel, refused when no media handlers were supplied. */
function mediaChannelTable(
  handlers: IpcHandlerDeps['mediaChannel'],
): Record<MediaChannel, IpcHandler> {
  const refused: IpcHandler = () => ({ ok: false, error: 'Media channel is not available' });
  return Object.fromEntries(
    MEDIA_CHANNELS.map((channel) => [channel, handlers?.[channel] ?? refused]),
  ) as Record<MediaChannel, IpcHandler>;
}

export type { WorkerStatus };
