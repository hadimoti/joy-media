/**
 * Direct-provider adapter for OpenAI-compatible chat completion endpoints (JOY Media desktop
 * migration, wave 3). Host-agnostic and dependency-injected — no `fetch`, `node:*`, or
 * `electron` import — so it runs the same way from the Electron main process (BYOK host-side
 * profile testing, `apps/desktop`) or, if a future wave decides to, from a browser Worker.
 *
 * This module only ever performs a capability *probe*: a tiny, product-owned synthetic
 * request (never user content, never real media), used to confirm a profile's credentials and
 * base URL actually work before it is trusted. It deliberately never returns the provider's
 * response body, the endpoint, or the credential — only a redacted, typed report. Compare
 * `apps/editor-web/src/joy-agent/protocol.ts`'s `JoyAgentMediaCapabilityReport`, which the
 * same "redacted capability report" shape already established for the in-browser BYOK path.
 */

/** Loosely mirrors `apps/editor-web/src/joy-agent/protocol.ts`'s `JoyAgentErrorCode` for the
 * subset relevant to a connectivity probe, without importing from an app into this package. */
export type DirectProviderErrorCode =
  'AUTH_FAILED' | 'NETWORK_ERROR' | 'TIMEOUT' | 'RESPONSE_TOO_LARGE' | 'PROVIDER_INCOMPATIBLE';

export interface DirectProviderProbeRequest {
  readonly baseUrl: string;
  /** Volatile only: read from OS-protected storage for the duration of this one call. */
  readonly apiKey: string;
  readonly modelId: string;
}

export interface DirectProviderProbeReport {
  readonly ok: boolean;
  readonly modelId: string;
  readonly errorCode?: DirectProviderErrorCode;
  /** Never the provider response body, endpoint, or credential. */
  readonly message?: string;
}

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<FetchResponseLike>;

/** Never real user content: a fixed, tiny probe message costs at most a few tokens. */
const PROBE_MESSAGE = 'ping';
const MAX_RESPONSE_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 10_000;

export async function probeOpenAiCompatibleProvider(
  request: DirectProviderProbeRequest,
  fetchImpl: FetchLike,
  options: { readonly timeoutMs?: number } = {},
): Promise<DirectProviderProbeReport> {
  const url = resolveChatCompletionsUrl(request.baseUrl);
  if (url === undefined) {
    return {
      ok: false,
      modelId: request.modelId,
      errorCode: 'PROVIDER_INCOMPATIBLE',
      message: 'baseUrl could not be resolved to a chat completions endpoint',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify({
        model: request.modelId,
        messages: [{ role: 'user', content: PROBE_MESSAGE }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        modelId: request.modelId,
        errorCode: 'AUTH_FAILED',
        message: `provider rejected credentials (HTTP ${response.status})`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        modelId: request.modelId,
        errorCode: 'PROVIDER_INCOMPATIBLE',
        message: `provider returned HTTP ${response.status}`,
      };
    }
    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      return {
        ok: false,
        modelId: request.modelId,
        errorCode: 'RESPONSE_TOO_LARGE',
        message: `response exceeded ${MAX_RESPONSE_BYTES} bytes`,
      };
    }
    return { ok: true, modelId: request.modelId };
  } catch (error) {
    // A real AbortSignal-triggered abort throws a DOMException in Node/Electron, which does
    // not extend Error - check `.name` structurally rather than `instanceof Error` first.
    if (isAbortError(error)) {
      return {
        ok: false,
        modelId: request.modelId,
        errorCode: 'TIMEOUT',
        message: 'provider did not respond in time',
      };
    }
    return {
      ok: false,
      modelId: request.modelId,
      errorCode: 'NETWORK_ERROR',
      message: error instanceof Error ? error.message : 'unknown network error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function resolveChatCompletionsUrl(baseUrl: string): string | undefined {
  try {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    return new URL('chat/completions', base).toString();
  } catch {
    return undefined;
  }
}
