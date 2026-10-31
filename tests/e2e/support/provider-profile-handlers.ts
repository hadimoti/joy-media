import type { Page } from '@playwright/test';
import type {
  DesktopProviderProfile,
  SaveDesktopProviderProfileRequest,
} from '../../../apps/editor-web/src/desktop-client.js';
import {
  installJoyDesktopBridge,
  UNHANDLED,
  type ChannelHandler,
  type InstalledJoyDesktopBridge,
} from './joy-desktop-bridge.js';

/**
 * A test-only stand-in for the parts of the JOY Media desktop host that the JOY Code connect path
 * needs in the browser harness.
 *
 * The browser has no desktop app, so `isDesktopHost()` is false. The editor then refuses to save a
 * provider profile (the connect path needs one), and the model call itself is brokered by the
 * desktop: the Worker never holds a key and never fetches, it posts a `provider-request` that the
 * main thread forwards to `desktop.agent.request` (see `engine-client.ts` and `engine.worker.ts`).
 *
 * This module answers the channels that path uses:
 *
 *  - `desktop.provider-profile.save` / `.list` / `.delete`: the saved profiles, one store per page.
 *    A profile is `bound` only after a key was saved for it, so the editor's read-back check (a bound
 *    profile at the endpoint that was saved) is honest.
 *  - `desktop.agent.request` / `.cancel`: the provider broker. The request is sent from the page
 *    itself, so the Playwright route installed by the fake provider fixture is the one that answers
 *    it, and the broker's answers carry the desktop's own failure codes.
 */

/** The placeholder the editor sends for a keyless local model. It is never a real key. */
const KEYLESS_KEY_PLACEHOLDER = 'not-provided';

/** The desktop broker's own bound on one provider call. */
const PROVIDER_CALL_TIMEOUT_MS = 120_000;

/** The desktop broker's own bound on the reply it reads. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface ProviderProfileStore {
  /** The saved profiles, metadata only. A key is never part of a profile. */
  list(): readonly DesktopProviderProfile[];
  save(request: SaveDesktopProviderProfileRequest): DesktopProviderProfile;
  remove(id: string): void;
  get(id: string): DesktopProviderProfile | undefined;
  /** The key saved for a profile, when one was saved for it. */
  secretFor(id: string): string | undefined;
}

export interface ProviderBrokerOptions {
  /** How long one provider call may take before the broker reports a timeout. */
  readonly timeoutMs?: number | undefined;
}

export type JoyProviderHostOptions = ProviderBrokerOptions;

interface StoredProfile {
  readonly profile: DesktopProviderProfile;
  /** The key for this profile. It stays in the test process until a provider call needs it. */
  readonly secret: string | undefined;
}

/** The base URL as the editor and the broker compare it. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asProfileId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const id = value['id'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function asRequestId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const requestId = value['requestId'];
  return typeof requestId === 'string' && requestId.length > 0 ? requestId : undefined;
}

function asSaveRequest(value: unknown): SaveDesktopProviderProfileRequest | undefined {
  if (!isRecord(value)) return undefined;
  const provider = value['provider'];
  const baseUrl = value['baseUrl'];
  const modelId = value['modelId'];
  if (typeof provider !== 'string' || typeof baseUrl !== 'string' || typeof modelId !== 'string')
    return undefined;
  const apiKey = value['apiKey'];
  if (apiKey !== undefined && typeof apiKey !== 'string') return undefined;
  const id = value['id'];
  if (id !== undefined && typeof id !== 'string') return undefined;
  const name = value['name'];
  if (name !== undefined && typeof name !== 'string') return undefined;
  const cachedModels = value['cachedModels'];
  return {
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    provider,
    baseUrl,
    modelId,
    ...(Array.isArray(cachedModels)
      ? { cachedModels: cachedModels.filter((model): model is string => typeof model === 'string') }
      : {}),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(value['acknowledgedPublicEndpoint'] === true ? { acknowledgedPublicEndpoint: true } : {}),
  };
}

interface AgentRequest {
  readonly requestId: string;
  readonly profileId: string;
  readonly baseUrl: string;
  readonly modelId?: string | undefined;
  readonly body: unknown;
}

function asAgentRequest(value: unknown): AgentRequest | undefined {
  if (!isRecord(value)) return undefined;
  const requestId = asRequestId(value);
  const profileId = value['profileId'];
  const baseUrl = value['baseUrl'];
  if (requestId === undefined) return undefined;
  if (typeof profileId !== 'string' || profileId.length === 0) return undefined;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return undefined;
  const modelId = value['modelId'];
  return {
    requestId,
    profileId,
    baseUrl,
    ...(typeof modelId === 'string' ? { modelId } : {}),
    body: value['body'],
  };
}

/** The saved profiles of one page. A profile is bound only once a key was saved for it. */
export function createProviderProfileStore(): ProviderProfileStore {
  const profiles = new Map<string, StoredProfile>();
  let sequence = 0;
  return {
    list: () => [...profiles.values()].map((entry) => entry.profile),
    save: (request) => {
      const timestamp = new Date().toISOString();
      const existing = request.id === undefined ? undefined : profiles.get(request.id);
      const id = existing?.profile.id ?? `e2e-provider-profile-${(sequence += 1)}`;
      const apiKey = request.apiKey;
      // A keyless save keeps the key the profile already had, and a profile without one stays
      // unbound: only a saved key makes a profile usable on its own.
      const savedKey =
        apiKey === undefined || apiKey === '' || apiKey === KEYLESS_KEY_PLACEHOLDER
          ? undefined
          : apiKey;
      const secret = savedKey ?? existing?.secret;
      const profile: DesktopProviderProfile = {
        id,
        ...(request.name === undefined ? {} : { name: request.name }),
        provider: request.provider,
        baseUrl: request.baseUrl,
        modelId: request.modelId,
        ...(request.cachedModels === undefined ? {} : { cachedModels: request.cachedModels }),
        createdAt: existing?.profile.createdAt ?? timestamp,
        updatedAt: timestamp,
        bound: secret !== undefined,
      };
      profiles.set(id, { profile, secret });
      return profile;
    },
    remove: (id) => {
      profiles.delete(id);
    },
    get: (id) => profiles.get(id)?.profile,
    secretFor: (id) => profiles.get(id)?.secret,
  };
}

/** Answers the `desktop.provider-profile.*` channels. */
export function createProviderProfileHandler(store: ProviderProfileStore): ChannelHandler {
  return (channel, payload) => {
    if (channel === 'desktop.provider-profile.save') {
      const request = asSaveRequest(payload);
      if (request === undefined) throw new Error('The provider profile request is not valid.');
      return store.save(request);
    }
    if (channel === 'desktop.provider-profile.list') return store.list();
    if (channel === 'desktop.provider-profile.delete') {
      const id = asProfileId(payload);
      if (id !== undefined) store.remove(id);
      return undefined;
    }
    return UNHANDLED;
  };
}

type ProviderCallOutcome =
  | {
      readonly kind: 'reply';
      readonly status: number;
      readonly ok: boolean;
      readonly text: string;
      readonly bytes: number;
    }
  | { readonly kind: 'redirect' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'timeout' };

interface ProviderCallInput {
  readonly requestId: string;
  readonly url: string;
  readonly key: string;
  readonly body: unknown;
}

/**
 * Sends one provider request from the page, so the fake provider's Playwright route answers it.
 * The request never leaves the page's own origin rules: the route answers the CORS preflight.
 */
async function callProviderFromPage(
  page: Page,
  input: ProviderCallInput,
  timeoutMs: number,
): Promise<ProviderCallOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProviderCallOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  try {
    const sent = page
      .evaluate(async (call) => {
        const host = window as unknown as {
          __joyProviderCalls?: Map<string, AbortController>;
        };
        const calls = (host.__joyProviderCalls ??= new Map<string, AbortController>());
        const controller = new AbortController();
        calls.set(call.requestId, controller);
        try {
          const response = await fetch(call.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${call.key}`,
            },
            body: JSON.stringify(call.body ?? {}),
            // A redirect is refused rather than followed, as the desktop broker does.
            redirect: 'manual',
            signal: controller.signal,
          });
          if (response.type === 'opaqueredirect' || response.status === 0)
            return { kind: 'redirect' as const };
          const buffer = await response.arrayBuffer();
          return {
            kind: 'reply' as const,
            status: response.status,
            ok: response.ok,
            text: new TextDecoder().decode(buffer),
            bytes: buffer.byteLength,
          };
        } catch {
          return { kind: 'unreachable' as const };
        } finally {
          calls.delete(call.requestId);
        }
      }, input)
      .catch((): ProviderCallOutcome => ({ kind: 'unreachable' }));
    const outcome = await Promise.race([sent, timeout]);
    if (outcome.kind === 'timeout') await abortProviderCall(page, input.requestId);
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Ends a provider request the Worker cancelled, so no call is left running. */
async function abortProviderCall(page: Page, requestId: string): Promise<void> {
  await page
    .evaluate((id) => {
      const host = window as unknown as {
        __joyProviderCalls?: Map<string, AbortController>;
      };
      host.__joyProviderCalls?.get(id)?.abort();
      host.__joyProviderCalls?.delete(id);
    }, requestId)
    .catch(() => undefined);
}

/**
 * Answers `desktop.agent.request` and `desktop.agent.cancel`: the provider broker the desktop
 * hosts. A reply carries the provider's text and nothing else; a failure carries the broker's own
 * code, so the editor reports it the way the desktop does.
 */
export function createProviderBrokerHandler(
  store: ProviderProfileStore,
  page: Page,
  options: ProviderBrokerOptions = {},
): ChannelHandler {
  const timeoutMs = options.timeoutMs ?? PROVIDER_CALL_TIMEOUT_MS;
  return async (channel, payload) => {
    if (channel === 'desktop.agent.cancel') {
      const requestId = asRequestId(payload);
      if (requestId !== undefined) await abortProviderCall(page, requestId);
      return undefined;
    }
    if (channel !== 'desktop.agent.request') return UNHANDLED;
    const request = asAgentRequest(payload);
    if (request === undefined)
      return { ok: false, code: 'REQUEST_INVALID', message: 'The provider request is not valid.' };
    const profile = store.get(request.profileId);
    if (profile === undefined)
      return { ok: false, code: 'PROFILE_NOT_FOUND', message: 'The saved profile was not found.' };
    // The broker checks the call against the profile it belongs to, so a key never reaches another
    // endpoint.
    if (normalizeBaseUrl(request.baseUrl) !== normalizeBaseUrl(profile.baseUrl))
      return {
        ok: false,
        code: 'BINDING_MISMATCH',
        message: 'The request does not match the saved endpoint.',
      };
    const secret = store.secretFor(request.profileId);
    if (secret === undefined)
      return {
        ok: false,
        code: 'CREDENTIAL_UNAVAILABLE',
        message: 'The saved key is not available.',
      };
    const outcome = await callProviderFromPage(
      page,
      {
        requestId: request.requestId,
        url: `${profile.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        key: secret,
        body: request.body,
      },
      timeoutMs,
    );
    if (outcome.kind === 'timeout')
      return {
        ok: false,
        code: 'TIMEOUT',
        message: 'The provider did not answer in time.',
      };
    if (outcome.kind === 'redirect')
      return {
        ok: false,
        code: 'REDIRECT_REFUSED',
        message: 'The provider redirected. Redirects are not followed.',
      };
    if (outcome.kind === 'unreachable')
      return {
        ok: false,
        code: 'NETWORK_ERROR',
        message: 'The provider could not be reached.',
      };
    if (outcome.status === 401 || outcome.status === 403)
      return {
        ok: false,
        code: 'AUTH_FAILED',
        message: `The provider rejected the credentials (HTTP ${outcome.status}).`,
      };
    if (outcome.status === 402)
      return {
        ok: false,
        code: 'BILLING_REQUIRED',
        message: 'The provider account needs credit to complete this request.',
      };
    if (!outcome.ok)
      return {
        ok: false,
        code: 'PROVIDER_HTTP_ERROR',
        message: `The provider returned HTTP ${outcome.status}.`,
      };
    if (outcome.bytes > MAX_RESPONSE_BYTES)
      return {
        ok: false,
        code: 'RESPONSE_TOO_LARGE',
        message: 'The provider reply is larger than 4 MiB.',
      };
    return { ok: true, text: outcome.text };
  };
}

/**
 * The desktop-only reads the editor makes on start-up once the bridge is installed. They answer
 * with the desktop's own empty answers, so the harness stays quiet and deterministic.
 */
export function createDesktopHostReadHandler(): ChannelHandler {
  return (channel) => {
    if (channel === 'desktop.window-is-maximized') return false;
    if (channel === 'desktop.agent-slots.list') return [];
    return UNHANDLED;
  };
}

/**
 * Installs the desktop host the JOY Code connect path needs. Call it once per page, before the
 * page navigates: the bridge is what makes `isDesktopHost()` true.
 */
export async function installJoyProviderHost(
  page: Page,
  options: JoyProviderHostOptions = {},
): Promise<InstalledJoyDesktopBridge> {
  const store = createProviderProfileStore();
  return installJoyDesktopBridge(
    page,
    [
      createProviderProfileHandler(store),
      createProviderBrokerHandler(store, page, options),
      createDesktopHostReadHandler(),
    ],
    {
      channels: [
        'desktop.provider-profile.save',
        'desktop.provider-profile.list',
        'desktop.provider-profile.delete',
        'desktop.agent.request',
        'desktop.agent.cancel',
        'desktop.agent-slots.list',
        'desktop.window-is-maximized',
      ],
    },
  );
}
