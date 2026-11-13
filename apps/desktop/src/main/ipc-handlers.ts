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
  AssetLibrarySettings,
  JobRecord,
  LocalDatabase,
  MediaKind,
  ProviderProfile,
} from '../store/local-database.js';
import type { AssetLibraryDriveType } from '../store/asset-library-drive.js';
import { EMPTY_ASSET_LIBRARY_COUNTS } from '../store/asset-library-counts.js';
import { LEGACY_PROVIDER_IDS } from '../store/migrations.js';
import {
  clearAgentSlotsForProfile,
  readAgentSlot,
  readAgentSlots,
  writeAgentSlot,
} from '../store/agent-slots.js';
import { resolveSlotRequest } from './agent-slot-request.js';
import { AgentRequestRegistry } from './agent-requests.js';
import { OAuthFlowError } from './oauth/errors.js';
import { decodeTokenRecord, type ChatGptTokenRecord } from './oauth/chatgpt.js';
import type { ProviderSignInContext, SignInProvider, SignInResult } from './oauth/sign-in.js';
import { MEDIA_CHANNELS, type MediaChannel, type MediaResult } from './media-channel.js';
import {
  isAgentSlotConfigured,
  isSignInProvider,
  parseAgentSlotId,
  validateProviderProfileInput,
  type AgentSlot,
  type AgentSlotId,
  type AgentSlotResult,
} from '@joy-media/provider-sdk';
import { evaluateEndpoint, normalizeBaseUrl } from '@joy-media/provider-sdk';
import type { SecretStore } from '@joy-media/provider-sdk';
import {
  endpointBindingDigest,
  publicEndpointConfirmed,
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
  /** The provider calls in progress. The entry point shares it with the window, which ends them on reload. */
  readonly agentRequests?: AgentRequestRegistry;
  /** The `desktop.media.*` handlers (media-channel.ts). Absent means every media call is refused. */
  readonly mediaChannel?: Readonly<
    Record<MediaChannel, (payload: unknown) => MediaResult | Promise<MediaResult>>
  >;
  readonly showOpenDialog: ShowOpenDialog;
  readonly showOpenDirectoryDialog?: ShowOpenDialog;
  /** Opens a folder in the OS file browser. Absent means the action is unavailable.
   * Resolves with the reason it failed, or with nothing when the folder opened. */
  readonly openDirectory?: (directory: string) => Promise<string | void>;
  /** Works out what kind of drive a folder sits on (fixed, removable, network).
   * Absent means "unknown", and the owner is not warned about a drive we know nothing about. */
  readonly classifyDrive?: (
    directory: string,
  ) => Promise<AssetLibraryDriveType> | AssetLibraryDriveType;
  readonly localDatabase: LocalDatabase;
  readonly probeMedia: ProbeMedia;
  readonly secretStore: SecretStore;
  /** Every provider call goes through the broker (providers/provider-broker.ts). */
  readonly providerBroker: ProviderBroker;
  /** Runs a sign-in (oauth/sign-in.ts). Absent means sign-in is refused. The result is saved as a profile. */
  readonly providerSignIn?: (
    provider: SignInProvider,
    context?: ProviderSignInContext,
  ) => Promise<SignInResult>;
  /** Revokes a ChatGPT refresh token. Credentials stay in the main process. */
  readonly providerSignOut?: (record: ChatGptTokenRecord) => Promise<void>;
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
  const agentRequests = deps.agentRequests ?? new AgentRequestRegistry();

  /** The kind of drive a folder is on, asked for gently: a failure means "unknown",
   * never a broken settings dialog. */
  const driveTypeOf = async (directory: string): Promise<AssetLibraryDriveType> => {
    if (deps.classifyDrive === undefined) return 'unknown';
    try {
      return (await deps.classifyDrive(directory)) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };

  /** The library's settings plus the kind of drive it sits on. */
  const librarySettings = async (): Promise<AssetLibrarySettings> => {
    const info = deps.localDatabase.getAssetLibraryInfo();
    return { ...info, driveType: await driveTypeOf(info.directory) };
  };

  const handlers: Record<IpcChannel, IpcHandler> = {
    ...mediaChannelTable(deps.mediaChannel),
    'desktop.provider-profile.sign-in': async (payload): Promise<IpcResult> => {
      const request = asSignInRequest(payload);
      if (request === undefined) return { ok: false, error: 'Invalid sign-in request' };
      if (deps.providerSignIn === undefined) {
        return { ok: false, error: 'Sign-in is not available in this build' };
      }
      let savedChatGptRecord: ChatGptTokenRecord | undefined;
      // The model list the profile already holds, so signing in again does not drop it.
      let existingCachedModels: readonly string[] | undefined;
      // A sign-in can only update a profile of the same provider, so it never changes what a profile is.
      if (request.id !== undefined) {
        const existing = deps.localDatabase.getProviderProfile(request.id);
        if (existing === undefined || existing.provider !== request.provider) {
          return { ok: false, error: 'That profile cannot be signed in again' };
        }
        existingCachedModels = existing.cachedModels;
        if (request.provider === 'chatgpt') {
          try {
            const stored = await deps.secretStore.get(existing.secretHandleId);
            savedChatGptRecord = stored === null ? undefined : decodeTokenRecord(stored);
          } catch {
            return { ok: false, error: 'The saved ChatGPT connection could not be read.' };
          }
          if (savedChatGptRecord === undefined) {
            return {
              ok: false,
              error:
                'The saved ChatGPT connection cannot be reauthorized; remove it locally and sign in again.',
            };
          }
        }
      }
      try {
        const context: ProviderSignInContext | undefined =
          savedChatGptRecord === undefined
            ? undefined
            : {
                savedChatGptAccount: {
                  clientId: savedChatGptRecord.clientId,
                  accountId: savedChatGptRecord.accountId,
                },
              };
        const signedIn =
          context === undefined
            ? await deps.providerSignIn(request.provider)
            : await deps.providerSignIn(request.provider, context);
        // The result must name the provider that was asked for, and that provider must permit a sign-in. A runner that
        // answered with another provider would otherwise save a profile for a provider that is set up with an API key.
        if (signedIn.provider !== request.provider || !isSignInProvider(signedIn.provider)) {
          return {
            ok: false,
            error: 'The sign-in did not return a provider that can be signed in to',
          };
        }
        if (savedChatGptRecord !== undefined) {
          const replacement = decodeTokenRecord(signedIn.secret);
          if (replacement === undefined) {
            return {
              ok: false,
              error:
                'ChatGPT did not return a valid replacement authorization. The saved connection was kept.',
            };
          }
          if (
            replacement.accountId !== savedChatGptRecord.accountId ||
            replacement.clientId !== savedChatGptRecord.clientId
          ) {
            const accountMismatch = replacement.accountId !== savedChatGptRecord.accountId;
            try {
              if (deps.providerSignOut === undefined) throw new Error('revocation unavailable');
              await deps.providerSignOut(replacement);
            } catch {
              return {
                ok: false,
                error:
                  'ChatGPT returned an authorization that did not match the saved account. The saved connection was kept, but JOY Media could not revoke the new grant; remove it in ChatGPT settings.',
              };
            }
            throw new OAuthFlowError(
              accountMismatch ? 'ACCOUNT_MISMATCH' : 'CLIENT_MISMATCH',
              accountMismatch
                ? 'ChatGPT returned a different account. The new grant was revoked and the saved connection was kept.'
                : 'ChatGPT returned a different client. The new grant was revoked and the saved connection was kept.',
            );
          }
        }
        // The result is saved through the profile route, so it is checked and bound like any other save.
        const cachedModels = signedIn.cachedModels ?? existingCachedModels;
        const saved = await handlers['desktop.provider-profile.save']({
          ...(request.id === undefined ? {} : { id: request.id }),
          ...(cachedModels === undefined ? {} : { cachedModels }),
          provider: signedIn.provider,
          baseUrl: signedIn.baseUrl,
          modelId: signedIn.modelId,
          apiKey: signedIn.secret,
        });
        // A first sign-in fills an empty Workhorse, so the new subscription is in use without a pick. A slot that already
        // names a profile is left as it is.
        if (saved.ok && request.id === undefined) {
          const profileId = (saved.data as { readonly id?: unknown } | undefined)?.id;
          if (
            typeof profileId === 'string' &&
            readAgentSlot(deps.localDatabase, 'workhorse').profileId === undefined
          ) {
            writeAgentSlot(deps.localDatabase, 'workhorse', { profileId, model: signedIn.modelId });
          }
        }
        return saved;
      } catch (error) {
        return {
          ok: false,
          error: error instanceof OAuthFlowError ? error.message : 'The sign-in did not complete.',
        };
      }
    },
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
    // The owner's manual retry after the bounded automatic attempts are used up. It starts a new budget.
    'desktop.worker-retry': (): IpcResult => {
      deps.workerSupervisor.start();
      return { ok: true, data: deps.workerSupervisor.status() };
    },
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
      // v1.1.1 no longer offers these providers, so nothing new can be saved under them.
      if (LEGACY_PROVIDER_IDS.includes(request.provider)) {
        return { ok: false, error: 'This provider is no longer offered in v1.1.1' };
      }

      const timestamp = now();
      let id = request.id;
      let secretHandleId: string;
      let createdAt: string;
      let existing: ProviderProfile | undefined;
      if (id !== undefined) {
        existing = deps.localDatabase.getProviderProfile(id);
        if (existing === undefined) return { ok: false, error: 'Unknown provider profile id' };
        // The stored key may stay only while it still belongs to this exact endpoint (PLAN-v4 §6c).
        if (
          request.apiKey === undefined &&
          (existing.provider !== request.provider ||
            normalizeBaseUrl(existing.baseUrl) !== normalizeBaseUrl(request.baseUrl))
        ) {
          return { ok: false, error: 'Enter the key again to change the endpoint' };
        }
        // A new key gets a new handle. Until the profile points at it, the saved profile keeps its
        // old handle, so a key is never paired with the wrong endpoint (PLAN-v4 §6c).
        secretHandleId = request.apiKey === undefined ? existing.secretHandleId : newId();
        createdAt = existing.createdAt;
      } else {
        id = newId();
        secretHandleId = newId();
        createdAt = timestamp;
      }
      // Whether this save writes a handle the profile does not hold yet.
      const freshHandle = secretHandleId !== existing?.secretHandleId;

      // Validation already refused any URL the policy would not allow, so the verdict is allowed here.
      const verdict = evaluateEndpoint(request.provider, request.baseUrl, {
        consentToPublicEndpoint: request.acknowledgedPublicEndpoint === true,
      });
      if (!verdict.allowed) return { ok: false, error: verdict.reason };

      // The key is written to OS-protected storage before the (secret-free) profile metadata is
      // saved, so a crash between the two calls never leaves a profile pointing at a handle that was
      // never actually written.
      if (request.apiKey !== undefined) {
        await deps.secretStore.set(secretHandleId, request.apiKey);
      } else if (existing === undefined) {
        // A keyless local model stores the placeholder, so its profile still reads as present.
        if (verdict.kind !== 'loopback') {
          return { ok: false, error: 'An API key is required for this endpoint' };
        }
        await deps.secretStore.set(secretHandleId, 'not-provided');
      }

      // A saved key keeps the binding it has. A key written now, or a new profile, is bound to this
      // endpoint and to the version of the key just written (PLAN-v4 §6c). A keyless save therefore
      // never binds a key that was never confirmed for this endpoint.
      const rebinds = request.apiKey !== undefined || existing === undefined;
      const profile: ProviderProfile = {
        id,
        ...(request.name !== undefined ? { name: request.name } : {}),
        provider: request.provider,
        baseUrl: request.baseUrl,
        modelId: request.modelId,
        ...(request.cachedModels !== undefined ? { cachedModels: request.cachedModels } : {}),
        secretHandleId,
        bindingDigest: rebinds
          ? endpointBindingDigest(id, verdict.origin, verdict.basePath)
          : existing?.bindingDigest,
        bindingSecretDigest: rebinds
          ? deps.localDatabase.secretVersion(secretHandleId)
          : existing?.bindingSecretDigest,
        createdAt,
        updatedAt: timestamp,
      };
      try {
        deps.localDatabase.saveProviderProfile(profile);
      } catch (error) {
        // The profile still points at its old key, so the key this save wrote is removed.
        if (freshHandle) await deps.secretStore.delete(secretHandleId).catch(() => undefined);
        throw error;
      }
      // The old key goes only now, after the profile points at the new one.
      if (existing !== undefined && freshHandle) {
        await deps.secretStore.delete(existing.secretHandleId).catch(() => undefined);
      }
      // A key saved again makes the profile usable again, without waiting for a restart.
      deps.localDatabase.clearProfileCredentialUnavailable(id);
      const versionOf = (handleId: string): string => deps.localDatabase.secretVersion(handleId);
      return { ok: true, data: listedProfile(profile, isBound(profile, versionOf)) };
    },
    'desktop.provider-profile.list': (): IpcResult => {
      // Metadata only: no key, and no field that could carry one.
      const states = new Map(deps.localDatabase.listProfileStates().map((s) => [s.profileId, s]));
      const versionOf = (handleId: string): string => deps.localDatabase.secretVersion(handleId);
      return {
        ok: true,
        data: deps.localDatabase.listProviderProfiles().map((profile) => {
          const state = states.get(profile.id);
          return {
            ...listedProfile(profile, isBound(profile, versionOf)),
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
      // A slot that named the profile is left without one, so it cannot run until the owner picks another.
      clearAgentSlotsForProfile(deps.localDatabase, id);
      return { ok: true };
    },
    'desktop.provider-profile.sign-out': async (payload): Promise<IpcResult> => {
      const id = asProfileId(payload);
      if (id === undefined) return { ok: false, error: 'Invalid profile id' };
      const existing = deps.localDatabase.getProviderProfile(id);
      if (existing === undefined) return { ok: false, error: 'Unknown provider profile id' };
      if (existing.provider !== 'chatgpt') {
        return { ok: false, error: 'Remote sign-out is only available for ChatGPT profiles.' };
      }
      if (deps.providerSignOut === undefined) {
        return { ok: false, error: 'ChatGPT sign-out is not available in this build.' };
      }
      let record: ChatGptTokenRecord | undefined;
      try {
        const stored = await deps.secretStore.get(existing.secretHandleId);
        record = stored === null ? undefined : decodeTokenRecord(stored);
      } catch {
        return { ok: false, error: 'The saved ChatGPT connection could not be read.' };
      }
      if (record === undefined) {
        return {
          ok: false,
          error: 'This profile has no valid ChatGPT authorization to revoke. It remains saved.',
        };
      }
      try {
        await deps.providerSignOut(record);
      } catch {
        return {
          ok: false,
          error: 'ChatGPT could not confirm sign-out. The saved connection was kept.',
        };
      }
      try {
        await deps.secretStore.delete(existing.secretHandleId);
      } catch {
        return {
          ok: false,
          error: 'ChatGPT access was revoked, but the local connection could not be removed.',
        };
      }
      deps.localDatabase.deleteProviderProfile(id);
      // A slot that named the profile is left without one, so it cannot run until the owner picks another.
      clearAgentSlotsForProfile(deps.localDatabase, id);
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
      // The saved profile as it was when its list was asked for, so the list is kept only for that same profile.
      const before =
        'profileId' in source ? deps.localDatabase.getProviderProfile(source.profileId) : undefined;
      const result = await deps.providerBroker.listModels(source);
      if (!result.ok) return { ok: false, error: result.message };
      if (before !== undefined) keepListedModels(deps.localDatabase, before, result.data);
      return { ok: true, data: result.data };
    },
    'desktop.agent.request': async (payload): Promise<IpcResult> => {
      const request = asAgentRequest(payload);
      if (request === undefined) return { ok: false, error: 'Invalid agent request' };
      // A slot request takes its profile, model and instructions from the stored slot (D17), not from the renderer.
      const target: TargetResult =
        request.kind === 'slot'
          ? slotTarget(deps.localDatabase, request.slot, request.body)
          : request.slot !== undefined
            ? slotBoundTarget(deps.localDatabase, request.slot, request)
            : {
                ok: true,
                value: {
                  profileId: request.profileId,
                  baseUrl: request.baseUrl,
                  body: request.body,
                  ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
                },
              };
      if (!target.ok) return { ok: false, error: target.error };
      const { requestId } = request;
      // Every call has an id the renderer can cancel. An id already in use is refused, not shared.
      const controller = agentRequests.begin(requestId);
      if (controller === undefined) {
        return { ok: false, error: 'That agent request id is already in use' };
      }
      try {
        // A refusal is data, not a handler error, so the renderer keeps the broker's code.
        const result = await deps.providerBroker.complete({
          ...target.value,
          signal: controller.signal,
        });
        return {
          ok: true,
          data: result.ok
            ? { ok: true, text: result.data.text }
            : { ok: false, code: result.code, message: result.message },
        };
      } finally {
        agentRequests.finish(requestId, controller);
      }
    },
    'desktop.agent-slots.list': (): IpcResult => ({
      ok: true,
      data: readAgentSlots(deps.localDatabase).map((slot) =>
        describeSlot(deps.localDatabase, slot),
      ),
    }),
    'desktop.agent-slots.save': (payload): IpcResult => {
      const save = asAgentSlotSave(payload);
      if (save === undefined) return { ok: false, error: 'Invalid agent slot' };
      const profileId = profileIdOf(save.draft);
      if (profileId !== undefined) {
        const profile = deps.localDatabase.getProviderProfile(profileId);
        if (profile === undefined) return { ok: false, error: 'Unknown provider profile id' };
        if (LEGACY_PROVIDER_IDS.includes(profile.provider)) {
          return { ok: false, error: 'A retired profile cannot be used by an agent slot' };
        }
      }
      const result = writeAgentSlot(deps.localDatabase, save.slot, save.draft);
      if (!result.ok) return { ok: false, error: slotIssueMessage(result) };
      return { ok: true, data: describeSlot(deps.localDatabase, result.slot) };
    },
    'desktop.agent.cancel': (payload): IpcResult => {
      const requestId = asAgentRequestId(
        typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>)['requestId']
          : undefined,
      );
      if (requestId === undefined) return { ok: false, error: 'Invalid agent request id' };
      agentRequests.cancel(requestId);
      return { ok: true, data: undefined };
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
      return { ok: true, data: await librarySettings() };
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
      return { ok: true, data: await librarySettings() };
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
      return { ok: true, data: await librarySettings() };
    },
    'desktop.asset-library.reset-directory': async () => {
      deps.localDatabase.resetAssetLibraryDirectory();
      return { ok: true, data: await librarySettings() };
    },
    'desktop.asset-library.open-directory': async () => {
      // The renderer never names a path here: only the folder the library is
      // already configured to use may ever be opened.
      if (!deps.openDirectory) {
        return { ok: false, error: 'Opening the folder is unavailable in this environment' };
      }
      const dir = deps.localDatabase.getAssetLibraryDirectory();
      if (!fs.existsSync(dir)) {
        return { ok: false, error: 'The asset library folder does not exist on this system' };
      }
      if (!fs.statSync(dir).isDirectory()) {
        return { ok: false, error: 'The configured asset library path is not a directory' };
      }
      const problem = await deps.openDirectory(dir);
      if (typeof problem === 'string' && problem.length > 0) {
        return { ok: false, error: problem };
      }
      return { ok: true, data: { directory: dir } };
    },
    'desktop.asset-library.get-catalog': async () => {
      const dir = deps.localDatabase.getAssetLibraryDirectory();
      const catalogPath = path.join(dir, 'catalog.json');
      if (!fs.existsSync(catalogPath)) {
        return {
          ok: true,
          data: { version: 1, counts: EMPTY_ASSET_LIBRARY_COUNTS, assets: [] },
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
  return handlers;
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

/** The provider to sign in to, and the saved profile to update, when there is one. */
function asSignInRequest(
  value: unknown,
): { readonly provider: SignInProvider; readonly id?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const provider = candidate['provider'];
  // The registry decides which providers may be signed in to (PLAN-v4 §6d-1 rule 5, D20). A provider that is set up
  // with an API key, such as OpenRouter, is not one of them.
  if (typeof provider !== 'string' || !isSignInProvider(provider)) return undefined;
  const id = candidate['id'];
  if (id !== undefined && (typeof id !== 'string' || id.length === 0)) return undefined;
  const hasRegion = Object.prototype.hasOwnProperty.call(candidate, 'region');
  if (hasRegion) return undefined;
  return { provider, ...(typeof id === 'string' ? { id } : {}) };
}

function asProfileId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as { id?: unknown }).id;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

/**
 * Keeps a list read by Refresh models on its saved profile, so the list is offered again after a reload. The list is
 * kept only while the profile still has the provider, endpoint and key it had when the list was asked for.
 */
function keepListedModels(
  database: LocalDatabase,
  before: ProviderProfile,
  models: readonly { readonly id: string }[],
): void {
  const now = database.getProviderProfile(before.id);
  if (
    now === undefined ||
    now.provider !== before.provider ||
    now.baseUrl !== before.baseUrl ||
    now.secretHandleId !== before.secretHandleId
  ) {
    return;
  }
  database.setProviderProfileCachedModels(
    before.id,
    models.map((model) => model.id),
  );
}

/**
 * A profile the renderer may connect without its key being entered again: its key is confirmed for the
 * endpoint the record now holds, and that key is still the one confirmed (PLAN-v4 §6c).
 */
function isBound(profile: ProviderProfile, versionOf: (handleId: string) => string): boolean {
  if (profile.bindingDigest === undefined || profile.bindingSecretDigest === undefined)
    return false;
  const verdict = evaluateEndpoint(profile.provider, profile.baseUrl, {
    consentToPublicEndpoint: publicEndpointConfirmed(profile),
  });
  if (!verdict.allowed) return false;
  return (
    profile.bindingDigest === endpointBindingDigest(profile.id, verdict.origin, verdict.basePath) &&
    profile.bindingSecretDigest === versionOf(profile.secretHandleId)
  );
}

/** The profile as the renderer sees it: the binding digests stay in the main process. */
function listedProfile(
  profile: ProviderProfile,
  bound: boolean,
): Omit<ProviderProfile, 'bindingDigest' | 'bindingSecretDigest'> & { readonly bound: boolean } {
  const {
    bindingDigest: _bindingDigest,
    bindingSecretDigest: _bindingSecretDigest,
    ...visible
  } = profile;
  return { ...visible, bound };
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
      draft: {
        provider: fields['provider'],
        baseUrl: fields['baseUrl'],
        apiKey: fields['apiKey'],
        ...(fields['acknowledgedPublicEndpoint'] === true
          ? { acknowledgedPublicEndpoint: true }
          : {}),
      },
    };
  }
  const id = asProfileId(value);
  return id === undefined ? undefined : { profileId: id };
}

/** A provider call: either a saved profile named directly (the editor's session), or an agent slot (D17). */
type AgentRequestInput =
  | {
      readonly kind: 'profile';
      readonly requestId: string;
      readonly profileId: string;
      readonly baseUrl: string;
      readonly modelId?: string;
      /** The slot the renderer's session runs in, when there is one. The main process checks the request against it. */
      readonly slot?: AgentSlotId;
      readonly body: unknown;
    }
  | {
      readonly kind: 'slot';
      readonly requestId: string;
      readonly slot: AgentSlotId;
      readonly body: unknown;
    };

function asAgentRequest(value: unknown): AgentRequestInput | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const requestId = asAgentRequestId(candidate['requestId']);
  if (requestId === undefined) return undefined;
  // A request with no profile names only its slot. A request with a profile may also name its slot (checked below).
  if (candidate['slot'] !== undefined && candidate['profileId'] === undefined) {
    const slot = parseAgentSlotId(candidate['slot']);
    return slot === undefined
      ? undefined
      : { kind: 'slot', requestId, slot, body: candidate['body'] };
  }
  const profileId = candidate['profileId'];
  const baseUrl = candidate['baseUrl'];
  if (typeof profileId !== 'string' || profileId.length === 0) return undefined;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0 || baseUrl.length > 2048)
    return undefined;
  const modelId = candidate['modelId'];
  const slot = candidate['slot'];
  const parsedSlot = slot === undefined ? undefined : parseAgentSlotId(slot);
  if (slot !== undefined && parsedSlot === undefined) return undefined;
  return {
    kind: 'profile',
    profileId,
    baseUrl,
    body: candidate['body'],
    ...(typeof modelId === 'string' ? { modelId } : {}),
    ...(parsedSlot === undefined ? {} : { slot: parsedSlot }),
    requestId,
  };
}

interface BrokerTarget {
  readonly profileId: string;
  readonly baseUrl: string;
  readonly modelId?: string;
  readonly body: unknown;
}

type TargetResult =
  | { readonly ok: true; readonly value: BrokerTarget }
  | { readonly ok: false; readonly error: string };

/** The profile, model and body a slot request sends. The profile must be saved and must not be a retired one. */
function slotTarget(store: LocalDatabase, slot: AgentSlotId, body: unknown): TargetResult {
  const resolved = resolveSlotRequest(store, slot, body);
  if (!resolved.ok) return resolved;
  const profile = store.getProviderProfile(resolved.profileId);
  if (profile === undefined)
    return { ok: false, error: 'The profile of this agent slot was removed' };
  if (LEGACY_PROVIDER_IDS.includes(profile.provider)) {
    return { ok: false, error: 'The profile of this agent slot is retired' };
  }
  return {
    ok: true,
    value: {
      profileId: resolved.profileId,
      baseUrl: profile.baseUrl,
      modelId: resolved.modelId,
      body: resolved.body,
    },
  };
}

/** A profile request that names its slot: the request must use the slot's profile and model, and the slot's instructions apply. */
function slotBoundTarget(
  store: LocalDatabase,
  slot: AgentSlotId,
  request: {
    readonly profileId: string;
    readonly baseUrl: string;
    readonly modelId?: string;
    readonly body: unknown;
  },
): TargetResult {
  const resolved = resolveSlotRequest(store, slot, request.body);
  if (!resolved.ok) return resolved;
  if (resolved.profileId !== request.profileId || resolved.modelId !== request.modelId) {
    return { ok: false, error: 'The request does not match its agent slot' };
  }
  return {
    ok: true,
    value: {
      profileId: request.profileId,
      baseUrl: request.baseUrl,
      modelId: resolved.modelId,
      body: resolved.body,
    },
  };
}

function describeSlot(store: LocalDatabase, slot: AgentSlot) {
  const profile =
    slot.profileId === undefined ? undefined : store.getProviderProfile(slot.profileId);
  return {
    id: slot.id,
    label: slot.label,
    profileId: slot.profileId ?? null,
    profileName: profile?.name ?? profile?.id ?? null,
    profileProvider: profile?.provider ?? null,
    model: slot.model ?? null,
    instructions: slot.instructions,
    settings: slot.settings,
    ready:
      isAgentSlotConfigured(slot) &&
      profile !== undefined &&
      !LEGACY_PROVIDER_IDS.includes(profile.provider),
  };
}

function asAgentSlotSave(value: unknown): { slot: AgentSlotId; draft: unknown } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const slot = parseAgentSlotId(candidate['id']);
  return slot === undefined ? undefined : { slot, draft: candidate['draft'] };
}

/** The profile a draft names, trimmed, or undefined when the draft names none. */
function profileIdOf(draft: unknown): string | undefined {
  if (typeof draft !== 'object' || draft === null) return undefined;
  const profileId = (draft as Record<string, unknown>)['profileId'];
  if (typeof profileId !== 'string' || profileId.trim().length === 0) return undefined;
  return profileId.trim();
}

function slotIssueMessage(result: Extract<AgentSlotResult, { ok: false }>): string {
  const where = result.field === undefined ? '' : ` (${result.field})`;
  return `The agent slot was not saved: ${result.issue}${where}.`;
}

/** A cancellable call's id: short, and only letters, digits, dashes and underscores. */
function asAgentRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
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
  /** The owner has confirmed this public custom endpoint (S8). */
  readonly acknowledgedPublicEndpoint?: boolean | undefined;
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
    ...(candidate['acknowledgedPublicEndpoint'] === true
      ? { acknowledgedPublicEndpoint: true }
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
