import type { ByokSessionConfig } from './protocol.js';
import {
  MAX_OBSERVATION_CONSENT_RANGE_US,
  OBSERVATION_MODALITIES,
  ObservationConsentRegistry,
  type ObservationMediaCapability,
  type ObservationModality,
  type ObservationRange,
} from './observation-consent.js';

/** The direct-provider boundary never builds an unbounded in-memory body. */
export const MAX_MULTIMODAL_EVIDENCE_PER_BATCH = 16;
export const MAX_MULTIMODAL_EVIDENCE_BYTES = 16 * 1024 * 1024;
/** Leaves headroom for base64 and JSON while keeping the serialized body bounded. */
export const MAX_MULTIMODAL_BATCH_EVIDENCE_BYTES = 20 * 1024 * 1024;
export const MAX_MULTIMODAL_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_MULTIMODAL_PROMPT_BYTES = 16 * 1024;
/**
 * The provider response is read through a stream with this hard byte cap.
 * This limits the temporary parser buffer; raw provider bodies never leave
 * this module or appear in a returned result.
 */
export const MAX_MULTIMODAL_RESPONSE_BYTES = 64 * 1024;
/** A successful analysis is deliberately smaller than the transport response. */
export const MAX_MULTIMODAL_ANALYSIS_TEXT_BYTES = 16 * 1024;

export interface ObservationEvidencePayload {
  /** Must exactly match an evidence ID in the host-issued consent scope. */
  readonly evidenceId: string;
  readonly modality: ObservationModality;
  /** A bounded, simple MIME type; it is never inferred from a filename or URL. */
  readonly mimeType: string;
  /** Explicit bytes owned by the caller; this transport never resolves a URL or file path. */
  readonly data: Uint8Array;
}

/**
 * Per-call inputs for a direct provider request. The BYOK key is only used to
 * form the immediate Authorization header: it is not retained by the transport
 * instance, returned in a result, or included in its provider body.
 */
export interface MultimodalTransportRequest {
  readonly connection: ByokSessionConfig;
  readonly projectId: string;
  readonly runId: string;
  readonly range: ObservationRange;
  readonly prompt: string;
  readonly evidence: readonly ObservationEvidencePayload[];
  /** Redacted result of a separate synthetic/public provider capability probe. */
  readonly mediaCapability: ObservationMediaCapability;
  readonly signal?: AbortSignal;
}

/**
 * The only provider-derived value allowed across this boundary. The evidence
 * IDs identify what this request submitted; they do not claim the model
 * reviewed every item.
 */
export interface MultimodalModelAnalysis {
  readonly text: string;
  readonly submittedEvidenceIds: readonly string[];
}

export type MultimodalTransportResult =
  | {
      readonly ok: true;
      /** Exact UTF-8 byte length of the sent JSON body, not a media estimate. */
      readonly requestBytes: number;
      readonly remainingRequests: number;
      /** Parsed, bounded OpenAI-compatible message content; never a raw provider body. */
      readonly analysis: MultimodalModelAnalysis;
    }
  | {
      readonly ok: false;
      /** Deliberately generic: never contains a URL, key, provider body, or media bytes. */
      readonly code:
        'consent-denied' | 'invalid-request' | 'cancelled' | 'network-failed' | 'provider-rejected';
    };

export type MultimodalFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MultimodalTransportOptions {
  /** Test seam only; production uses the browser's direct fetch implementation. */
  readonly fetch?: MultimodalFetch;
}

export interface MultimodalTransport {
  /** Accepts only the opaque object minted by issueObservationConsent(). */
  grant(consent: unknown): void;
  /** Revokes the run and aborts its in-flight direct request(s). */
  cancel(runId: string): boolean;
  /** Performs one bounded direct provider request, or returns a redacted failure. */
  send(request: unknown): Promise<MultimodalTransportResult>;
  /** Stops all current work and permanently closes this instance. */
  dispose(): void;
}

interface ParsedEvidence {
  readonly evidenceId: string;
  readonly modality: ObservationModality;
  readonly mimeType: string;
  readonly data: Uint8Array;
}

interface ParsedRequest {
  readonly connection: ByokSessionConfig;
  readonly endpoint: URL;
  readonly projectId: string;
  readonly runId: string;
  readonly range: ObservationRange;
  readonly prompt: string;
  readonly evidence: readonly ParsedEvidence[];
  readonly signal: AbortSignal | undefined;
}

interface PreparedProviderRequest {
  readonly endpoint: URL;
  readonly body: string;
  readonly requestBytes: number;
  readonly evidenceIds: readonly string[];
  readonly modalities: readonly ObservationModality[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SIMPLE_MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/;
const TEXT_ENCODER = new TextEncoder();
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Control characters and bidi overrides are matched deliberately to reject
// provider-shaped or spoofed strings before they reach a model.
const UNSAFE_ANALYSIS_CHARACTERS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

/**
 * Create a host-only, in-memory transport. It has no persistence, no logging,
 * no proxy fallback, and no URL/file resolution path. Wiring this to a Worker
 * or UI remains a separate integration step.
 */
export function createMultimodalTransport(
  options: MultimodalTransportOptions = {},
): MultimodalTransport {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const consents = new ObservationConsentRegistry();
  const controllersByRun = new Map<string, Set<AbortController>>();
  let disposed = false;

  function addController(runId: string, controller: AbortController): void {
    const controllers = controllersByRun.get(runId) ?? new Set<AbortController>();
    controllers.add(controller);
    controllersByRun.set(runId, controllers);
  }

  function removeController(runId: string, controller: AbortController): void {
    const controllers = controllersByRun.get(runId);
    if (controllers === undefined) return;
    controllers.delete(controller);
    if (controllers.size === 0) controllersByRun.delete(runId);
  }

  return {
    grant(consent: unknown): void {
      if (disposed) throw new Error('multimodal transport is disposed');
      consents.grant(consent);
    },

    cancel(runId: string): boolean {
      const revoked = consents.cancel(runId);
      const controllers = controllersByRun.get(runId);
      if (controllers === undefined) return revoked;
      for (const controller of controllers) controller.abort();
      return true;
    },

    async send(rawRequest: unknown): Promise<MultimodalTransportResult> {
      if (disposed) return failure('cancelled');
      let request: ParsedRequest | undefined;
      try {
        request = parseRequest(rawRequest);
      } catch {
        return failure('invalid-request');
      }
      if (request === undefined) return failure('invalid-request');
      if (request.signal?.aborted === true) return failure('cancelled');

      let prepared: PreparedProviderRequest;
      try {
        prepared = prepareProviderRequest(request);
      } catch {
        return failure('invalid-request');
      }

      const authorization = consents.authorize({
        projectId: request.projectId,
        runId: request.runId,
        endpointUrl: prepared.endpoint.toString(),
        modelId: request.connection.modelId,
        range: request.range,
        evidenceIds: prepared.evidenceIds,
        modalities: prepared.modalities,
        bytes: prepared.requestBytes,
      });
      if (!authorization.allowed) return failure('consent-denied');

      const controller = new AbortController();
      let unlinkAbort: () => void;
      try {
        unlinkAbort = linkAbortSignal(request.signal, controller);
      } catch {
        return failure('invalid-request');
      }
      addController(request.runId, controller);
      if (controller.signal.aborted) {
        unlinkAbort();
        removeController(request.runId, controller);
        return failure('cancelled');
      }

      try {
        const response = await fetcher(prepared.endpoint, {
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          redirect: 'error',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${request.connection.apiKey}`,
          },
          body: prepared.body,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return failure('cancelled');
        if (!isDirectProviderResponse(response, prepared.endpoint)) {
          discardResponseBody(response);
          return failure('provider-rejected');
        }
        const analysis = await readProviderAnalysis(
          response,
          prepared.evidenceIds,
          request.connection.apiKey,
          controller.signal,
        );
        if (controller.signal.aborted) return failure('cancelled');
        if (analysis === undefined) return failure('provider-rejected');
        return {
          ok: true,
          requestBytes: prepared.requestBytes,
          remainingRequests: authorization.remainingRequests,
          analysis,
        };
      } catch {
        return failure(controller.signal.aborted ? 'cancelled' : 'network-failed');
      } finally {
        unlinkAbort();
        removeController(request.runId, controller);
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const controllers of controllersByRun.values()) {
        for (const controller of controllers) controller.abort();
      }
      controllersByRun.clear();
    },
  };
}

function parseRequest(value: unknown): ParsedRequest | undefined {
  if (!isRecord(value) || !hasRequiredAndOptionalKeys(value, REQUEST_KEYS, ['signal']))
    return undefined;
  const connection = parseConnection(value.connection);
  const endpoint = connection === undefined ? undefined : endpointForConnection(connection);
  const range = parseRange(value.range);
  const evidence = parseEvidence(value.evidence);
  const mediaCapability = parseMediaCapability(value.mediaCapability);
  if (
    connection === undefined ||
    endpoint === undefined ||
    !isOpaqueId(value.projectId) ||
    !isOpaqueId(value.runId) ||
    range === undefined ||
    typeof value.prompt !== 'string' ||
    value.prompt.length === 0 ||
    value.prompt.length > MAX_MULTIMODAL_PROMPT_BYTES ||
    TEXT_ENCODER.encode(value.prompt).byteLength > MAX_MULTIMODAL_PROMPT_BYTES ||
    evidence === undefined ||
    mediaCapability === undefined ||
    mediaCapability.modelId !== connection.modelId ||
    !isAbortSignalOrUndefined(value.signal)
  )
    return undefined;

  const supported = new Set(mediaCapability.modalities);
  if (!evidence.every((item) => supported.has(item.modality))) return undefined;
  return {
    connection,
    endpoint,
    projectId: value.projectId,
    runId: value.runId,
    range,
    prompt: value.prompt,
    evidence,
    signal: value.signal,
  };
}

function parseConnection(value: unknown): ByokSessionConfig | undefined {
  if (!isRecord(value) || !hasExactKeys(value, CONNECTION_KEYS)) return undefined;
  const { provider, baseUrl, modelId, apiKey } = value;
  if (
    (provider !== 'openrouter' && provider !== 'openai-compatible') ||
    typeof baseUrl !== 'string' ||
    baseUrl.length === 0 ||
    baseUrl.length > 2_048 ||
    !isOpaqueId(modelId) ||
    typeof apiKey !== 'string' ||
    apiKey.length === 0 ||
    apiKey.length > 4_096 ||
    /[\r\n]/.test(apiKey)
  )
    return undefined;
  return { provider, baseUrl, modelId, apiKey };
}

function endpointForConnection(connection: ByokSessionConfig): URL | undefined {
  try {
    const base = new URL(connection.baseUrl);
    const basePath = base.pathname.replace(/\/+$/, '');
    if (
      !isDirectProviderEndpoint(base) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      basePath.toLowerCase().endsWith('/chat/completions')
    )
      return undefined;
    const endpoint = new URL(`${base.origin}${basePath}/chat/completions`);
    return isDirectProviderEndpoint(endpoint) ? endpoint : undefined;
  } catch {
    return undefined;
  }
}

function parseRange(value: unknown): ObservationRange | undefined {
  if (!isRecord(value) || !hasExactKeys(value, RANGE_KEYS)) return undefined;
  const { domain, startUs, endUs } = value;
  if (
    (domain !== 'source' && domain !== 'composition') ||
    typeof startUs !== 'number' ||
    !Number.isSafeInteger(startUs) ||
    typeof endUs !== 'number' ||
    !Number.isSafeInteger(endUs) ||
    startUs < 0 ||
    endUs <= startUs ||
    endUs - startUs > MAX_OBSERVATION_CONSENT_RANGE_US
  )
    return undefined;
  return { domain, startUs, endUs };
}

function parseEvidence(value: unknown): readonly ParsedEvidence[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MULTIMODAL_EVIDENCE_PER_BATCH
  )
    return undefined;
  const evidence: ParsedEvidence[] = [];
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const item of value) {
    if (!isRecord(item) || !hasExactKeys(item, EVIDENCE_KEYS)) return undefined;
    const { evidenceId, modality, mimeType, data } = item;
    const normalizedMimeType = typeof mimeType === 'string' ? mimeType.toLowerCase() : undefined;
    if (
      !isOpaqueId(evidenceId) ||
      ids.has(evidenceId) ||
      !isObservationModality(modality) ||
      normalizedMimeType === undefined ||
      !isMimeTypeForModality(normalizedMimeType, modality) ||
      !(data instanceof Uint8Array) ||
      data.byteLength === 0 ||
      data.byteLength > MAX_MULTIMODAL_EVIDENCE_BYTES
    )
      return undefined;
    totalBytes += data.byteLength;
    if (totalBytes > MAX_MULTIMODAL_BATCH_EVIDENCE_BYTES) return undefined;
    ids.add(evidenceId);
    evidence.push({ evidenceId, modality, mimeType: normalizedMimeType, data });
  }
  return evidence;
}

function parseMediaCapability(value: unknown): ObservationMediaCapability | undefined {
  if (!isRecord(value) || !hasExactKeys(value, MEDIA_CAPABILITY_KEYS)) return undefined;
  const { modelId, modalities } = value;
  if (
    !isOpaqueId(modelId) ||
    !Array.isArray(modalities) ||
    modalities.length > OBSERVATION_MODALITIES.length ||
    modalities.some((modality) => !isObservationModality(modality))
  )
    return undefined;
  return { modelId, modalities };
}

function prepareProviderRequest(request: ParsedRequest): PreparedProviderRequest {
  const content: Record<string, unknown>[] = [{ type: 'text', text: request.prompt }];
  for (const evidence of request.evidence) content.push(providerContentPart(evidence));
  const body = JSON.stringify({
    model: request.connection.modelId,
    messages: [{ role: 'user', content }],
  });
  const requestBytes = TEXT_ENCODER.encode(body).byteLength;
  if (requestBytes === 0 || requestBytes > MAX_MULTIMODAL_REQUEST_BYTES)
    throw new RangeError('multimodal provider body is outside the bounded transport limit');
  return {
    endpoint: request.endpoint,
    body,
    requestBytes,
    evidenceIds: request.evidence.map((item) => item.evidenceId),
    modalities: [...new Set(request.evidence.map((item) => item.modality))],
  };
}

/** OpenAI-compatible content is constructed locally; no public upload URL is ever produced. */
function providerContentPart(evidence: ParsedEvidence): Record<string, unknown> {
  const base64 = toBase64(evidence.data);
  if (evidence.modality === 'image') {
    return {
      type: 'image_url',
      image_url: { url: `data:${evidence.mimeType};base64,${base64}` },
    };
  }
  if (evidence.modality === 'audio') {
    return {
      type: 'input_audio',
      input_audio: { data: base64, format: evidence.mimeType.slice('audio/'.length) },
    };
  }
  if (evidence.modality === 'video') {
    return {
      type: 'video_url',
      video_url: { url: `data:${evidence.mimeType};base64,${base64}` },
    };
  }
  return {
    type: 'text',
    text: new TextDecoder('utf-8', { fatal: true }).decode(evidence.data),
  };
}

function isDirectProviderResponse(response: Response, endpoint: URL): boolean {
  if (!response.ok || response.redirected || response.type === 'opaqueredirect') return false;
  if (response.url.length === 0) return true;
  try {
    const responseUrl = new URL(response.url);
    return isDirectProviderEndpoint(responseUrl) && responseUrl.origin === endpoint.origin;
  } catch {
    return false;
  }
}

/** Rejects an unread response without exposing its provider-owned bytes. */
function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * Parses only the supported OpenAI-compatible message field. It does not copy
 * response metadata, tool calls, usage records, error payloads, or unknown
 * provider extensions into the host result.
 */
async function readProviderAnalysis(
  response: Response,
  submittedEvidenceIds: readonly string[],
  apiKey: string,
  signal: AbortSignal,
): Promise<MultimodalModelAnalysis | undefined> {
  const bodyText = await readBoundedResponseText(response, signal);
  if (bodyText === undefined) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0)
    return undefined;

  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) return undefined;
  const text = sanitizeProviderAnalysisText(firstChoice.message.content, apiKey);
  if (text === undefined) return undefined;

  return Object.freeze({
    text,
    submittedEvidenceIds: Object.freeze([...submittedEvidenceIds]),
  });
}

/**
 * Reads a Response body as UTF-8 without Response.text(), and never retains
 * more than MAX_MULTIMODAL_RESPONSE_BYTES of decoded-provider input. A body
 * rejected here is cancelled before any raw text can cross this boundary.
 */
async function readBoundedResponseText(
  response: Response,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (responseContentLengthExceedsLimit(response)) {
    discardResponseBody(response);
    return undefined;
  }
  if (signal.aborted || response.body === null) {
    discardResponseBody(response);
    return undefined;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytesRead = 0;
  let completed = false;
  let text = '';
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (signal.aborted) return undefined;
      if (done) {
        text += decoder.decode();
        completed = true;
        return text;
      }
      if (!(value instanceof Uint8Array)) return undefined;
      if (value.byteLength > MAX_MULTIMODAL_RESPONSE_BYTES - bytesRead) return undefined;
      bytesRead += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function responseContentLengthExceedsLimit(response: Response): boolean {
  const contentLength = response.headers.get('content-length');
  if (contentLength === null || !/^(?:0|[1-9][0-9]*)$/.test(contentLength)) return false;
  const bytes = Number(contentLength);
  return !Number.isSafeInteger(bytes) || bytes > MAX_MULTIMODAL_RESPONSE_BYTES;
}

/**
 * Converts model output to presentation-neutral plain text. Control and
 * bidirectional override characters are rejected instead of being passed to a
 * future UI or tool loop; an API-key reflection is rejected outright.
 */
function sanitizeProviderAnalysisText(value: unknown, apiKey: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  const normalizedApiKey = apiKey.normalize('NFC');
  if (
    text.length === 0 ||
    TEXT_ENCODER.encode(text).byteLength > MAX_MULTIMODAL_ANALYSIS_TEXT_BYTES ||
    UNSAFE_ANALYSIS_CHARACTERS.test(text) ||
    text.includes(normalizedApiKey)
  )
    return undefined;
  return text;
}

function isDirectProviderEndpoint(url: URL): boolean {
  return (
    (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function isMimeTypeForModality(mimeType: string, modality: ObservationModality): boolean {
  if (!SIMPLE_MIME_TYPE.test(mimeType)) return false;
  if (modality === 'image') return mimeType.startsWith('image/');
  if (modality === 'audio') return mimeType.startsWith('audio/');
  if (modality === 'video') return mimeType.startsWith('video/');
  return mimeType === 'text/plain' || mimeType === 'text/markdown';
}

function isObservationModality(value: unknown): value is ObservationModality {
  return typeof value === 'string' && OBSERVATION_MODALITIES.includes(value as ObservationModality);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value) && !value.includes('://');
}

function isAbortSignalOrUndefined(value: unknown): value is AbortSignal | undefined {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function'
  );
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => undefined;
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  return () => signal.removeEventListener('abort', abort);
}

function toBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += BASE64_ALPHABET[first >>> 2];
    output += BASE64_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >>> 4)];
    output +=
      second === undefined ? '=' : BASE64_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)];
    output += third === undefined ? '=' : BASE64_ALPHABET[third & 0x3f];
  }
  return output;
}

function failure(code: Extract<MultimodalTransportResult, { readonly ok: false }>['code']) {
  return { ok: false, code } as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function hasRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

const REQUEST_KEYS = [
  'connection',
  'projectId',
  'runId',
  'range',
  'prompt',
  'evidence',
  'mediaCapability',
] as const;
const CONNECTION_KEYS = ['provider', 'baseUrl', 'modelId', 'apiKey'] as const;
const RANGE_KEYS = ['domain', 'startUs', 'endUs'] as const;
const EVIDENCE_KEYS = ['evidenceId', 'modality', 'mimeType', 'data'] as const;
const MEDIA_CAPABILITY_KEYS = ['modelId', 'modalities'] as const;
