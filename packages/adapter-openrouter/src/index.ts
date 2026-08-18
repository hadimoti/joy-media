/**
 * OpenRouter Creative Brief Adapter - WP-37 S4-F10-A
 *
 * Minimal OpenRouter adapter package with fail-closed core.
 * Does NOT make any HTTP requests, construct Authorization headers,
 * resolve environment variables, inspect secret values, or wire production runtime.
 */

import type {
  AsyncCreativeModelAdapter,
  AsyncOutcome,
  AsyncOutcomeCategory,
  AsyncAdapterOptions,
  ModelAdapterInputV1,
  ModelAdapterOutputV1,
  AuditEventSink,
} from '@joy-media/agent-tools';

// ============================================================================
// Production Interfaces
// ============================================================================

/**
 * Opaque secret resolver.
 * Accepts a reference name and returns the resolved secret value (opaque to the adapter).
 * The adapter never inspects or validates the actual secret value.
 */
interface SecretResolver {
  /**
   * Resolve a secret by its reference name.
   * @param ref - Opaque reference name (e.g., 'openrouter-api-key')
   * @returns The resolved secret value, or undefined if not found
   */
  resolve(ref: string): string | undefined;
}

/**
 * Injected HTTP POST transport.
 * The adapter never calls this in the current implementation (fail-closed).
 * This is a placeholder for future HTTP request functionality.
 */
interface HttpPostTransport {
  /**
   * Perform an HTTP POST request.
   * @param url - Target URL
   * @param options - Fetch options
   * @returns Promise resolving to the response
   */
  post(url: string, options: RequestInit): Promise<Response>;
}

/**
 * Optional clock interface for testing.
 * Allows injection of time for deterministic testing.
 */
interface Clock {
  /** Return current timestamp in milliseconds. */
  now(): number;
}

// ============================================================================
// Adapter Options
// ============================================================================

/**
 * Configuration options for the OpenRouter creative adapter.
 */
interface OpenRouterAdapterOptions {
  /** OpenRouter model ID to use. */
  readonly modelId: string;
  /** Request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Maximum spend limit in USD cents. */
  readonly spendLimitUsdCents: number;
  /** Opaque name reference to the API key secret. */
  readonly secretRef: string;
  /** Optional secret resolver for resolving the opaque reference. */
  readonly secretResolver?: SecretResolver;
  /** Optional HTTP POST transport. Adapter never calls it currently. */
  readonly transport?: HttpPostTransport;
  /** Optional clock for testing. */
  readonly clock?: Clock;
}

// ============================================================================
// Default/No-op Implementations
// ============================================================================

/** Default no-op secret resolver always returns undefined. */
class NoOpSecretResolver implements SecretResolver {
  resolve(_ref: string): string | undefined {
    return undefined;
  }
}

/** Default no-op clock uses Date.now(). */
class DefaultClock implements Clock {
  now(): number {
    return Date.now();
  }
}

// ============================================================================
// OpenRouter Creative Adapter
// ============================================================================

/**
 * OpenRouter Creative Brief Adapter.
 *
 * Fail-closed implementation that returns 'unavailable' when:
 * - Dependencies are absent (no secret resolver, no transport)
 * - The secret cannot be resolved (opaque reference not found)
 *
 * Does NOT make any HTTP requests, construct Authorization headers,
 * resolve environment variables, or inspect secret values.
 */
export class OpenRouterCreativeAdapter implements AsyncCreativeModelAdapter {
  readonly adapterName = 'openrouter-creative-v1' as const;
  readonly isTestOnly = false as const;

  readonly #options: OpenRouterAdapterOptions;
  readonly #secretResolver: SecretResolver;
  readonly #clock: Clock;

  constructor(options: OpenRouterAdapterOptions) {
    this.#options = options;
    this.#secretResolver = options.secretResolver ?? new NoOpSecretResolver();
    this.#clock = options.clock ?? new DefaultClock();
  }

  async createBrief(
    _input: ModelAdapterInputV1,
    options: AsyncAdapterOptions,
  ): Promise<AsyncOutcome<ModelAdapterOutputV1>> {
    const startTime = this.#clock.now();

    // Emit start audit event if sink is provided
    if (options.auditSink !== undefined) {
      options.auditSink.emit({
        correlationId: options.correlationId,
        adapterName: this.adapterName,
        eventType: 'start',
        status: 'unavailable',
      });
    }

    // Fail-closed: if secret cannot be resolved, return unavailable
    const secret = this.#secretResolver.resolve(this.#options.secretRef);
    if (secret === undefined) {
      const durationMs = this.#clock.now() - startTime;
      if (options.auditSink !== undefined) {
        options.auditSink.emit({
          correlationId: options.correlationId,
          adapterName: this.adapterName,
          eventType: 'error',
          status: 'unavailable',
          durationMs,
          errorCode: 'OPENROUTER_SECRET_NOT_RESOLVED',
        });
      }
      return {
        category: 'unavailable',
        errorCode: 'OPENROUTER_SECRET_NOT_RESOLVED',
        message: 'OpenRouter API key secret reference could not be resolved',
        retryable: false,
        durationMs,
      };
    }

    // Fail-closed: if transport is not provided, return unavailable
    // (Even though we don't call it, we require it for production readiness)
    if (this.#options.transport === undefined) {
      const durationMs = this.#clock.now() - startTime;
      if (options.auditSink !== undefined) {
        options.auditSink.emit({
          correlationId: options.correlationId,
          adapterName: this.adapterName,
          eventType: 'error',
          status: 'unavailable',
          durationMs,
          errorCode: 'OPENROUTER_TRANSPORT_NOT_CONFIGURED',
        });
      }
      return {
        category: 'unavailable',
        errorCode: 'OPENROUTER_TRANSPORT_NOT_CONFIGURED',
        message: 'OpenRouter HTTP transport is not configured',
        retryable: false,
        durationMs,
      };
    }

    // NOTE: The adapter is intentionally fail-closed and does NOT make any HTTP
    // requests in this implementation. Even with an injected transport, we return
    // unavailable to ensure no accidental network calls.
    //
    // This is a safety measure. Future implementations will use the transport
    // to make actual OpenRouter API calls, but only after explicit approval.

    const durationMs = this.#clock.now() - startTime;

    if (options.auditSink !== undefined) {
      options.auditSink.emit({
        correlationId: options.correlationId,
        adapterName: this.adapterName,
        eventType: 'error',
        status: 'unavailable',
        durationMs,
        errorCode: 'OPENROUTER_NOT_YET_ENABLED',
      });
    }

    return {
      category: 'unavailable',
      errorCode: 'OPENROUTER_NOT_YET_ENABLED',
      message: 'OpenRouter creative brief adapter is not yet enabled for HTTP requests',
      retryable: false,
      durationMs,
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Factory function to create an OpenRouter creative adapter.
 *
 * Returns a fail-closed adapter that returns 'unavailable' until all dependencies
 * are properly configured and the feature is explicitly enabled.
 *
 * @param options - Configuration options for the adapter
 * @returns An AsyncCreativeModelAdapter instance
 *
 * @example
 * ```ts
 * const adapter = createOpenRouterCreativeAdapter({
 *   modelId: 'openrouter/mistral-large',
 *   timeoutMs: 60000,
 *   spendLimitUsdCents: 500,
 *   secretRef: 'openrouter-api-key',
 *   secretResolver: mySecretResolver,
 *   transport: myHttpTransport,
 * });
 * ```
 */
export function createOpenRouterCreativeAdapter(
  options: OpenRouterAdapterOptions,
): AsyncCreativeModelAdapter {
  return new OpenRouterCreativeAdapter(options);
}

// ============================================================================
// Public Exports
// ============================================================================

export type {
  SecretResolver,
  HttpPostTransport,
  Clock,
  OpenRouterAdapterOptions,
};

// ============================================================================
// OpenRouter Response Decoder - WP-37 S4-F10-B
// ============================================================================

import { isModelAdapterOutputV1 } from '@joy-media/agent-tools';

/**
 * OpenAI-compatible/OpenRouter response envelope.
 * This is the structure returned by OpenRouter's chat completions API.
 */
export interface OpenRouterResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly role?: string;
      readonly content?: string;
    };
  }[] | undefined;
  readonly error?: {
    readonly message?: string;
    readonly type?: string;
    readonly code?: string;
  } | undefined;
}

/**
 * Decoded outcome from an OpenRouter response.
 * Uses the same AsyncOutcome categories from the async adapter contract.
 */
export type OpenRouterDecoderOutcome =
  | { category: 'ready'; result: unknown } // result is validated ModelAdapterOutputV1
  | { category: 'invalid-output'; errorCode: string; message: string; retryable: boolean }
  | { category: 'provider-failed'; errorCode: string; message: string; retryable: boolean };

/**
 * Safe JSON parsing with redaction of error details.
 * Returns the parsed object or undefined if parsing fails.
 * Never exposes raw content in errors.
 */
function safeJsonParse(content: string): unknown | undefined {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/**
 * Extract the first assistant message content from an OpenRouter response.
 * Returns the content string if it exists and is a string, otherwise undefined.
 */
function extractAssistantContent(response: OpenRouterResponse): string | undefined {
  const firstChoice = response.choices?.[0];
  const message = firstChoice?.message;
  const content = message?.content;

  if (typeof content === 'string' && content.length > 0) {
    return content;
  }

  return undefined;
}

/**
 * Check if the response indicates a provider error.
 * OpenRouter returns errors in the top-level 'error' field.
 */
function isProviderError(response: OpenRouterResponse): boolean {
  return response.error !== undefined &&
    (response.error.message !== undefined ||
     response.error.type !== undefined ||
     response.error.code !== undefined);
}

/**
 * Decode an OpenRouter response into a typed outcome.
 *
 * This is a pure function that:
 * - Extracts the first assistant message content only when it is a string
 * - Parses JSON safely
 * - Validates the parsed content as ModelAdapterOutputV1
 * - Returns typed outcomes: ready, invalid-output, or provider-failed
 * - Never includes raw response content, secrets, URLs, or provider body text in errors
 *
 * @param response - The OpenRouter response to decode
 * @returns A typed decoder outcome
 *
 * @example
 * ```ts
 * const response = {
 *   choices: [{ message: { role: 'assistant', content: '{"interpretedGoal": {...}}' } }]
 * } as OpenRouterResponse;
 * const result = decodeOpenRouterResponse(response);
 * if (result.category === 'ready') {
 *   // result.result is validated ModelAdapterOutputV1
 * }
 * ```
 */
export function decodeOpenRouterResponse(
  response: OpenRouterResponse,
): OpenRouterDecoderOutcome {
  // Check for provider error first
  if (isProviderError(response)) {
    return {
      category: 'provider-failed',
      errorCode: 'OPENROUTER_PROVIDER_ERROR',
      message: 'OpenRouter provider returned an error',
      retryable: true,
    };
  }

  // Extract assistant content
  const content = extractAssistantContent(response);

  // No content or empty response
  if (content === undefined) {
    return {
      category: 'invalid-output',
      errorCode: 'OPENROUTER_EMPTY_RESPONSE',
      message: 'No assistant message content found in response',
      retryable: false,
    };
  }

  // Parse JSON safely
  const parsed = safeJsonParse(content);

  if (parsed === undefined) {
    return {
      category: 'invalid-output',
      errorCode: 'OPENROUTER_INVALID_JSON',
      message: 'Assistant message content is not valid JSON',
      retryable: false,
    };
  }

  // Validate as ModelAdapterOutputV1
  if (!isModelAdapterOutputV1(parsed)) {
    return {
      category: 'invalid-output',
      errorCode: 'OPENROUTER_INVALID_SCHEMA',
      message: 'Parsed content does not match ModelAdapterOutputV1 schema',
      retryable: false,
    };
  }

  // Success: valid ModelAdapterOutputV1
  return {
    category: 'ready',
    result: parsed,
  };
}
