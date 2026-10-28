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
import { ContinuationState } from './continuation-state.js';

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
  /** The saved profile this call is for; empty for an unsaved draft. Keys the provider state of a tool call. */
  readonly profileId: string;
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
  // The provider state each tool call of a reply carries back. Kept here, never sent on in a reply.
  const continuation = new ContinuationState();

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
    return makeEndpoint(profile.id, profile.provider, profile.baseUrl, profile.modelId, apiKey);
  }

  async function resolveDraft(draft: ProviderDraft): Promise<Endpoint> {
    const verdict = evaluateEndpoint(draft.provider, draft.baseUrl);
    if (!verdict.allowed) throw new BrokerError('ENDPOINT_REFUSED', verdict.reason);
    const hostname = new URL(draft.baseUrl).hostname;
    if (verdict.kind === 'loopback') await assertLoopbackHost(hostname, resolveHost);
    return makeEndpoint('', draft.provider, draft.baseUrl, '', usableKey(draft.apiKey));
  }

  async function run(
    endpoint: Endpoint,
    body: CompletionBody,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const call = prepareCompletion(endpoint, body, continuation);
    const reply = assertNoCredential(
      await send(deps.fetch, call, timeoutMs, endpoint.apiKey, signal),
      endpoint,
    );
    rememberContinuation(continuation, endpoint, reply);
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
      return checkedReply(completionEnvelope(converted), endpoint);
    }
    return checkedReply(completionEnvelope(reply), endpoint);
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
  profileId: string,
  provider: string,
  baseUrl: string,
  modelId: string,
  apiKey: string | undefined,
): Endpoint {
  const api = findRegistryProvider(provider)?.api ?? 'chat-completions';
  return { profileId, api, provider, baseUrl: normalizeBaseUrl(baseUrl), modelId, apiKey };
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
    // A property name is a string too: it can hold JSON, escapes and all.
    return Object.entries(value).some(
      ([name, item]) => valueHoldsKey(name, key, depth) || valueHoldsKey(item, key, depth),
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

/** Thrown for a reply the engine could not read. The text of the reply is never part of the message. */
function notUnderstood(): never {
  throw new BrokerError('PROVIDER_INCOMPATIBLE', 'The provider reply was not understood.');
}

/**
 * A tool call id, as the engine sends it back to the provider. Providers write letters, digits, dashes and
 * underscores, and some add dots and colons (Kimi writes `functions.name:0`). A slash is never part of an id.
 */
const TOOL_CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** A tool name, as the capability check reads it. A URL or a path in that field is refused. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
/** A finish reason is a lowercase word, such as `stop` or `tool_calls`. A URL in that field is refused. */
const FINISH_REASON = /^[a-z_]{1,32}$/;

/**
 * The completion the engine reads, rebuilt from the fields it needs and nothing else. The engine reads
 * `choices[0].message` and the tool calls in it, so the provider's envelope (`id`, `object`, `created`, `model`
 * and `usage`) is dropped, and none of its metadata reaches the Worker. Each field the engine or the checks read
 * is type-checked: a wrong type is refused, not dropped. Model-authored strings are kept exactly as written
 * (PLAN-v4 §6b). Both paths pass through here; the Anthropic reply is converted to this shape first.
 */
function completionEnvelope(reply: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    throw new BrokerError('PROVIDER_INCOMPATIBLE', 'The provider reply was not valid JSON.');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) notUnderstood();
  return JSON.stringify({ choices: parsed.choices.map(completionChoice) });
}

function completionChoice(choice: unknown): Record<string, unknown> {
  if (!isRecord(choice)) notUnderstood();
  const out: Record<string, unknown> = {};
  if (
    choice.finish_reason === null ||
    (typeof choice.finish_reason === 'string' && FINISH_REASON.test(choice.finish_reason))
  ) {
    out.finish_reason = choice.finish_reason;
  } else if (choice.finish_reason !== undefined) {
    notUnderstood();
  }
  if (choice.message !== undefined) out.message = completionMessage(choice.message);
  return out;
}

function completionMessage(message: unknown): Record<string, unknown> {
  if (!isRecord(message)) notUnderstood();
  const out: Record<string, unknown> = {};
  // The engine reads a present role as the assistant's. Any other value, null included, is refused.
  if (message.role !== undefined) {
    if (message.role !== 'assistant') notUnderstood();
    out.role = message.role;
  }
  if (message.content === null || typeof message.content === 'string') {
    out.content = message.content;
  } else if (message.content !== undefined) {
    notUnderstood();
  }
  if (message.refusal === null || typeof message.refusal === 'string') {
    out.refusal = message.refusal;
  } else if (message.refusal !== undefined) {
    notUnderstood();
  }
  // Some servers send `tool_calls: null` on a text answer. That is the same as no tool calls.
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    if (!Array.isArray(message.tool_calls)) notUnderstood();
    out.tool_calls = message.tool_calls.map(completionToolCall);
  }
  return out;
}

function completionToolCall(call: unknown): Record<string, unknown> {
  if (!isRecord(call) || !isRecord(call.function)) notUnderstood();
  const fn = call.function;
  if (typeof call.id !== 'string' || !TOOL_CALL_ID.test(call.id)) notUnderstood();
  if (call.type !== undefined && call.type !== 'function') notUnderstood();
  if (typeof fn.name !== 'string' || !TOOL_NAME.test(fn.name)) notUnderstood();
  if (typeof fn.arguments !== 'string') notUnderstood();
  // Written back as 'function': a provider requires that type when the call is sent again.
  return { id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } };
}

/**
 * Keeps the state each tool call of a reply must carry back: a Chat Completions call's `extra_content`, or the
 * Claude thinking blocks that a tool use follows. The reply itself does not carry it onward (ContinuationState).
 */
function rememberContinuation(state: ContinuationState, endpoint: Endpoint, reply: string): void {
  if (endpoint.profileId === '') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    return; // Not JSON: the completion check refuses it, so there is nothing to keep.
  }
  if (!isRecord(parsed)) return;
  if (endpoint.api === 'anthropic-messages') {
    rememberThinking(state, endpoint.profileId, parsed);
    return;
  }
  if (!Array.isArray(parsed.choices)) return;
  for (const choice of parsed.choices) {
    if (
      !isRecord(choice) ||
      !isRecord(choice.message) ||
      !Array.isArray(choice.message.tool_calls)
    ) {
      continue;
    }
    for (const call of choice.message.tool_calls) {
      if (isRecord(call) && typeof call.id === 'string' && call.extra_content !== undefined) {
        state.remember(endpoint.profileId, call.id, call.extra_content);
      }
    }
  }
}

/** Claude's thinking blocks come before a tool use, and the tool use needs them on its next request. */
function rememberThinking(
  state: ContinuationState,
  profileId: string,
  reply: Record<string, unknown>,
): void {
  if (!Array.isArray(reply.content)) return;
  const thinking = reply.content.filter(
    (block): block is Record<string, unknown> =>
      isRecord(block) && (block.type === 'thinking' || block.type === 'redacted_thinking'),
  );
  if (thinking.length === 0) return;
  for (const block of reply.content) {
    if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string') {
      state.remember(profileId, block.id, thinking);
    }
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

function prepareCompletion(
  endpoint: Endpoint,
  body: CompletionBody,
  continuation: ContinuationState,
): PreparedCall {
  const stateFor = (callId: string): unknown => continuation.recall(endpoint.profileId, callId);
  try {
    if (endpoint.api === 'anthropic-messages') {
      return prepareAnthropicMessages({
        baseUrl: endpoint.baseUrl,
        apiKey: requireKey(endpoint),
        modelId: endpoint.modelId,
        body,
        thinkingBefore: stateFor,
      });
    }
    return prepareChatCompletion({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      modelId: endpoint.modelId,
      body,
      // OpenAI's newer models take the completion limit under this name.
      tokenLimitKey: endpoint.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens',
      extraContentFor: stateFor,
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
