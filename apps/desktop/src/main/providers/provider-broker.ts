/**
 * The provider broker (PLAN-v4 §6a, §6b, §6c). It is the only code that reads a provider key. The
 * renderer and the Worker name a profile; the broker loads it, applies the endpoint policy, checks
 * that the saved key is bound to that exact endpoint, sends one request and returns a reply that
 * never contains a credential, a base URL or a header.
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
  type DirectProviderErrorCode,
  type DirectProviderProbeReport,
  type SecretStore,
  evaluateEndpoint,
  findRegistryProvider,
  normalizeBaseUrl,
} from '@joy-media/provider-sdk';
import {
  parseChatModels,
  prepareChatCompletion,
  prepareChatModels,
} from './adapters/chat-completions.js';
import {
  anthropicReplyToChatCompletion,
  parseAnthropicModels,
  prepareAnthropicMessages,
  prepareAnthropicModels,
} from './adapters/anthropic-messages.js';
import { AdapterRequestError, type ModelEntry, type PreparedCall } from './adapters/types.js';
import { isRecord, parseCompletionBody, type CompletionBody } from './request-body.js';

/** Largest request the broker sends, and largest reply it reads (PLAN-v4 §6b). */
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const COMPLETE_TIMEOUT_MS = 120_000;
const CONTROL_TIMEOUT_MS = 15_000;
/** The placeholder the editor sends for a keyless local model. It is never a real key. */
const NO_KEY_PLACEHOLDER = 'not-provided';

export type BrokerErrorCode =
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_DISABLED'
  | 'ENDPOINT_REFUSED'
  | 'BINDING_MISMATCH'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'REQUEST_INVALID'
  | 'REQUEST_TOO_LARGE'
  | 'AUTH_FAILED'
  | 'REDIRECT_REFUSED'
  | 'PROVIDER_HTTP_ERROR'
  | 'PROVIDER_INCOMPATIBLE'
  | 'RESPONSE_TOO_LARGE'
  | 'TIMEOUT'
  | 'NETWORK_ERROR';

export interface BrokerFailure {
  readonly ok: false;
  readonly code: BrokerErrorCode;
  readonly message: string;
}

export type BrokerResult<T> = { readonly ok: true; readonly data: T } | BrokerFailure;

/** The non-secret part of a saved profile, as the broker reads it. */
export interface BrokerProfile {
  readonly id: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly secretHandleId: string;
  /** Digest of (profile id, origin, base path) taken at save time. Missing means never bound. */
  readonly bindingDigest?: string | undefined;
}

export interface ProviderBrokerStore {
  getProfile(id: string): BrokerProfile | undefined;
  isDisabledLegacy(id: string): boolean;
  markCredentialUnavailable(id: string): void;
}

/** An unsaved profile, sent once for a model list. The broker holds it in memory only. */
export interface ProviderDraft {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

export type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ProviderBrokerDeps {
  readonly store: ProviderBrokerStore;
  readonly secrets: SecretStore;
  readonly fetch: ProviderFetch;
  /** Every address a host name resolves to. Injected so tests never touch DNS. */
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  /** Test hook: shorter timeouts. Production uses the defaults above. */
  readonly timeoutMs?: { readonly complete?: number; readonly control?: number };
}

export interface ProviderBroker {
  /** One chat request. The reply is the Chat Completions JSON text the engine already parses. */
  complete(request: {
    readonly profileId: string;
    readonly body: unknown;
    /** The model the session chose. The profile's own model is used when this is absent. */
    readonly modelId?: string;
    /** The base URL the user saw. It must equal the saved profile's, or the call is refused. */
    readonly baseUrl?: string;
  }): Promise<BrokerResult<{ readonly text: string }>>;
  /** The redacted connectivity probe the settings dialog shows. Never throws. */
  probe(profileId: string): Promise<DirectProviderProbeReport>;
  listModels(
    source: { readonly profileId: string } | { readonly draft: ProviderDraft },
  ): Promise<BrokerResult<readonly ModelEntry[]>>;
}

/** Ties a saved key to one endpoint (PLAN-v4 §6c item 6). A changed URL changes the digest. */
export function endpointBindingDigest(profileId: string, origin: string, basePath: string): string {
  return createHash('sha256')
    .update(JSON.stringify([profileId, origin, basePath]))
    .digest('hex');
}

interface Endpoint {
  readonly api: 'chat-completions' | 'anthropic-messages';
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey: string | undefined;
}

/** Thrown inside the broker, turned into a BrokerFailure at each public method. */
class BrokerError extends Error {
  constructor(
    readonly code: BrokerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function createProviderBroker(deps: ProviderBrokerDeps): ProviderBroker {
  const resolveHost = deps.resolveHost ?? defaultResolveHost;
  const completeMs = deps.timeoutMs?.complete ?? COMPLETE_TIMEOUT_MS;
  const controlMs = deps.timeoutMs?.control ?? CONTROL_TIMEOUT_MS;

  async function resolveProfile(profileId: string, expectedBaseUrl?: string): Promise<Endpoint> {
    const profile = deps.store.getProfile(profileId);
    if (profile === undefined)
      throw new BrokerError('PROFILE_NOT_FOUND', 'Unknown provider profile');
    if (
      expectedBaseUrl !== undefined &&
      normalizeBaseUrl(expectedBaseUrl) !== normalizeBaseUrl(profile.baseUrl)
    ) {
      throw new BrokerError(
        'ENDPOINT_REFUSED',
        'The base URL no longer matches the saved profile.',
      );
    }
    if (deps.store.isDisabledLegacy(profileId)) {
      throw new BrokerError(
        'PROFILE_DISABLED',
        'This profile is a v1.0.x provider that v1.1.0 no longer offers',
      );
    }
    const verdict = evaluateEndpoint(profile.provider, profile.baseUrl);
    if (!verdict.allowed) throw new BrokerError('ENDPOINT_REFUSED', verdict.reason);
    const expected = endpointBindingDigest(profile.id, verdict.origin, verdict.basePath);
    if (profile.bindingDigest !== expected) {
      throw new BrokerError('BINDING_MISMATCH', 'Save this profile again to confirm its endpoint.');
    }
    const hostname = new URL(profile.baseUrl).hostname;
    if (verdict.kind === 'loopback') await assertLoopbackHost(hostname, resolveHost);

    let stored: string | null;
    try {
      stored = await deps.secrets.get(profile.secretHandleId);
    } catch {
      deps.store.markCredentialUnavailable(profileId);
      throw new BrokerError(
        'CREDENTIAL_UNAVAILABLE',
        'The saved key could not be read. Enter it again.',
      );
    }
    const apiKey = usableKey(stored);
    if (apiKey === undefined && verdict.kind === 'registry') {
      throw new BrokerError('CREDENTIAL_UNAVAILABLE', 'The provider key is no longer available');
    }
    return makeEndpoint(profile.provider, profile.baseUrl, profile.modelId, apiKey);
  }

  async function resolveDraft(draft: ProviderDraft): Promise<Endpoint> {
    const verdict = evaluateEndpoint(draft.provider, draft.baseUrl);
    if (!verdict.allowed) throw new BrokerError('ENDPOINT_REFUSED', verdict.reason);
    const hostname = new URL(draft.baseUrl).hostname;
    if (verdict.kind === 'loopback') await assertLoopbackHost(hostname, resolveHost);
    return makeEndpoint(draft.provider, draft.baseUrl, '', usableKey(draft.apiKey));
  }

  async function run(endpoint: Endpoint, body: CompletionBody, timeoutMs: number): Promise<string> {
    const call = prepareCompletion(endpoint, body);
    const reply = assertNoCredential(await send(deps.fetch, call, timeoutMs), endpoint);
    if (endpoint.api === 'anthropic-messages') {
      try {
        return anthropicReplyToChatCompletion(reply, endpoint.modelId);
      } catch {
        throw new BrokerError('PROVIDER_INCOMPATIBLE', 'The provider reply was not understood.');
      }
    }
    try {
      JSON.parse(reply);
    } catch {
      throw new BrokerError('PROVIDER_INCOMPATIBLE', 'The provider reply was not valid JSON.');
    }
    return reply;
  }

  return {
    async complete(request) {
      try {
        const parsed = parseCompletionBody(request.body);
        if (!parsed.ok) throw new BrokerError('REQUEST_INVALID', parsed.message);
        if (Buffer.byteLength(JSON.stringify(parsed.body)) > MAX_REQUEST_BYTES) {
          throw new BrokerError('REQUEST_TOO_LARGE', 'The request is larger than 1 MiB.');
        }
        const resolved = await resolveProfile(request.profileId, request.baseUrl);
        const endpoint =
          request.modelId === undefined
            ? resolved
            : { ...resolved, modelId: safeModelId(request.modelId) };
        const text = await run(endpoint, parsed.body, completeMs);
        return { ok: true, data: { text } };
      } catch (error) {
        return failureOf(error);
      }
    },

    async probe(profileId) {
      const modelId = deps.store.getProfile(profileId)?.modelId ?? '';
      try {
        const endpoint = await resolveProfile(profileId);
        await run(
          endpoint,
          { messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
          controlMs,
        );
        return { ok: true, modelId };
      } catch (error) {
        const failure = failureOf(error);
        return {
          ok: false,
          modelId,
          errorCode: probeErrorCode(failure.code),
          message: failure.message,
        };
      }
    },

    async listModels(source) {
      try {
        const endpoint =
          'draft' in source
            ? await resolveDraft(source.draft)
            : await resolveProfile(source.profileId);
        const call =
          endpoint.api === 'anthropic-messages'
            ? prepareAnthropicModels({ baseUrl: endpoint.baseUrl, apiKey: requireKey(endpoint) })
            : prepareChatModels({ baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey });
        const reply = assertNoCredential(await send(deps.fetch, call, controlMs), endpoint);
        try {
          const models =
            endpoint.api === 'anthropic-messages'
              ? parseAnthropicModels(reply)
              : parseChatModels(reply);
          return { ok: true, data: models };
        } catch {
          throw new BrokerError('PROVIDER_INCOMPATIBLE', 'The model list was not understood.');
        }
      } catch (error) {
        return failureOf(error);
      }
    },
  };
}

function makeEndpoint(
  provider: string,
  baseUrl: string,
  modelId: string,
  apiKey: string | undefined,
): Endpoint {
  const api = findRegistryProvider(provider)?.api ?? 'chat-completions';
  return { api, baseUrl: normalizeBaseUrl(baseUrl), modelId, apiKey };
}

/** A reply that carries the key is refused, and its text is never returned. */
function assertNoCredential(reply: string, endpoint: Endpoint): string {
  if (endpoint.apiKey !== undefined && reply.includes(endpoint.apiKey)) {
    throw new BrokerError(
      'PROVIDER_INCOMPATIBLE',
      'The provider reply was refused: it contained a credential.',
    );
  }
  return reply;
}

/** A keyless local model sends no credential. Any other value is a key, sent as given. */
function usableKey(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value.length === 0 || value === NO_KEY_PLACEHOLDER) return undefined;
  return value;
}

/** A model id is a short token with no spaces or control characters (it is sent as JSON). */
function safeModelId(value: string): string {
  if (!/^[A-Za-z0-9._:/@+-]{1,256}$/.test(value)) {
    throw new BrokerError('REQUEST_INVALID', 'The model id is not valid.');
  }
  return value;
}

function requireKey(endpoint: Endpoint): string {
  if (endpoint.apiKey === undefined) {
    throw new BrokerError('CREDENTIAL_UNAVAILABLE', 'Enter the provider key first.');
  }
  return endpoint.apiKey;
}

function prepareCompletion(endpoint: Endpoint, body: CompletionBody): PreparedCall {
  try {
    if (endpoint.api === 'anthropic-messages') {
      return prepareAnthropicMessages({
        baseUrl: endpoint.baseUrl,
        apiKey: requireKey(endpoint),
        modelId: endpoint.modelId,
        body,
      });
    }
    return prepareChatCompletion({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      modelId: endpoint.modelId,
      body,
    });
  } catch (error) {
    if (error instanceof AdapterRequestError)
      throw new BrokerError('REQUEST_INVALID', error.message);
    throw error;
  }
}

/**
 * Sends one request and returns the reply text. Redirects are never followed; a credential is
 * never placed in an error message; the reply is read up to MAX_RESPONSE_BYTES.
 */
async function send(
  fetchImpl: ProviderFetch,
  call: PreparedCall,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(call.url, {
      method: call.method,
      headers: call.headers,
      ...(call.body === undefined ? {} : { body: call.body }),
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const target = response.headers.get('location');
      const named = target === null ? '' : ` to ${target.slice(0, 200)}`;
      throw new BrokerError(
        'REDIRECT_REFUSED',
        `The provider redirected${named}. Redirects are not followed.`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new BrokerError(
        'AUTH_FAILED',
        `The provider rejected the credentials (HTTP ${response.status}).`,
      );
    }
    if (!response.ok) {
      throw new BrokerError(
        'PROVIDER_HTTP_ERROR',
        `The provider returned HTTP ${response.status}.`,
      );
    }
    return await readBounded(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof BrokerError) throw error;
    if (isAbortError(error))
      throw new BrokerError('TIMEOUT', 'The provider did not answer in time.');
    throw new BrokerError('NETWORK_ERROR', 'The provider could not be reached.');
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(response: Response, limit: number): Promise<string> {
  const announced = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(announced) && announced > limit) {
    throw new BrokerError('RESPONSE_TOO_LARGE', 'The provider reply is larger than 4 MiB.');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new BrokerError('RESPONSE_TOO_LARGE', 'The provider reply is larger than 4 MiB.');
    }
    chunks.push(next.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** `localhost` is trusted only when every address it resolves to is this computer (PLAN-v4 §6a). */
async function assertLoopbackHost(
  hostname: string,
  resolveHost: (name: string) => Promise<readonly string[]>,
): Promise<void> {
  if (hostname === '127.0.0.1') return;
  const addresses = await resolveHost(hostname);
  if (addresses.length === 0 || !addresses.every(isLoopbackAddress)) {
    throw new BrokerError('ENDPOINT_REFUSED', 'localhost must resolve to this computer only.');
  }
}

function isLoopbackAddress(address: string): boolean {
  return address.startsWith('127.') || address === '::1' || address.startsWith('::ffff:127.');
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

function failureOf(error: unknown): BrokerFailure {
  if (error instanceof BrokerError) return { ok: false, code: error.code, message: error.message };
  return { ok: false, code: 'NETWORK_ERROR', message: 'The request failed.' };
}

function probeErrorCode(code: BrokerErrorCode): DirectProviderErrorCode {
  switch (code) {
    case 'AUTH_FAILED':
    case 'CREDENTIAL_UNAVAILABLE':
      return 'AUTH_FAILED';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'NETWORK_ERROR':
      return 'NETWORK_ERROR';
    case 'RESPONSE_TOO_LARGE':
      return 'RESPONSE_TOO_LARGE';
    default:
      return 'PROVIDER_INCOMPATIBLE';
  }
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}
