/**
 * The provider broker (PLAN-v4 §6a, §6b, §6c). It is the only code that reads a provider key. The
 * renderer and the Worker name a profile; the broker loads it, applies the endpoint policy, checks
 * that the saved key is bound to that exact endpoint, sends one request and returns a reply that
 * never contains a credential, a base URL or a header.
 */
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
import { endpointBindingDigest } from '../../store/profile-binding.js';

export { endpointBindingDigest };

/** Largest request the broker sends, and largest reply it reads (PLAN-v4 §6b). */
/** The largest request the Worker route may send (PLAN-v4 §6b). */
export const MAX_WORKER_REQUEST_BYTES = 1024 * 1024;
/** The largest request the editor may send: the observation batch limit (MAX_MULTIMODAL_REQUEST_BYTES). */
export const MAX_AGENT_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const COMPLETE_TIMEOUT_MS = 120_000;
/** Long enough for a local model that is still loading. */
const CONTROL_TIMEOUT_MS = 30_000;
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
  /** The key version the binding was made for. A key written since then no longer matches. */
  readonly bindingSecretDigest?: string | undefined;
}

export interface ProviderBrokerStore {
  getProfile(id: string): BrokerProfile | undefined;
  isDisabledLegacy(id: string): boolean;
  markCredentialUnavailable(id: string): void;
  /** The version of the key stored under a handle (see secretVersionDigest in the store). */
  secretVersion(handleId: string): string;
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
    /** The largest request this call may send. The Worker route passes its own, smaller limit. */
    readonly maxRequestBytes?: number;
    /** Ends the provider call when the caller has gone, so a request nobody reads is not paid for. */
    readonly signal?: AbortSignal | undefined;
  }): Promise<BrokerResult<{ readonly text: string }>>;
  /** The redacted connectivity probe the settings dialog shows. Never throws. */
  probe(profileId: string): Promise<DirectProviderProbeReport>;
  listModels(
    source: { readonly profileId: string } | { readonly draft: ProviderDraft },
  ): Promise<BrokerResult<readonly ModelEntry[]>>;
}

interface Endpoint {
  readonly api: 'chat-completions' | 'anthropic-messages';
  readonly provider: string;
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
      throw new BrokerError('BINDING_MISMATCH', 'Enter the key again to confirm this endpoint.');
    }
    // The key must be the one confirmed for this endpoint. A key written since, by any build, has a
    // new version and is refused until it is entered again (PLAN-v4 §6c item 6).
    if (profile.bindingSecretDigest !== deps.store.secretVersion(profile.secretHandleId)) {
      throw new BrokerError(
        'BINDING_MISMATCH',
        'The saved key changed after it was confirmed for this endpoint. Enter it again.',
      );
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

  async function run(
    endpoint: Endpoint,
    body: CompletionBody,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const call = prepareCompletion(endpoint, body);
    const reply = assertNoCredential(
      await send(deps.fetch, call, timeoutMs, endpoint.apiKey, signal),
      endpoint,
    );
    if (endpoint.api === 'anthropic-messages') {
      if (stopReasonOf(reply) === 'pause_turn') {
        throw new BrokerError(
          'PROVIDER_INCOMPATIBLE',
          'The model paused its turn. This build cannot continue it.',
        );
      }
      let converted: string;
      try {
        converted = anthropicReplyToChatCompletion(reply, endpoint.modelId);
      } catch {
        throw new BrokerError('PROVIDER_INCOMPATIBLE', 'The provider reply was not understood.');
      }
      return checkedReply(converted, endpoint);
    }
    try {
      JSON.parse(reply);
    } catch {
      throw new BrokerError('PROVIDER_INCOMPATIBLE', 'The provider reply was not valid JSON.');
    }
    return checkedReply(reply, endpoint);
  }

  return {
    async complete(request) {
      try {
        const parsed = parseCompletionBody(request.body);
        if (!parsed.ok) throw new BrokerError('REQUEST_INVALID', parsed.message);
        const limit = request.maxRequestBytes ?? MAX_AGENT_REQUEST_BYTES;
        if (Buffer.byteLength(JSON.stringify(parsed.body)) > limit) {
          throw new BrokerError(
            'REQUEST_TOO_LARGE',
            `The request is larger than ${limit / (1024 * 1024)} MiB.`,
          );
        }
        const resolved = await resolveProfile(request.profileId, request.baseUrl);
        const endpoint =
          request.modelId === undefined
            ? resolved
            : { ...resolved, modelId: safeModelId(request.modelId) };
        const text = await run(endpoint, parsed.body, completeMs, request.signal);
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
        const reply = assertNoCredential(
          await send(deps.fetch, call, controlMs, endpoint.apiKey),
          endpoint,
        );
        let models: readonly ModelEntry[];
        try {
          models =
            endpoint.api === 'anthropic-messages'
              ? parseAnthropicModels(reply)
              : parseChatModels(reply);
        } catch {
          throw new BrokerError('PROVIDER_INCOMPATIBLE', 'The model list was not understood.');
        }
        return { ok: true, data: models };
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
  return { api, provider, baseUrl: normalizeBaseUrl(baseUrl), modelId, apiKey };
}

/** A reply that carries the key is refused, and its text is never returned. */
function assertNoCredential(reply: string, endpoint: Endpoint): string {
  if (endpoint.apiKey !== undefined && holdsCredential(reply, endpoint.apiKey)) {
    throw new BrokerError(
      'PROVIDER_INCOMPATIBLE',
      'The provider reply was refused: it contained a credential.',
    );
  }
  return reply;
}

/** How deep a string that holds JSON is searched. Past it, a string that parses is refused. */
const MAX_NESTED_JSON = 8;

/**
 * True when the key shows in the reply: in its text, in a JSON string, or in a string that is itself
 * JSON, such as a tool call's arguments. JSON escapes do not hide it (PLAN-v4 §6b).
 */
function holdsCredential(reply: string, key: string): boolean {
  return textHoldsKey(reply, key, 0);
}

function textHoldsKey(text: string, key: string, depth: number): boolean {
  if (text.includes(key)) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return valueHoldsKey(parsed, key, depth);
}

function valueHoldsKey(value: unknown, key: string, depth: number): boolean {
  if (typeof value === 'string') {
    if (value.includes(key)) return true;
    // Only a string with a backslash can hide the key behind a JSON escape.
    if (!value.includes('\\')) return false;
    if (depth >= MAX_NESTED_JSON) return isJsonText(value);
    return textHoldsKey(value, key, depth + 1);
  }
  if (Array.isArray(value)) return value.some((item) => valueHoldsKey(item, key, depth));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(
      ([name, item]) => name.includes(key) || valueHoldsKey(item, key, depth),
    );
  }
  return false;
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The reply that leaves the broker holds no credential, and a refusal is not passed off as an answer. */
function checkedReply(text: string, endpoint: Endpoint): string {
  assertNoCredential(text, endpoint);
  if (modelRefused(text)) {
    throw new BrokerError('PROVIDER_INCOMPATIBLE', 'The model refused this request.');
  }
  return text;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stopReasonOf(reply: string): string | undefined {
  const stop = parseObject(reply)?.stop_reason;
  return typeof stop === 'string' ? stop : undefined;
}

/** A refusal is a finish reason of content_filter, or a refusal message, in the first choice. */
function modelRefused(text: string): boolean {
  const first = parseObject(text)?.choices;
  if (!Array.isArray(first)) return false;
  const choice: unknown = first[0];
  if (!isRecord(choice)) return false;
  if (choice.finish_reason === 'content_filter') return true;
  const message: unknown = choice.message;
  return isRecord(message) && typeof message.refusal === 'string' && message.refusal.length > 0;
}

/** A keyless local model sends no credential. Any other value is a key, sent as given. */
function usableKey(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value.length === 0 || value === NO_KEY_PLACEHOLDER) return undefined;
  return value;
}

/** A model id travels inside a JSON body, so it needs a sane length and no control characters. */
function safeModelId(value: string): string {
  const hasControl = [...value].some(
    (char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f,
  );
  if (value.length === 0 || value.length > 256 || hasControl) {
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
      // OpenAI's newer models take the completion limit under this name.
      tokenLimitKey: endpoint.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens',
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
  secret: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const response = await fetchImpl(call.url, {
      method: call.method,
      headers: call.headers,
      ...(call.body === undefined ? {} : { body: call.body }),
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const named = namedTarget(response.headers.get('location'), call.url, secret);
      throw new BrokerError(
        'REDIRECT_REFUSED',
        `The provider redirected${named === '' ? '' : ` to ${named}`}. Redirects are not followed.`,
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
    if (signal?.aborted) throw new BrokerError('NETWORK_ERROR', 'The request was cancelled.');
    if (isAbortError(error))
      throw new BrokerError('TIMEOUT', 'The provider did not answer in time.');
    throw new BrokerError('NETWORK_ERROR', 'The provider could not be reached.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

/**
 * The redirect target without its query or fragment, or nothing when the key could show in it. A
 * target whose escapes cannot be read counts as one that could (PLAN-v4 §6b).
 */
function namedTarget(
  location: string | null,
  requestUrl: string,
  secret: string | undefined,
): string {
  if (location === null) return '';
  let target: URL;
  try {
    target = new URL(location, requestUrl);
  } catch {
    return '';
  }
  const named = `${target.origin}${target.pathname}`;
  if (secret !== undefined && secret.length > 0 && mayShowKey(named, secret)) return '';
  return named;
}

const MAX_DECODE_PASSES = 4;

/** True when the key shows in the text as written, or once its percent escapes are decoded. */
function mayShowKey(text: string, key: string): boolean {
  let current = text;
  for (let pass = 0; pass <= MAX_DECODE_PASSES; pass += 1) {
    if (current.includes(key)) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return true;
    }
    if (decoded === current) return false;
    current = decoded;
  }
  return true;
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
