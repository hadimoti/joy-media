/**
 * OpenRouter Creative Brief Adapter - WP-37 S4-F10-A
 *
 * Minimal OpenRouter adapter package with injected transport.
 * Uses injected SecretResolver and HttpPostTransport for HTTP requests.
 * Does NOT resolve environment variables, inspect secret values, or wire production runtime.
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
 * Uses injected SecretResolver and HttpPostTransport to make HTTP requests.
 * Does NOT resolve environment variables or inspect secret values.
 */
class OpenRouterCreativeAdapter implements AsyncCreativeModelAdapter {
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
    input: ModelAdapterInputV1,
    options: AsyncAdapterOptions,
  ): Promise<AsyncOutcome<ModelAdapterOutputV1>> {
    const startTime = this.#clock.now();

    // Emit start audit event if sink is provided (redacted, no sensitive data)
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

    // Build the request payload using the existing codec
    const requestOutcome = buildOpenRouterRequest(input, {
      modelId: this.#options.modelId,
    });

    // If request building fails, return invalid-output
    if (requestOutcome.category !== 'ready') {
      const durationMs = this.#clock.now() - startTime;
      if (options.auditSink !== undefined) {
        options.auditSink.emit({
          correlationId: options.correlationId,
          adapterName: this.adapterName,
          eventType: 'error',
          status: 'invalid-output',
          durationMs,
          errorCode: requestOutcome.errorCode,
        });
      }
      return {
        category: requestOutcome.category,
        errorCode: requestOutcome.errorCode,
        message: requestOutcome.message,
        retryable: requestOutcome.retryable,
        durationMs,
      };
    }

    try {
      // Call the injected transport once
      const response = await this.#options.transport.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${secret}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestOutcome.result),
        },
      );

      const durationMs = this.#clock.now() - startTime;

      // Handle non-2xx responses as provider-failed
      if (!response.ok) {
        if (options.auditSink !== undefined) {
          options.auditSink.emit({
            correlationId: options.correlationId,
            adapterName: this.adapterName,
            eventType: 'error',
            status: 'provider-failed',
            durationMs,
            errorCode: 'OPENROUTER_PROVIDER_ERROR',
          });
        }
        return {
          category: 'provider-failed',
          errorCode: 'OPENROUTER_PROVIDER_ERROR',
          message: 'OpenRouter provider returned a non-2xx status',
          retryable: true,
          durationMs,
        };
      }

      // Parse and decode the response using the existing decoder
      const responseBody = await response.json();
      const decodeOutcome = decodeOpenRouterResponse(responseBody);

      // Handle decode failures
      if (decodeOutcome.category !== 'ready') {
        if (options.auditSink !== undefined) {
          options.auditSink.emit({
            correlationId: options.correlationId,
            adapterName: this.adapterName,
            eventType: 'error',
            status: decodeOutcome.category,
            durationMs,
            errorCode: decodeOutcome.errorCode,
          });
        }
        return {
          category: decodeOutcome.category,
          errorCode: decodeOutcome.errorCode,
          message: decodeOutcome.message,
          retryable: decodeOutcome.retryable,
          durationMs,
        };
      }

      // Success: emit end audit event with redacted data
      if (options.auditSink !== undefined) {
        options.auditSink.emit({
          correlationId: options.correlationId,
          adapterName: this.adapterName,
          eventType: 'end',
          status: 'ready',
          durationMs,
        });
      }

      return {
        category: 'ready',
        result: decodeOutcome.result as ModelAdapterOutputV1,
        retryable: false,
        durationMs,
      };
    } catch (error) {
      // Map transport exceptions to provider-failed with redacted data
      const durationMs = this.#clock.now() - startTime;
      if (options.auditSink !== undefined) {
        options.auditSink.emit({
          correlationId: options.correlationId,
          adapterName: this.adapterName,
          eventType: 'error',
          status: 'provider-failed',
          durationMs,
          errorCode: 'OPENROUTER_PROVIDER_ERROR',
        });
      }
      return {
        category: 'provider-failed',
        errorCode: 'OPENROUTER_PROVIDER_ERROR',
        message: 'OpenRouter transport failed',
        retryable: true,
        durationMs,
      };
    }
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
function createOpenRouterCreativeAdapter(
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
  OpenRouterRequest,
  OpenRouterRequestConfig,
  OpenRouterRequestOutcome,
  OpenRouterResponse,
  OpenRouterDecoderOutcome,
};

export {
  OpenRouterCreativeAdapter,
  createOpenRouterCreativeAdapter,
  decodeOpenRouterResponse,
  buildOpenRouterRequest,
  OpenRouterCodec,
};

// ============================================================================
// OpenRouter Request Codec - WP-37 S4-F10-C
// ============================================================================

/**
 * Maximum allowed prompt size in characters (not bytes).
 * This is a safety limit to prevent excessively large prompts.
 */
const MAX_PROMPT_CHARS = 32000;

/**
 * Maximum output tokens for Creative Brief responses.
 * Hard cap of 2048 tokens for the initial free-only rollout.
 * Cannot be increased through the current public builder API.
 */
const MAX_OUTPUT_TOKENS = 2048;

/**
 * Forbidden patterns that should never appear in the model payload.
 * These are checked against the serialized prompt string.
 */
const FORBIDDEN_PATTERNS = [
  /sk-[a-zA-Z0-9]/,           // API keys
  /https?:\/\//,             // URLs
  /\/etc\/|\/home\/|\/root\//, // File paths
  /password|secret|api[_-]?key/i, // Secret-related terms
  /bearer[\s:]*/i,           // Bearer tokens
  /authorization/i,          // Authorization headers
] as const;

/**
 * Fixed system instruction for JOY Media Creative Brief generation.
 * This is a concise, stable instruction that guides the model.
 */
const CREATIVE_BRIEF_SYSTEM_INSTRUCTION = `You are JOY Media Creative Brief assistant. Your task is to analyze the provided video project data and user request, then produce a structured JSON response containing creative recommendations, goals, and analysis.

IMPORTANT RULES:
- Respond ONLY with a valid JSON object matching the ModelAdapterOutputV1 schema
- Never include explanations, apologies, or other text before or after the JSON
- Never use markdown formatting or code blocks
- Preserve all Persian/RTL text exactly as provided
- Be concise and specific in your recommendations
- Focus on actionable creative improvements

RESPONSE SCHEMA (strict):
{
  "interpretedGoal": {
    "userIntent": string,
    "inferredGoal": string,
    "resolvedGoal": string,
    "confidence": "low" | "medium" | "high"
  },
  "distinction": {
    "facts": [
      {
        "id": string,
        "statement": string,
        "source": "s1" | "s2" | "snapshot",
        "evidence": array of evidence references
      }
    ],
    "inferences": [
      {
        "id": string,
        "statement": string,
        "confidence": "low" | "medium" | "high",
        "rationale": string,
        "evidence": array of creative evidence references
      }
    ]
  },
  "assumptions": array of assumption objects,
  "recommendations": array of recommendation objects,
  "blockedBy": array of blocker objects,
  "requiresHumanDecision": array of decision objects
}`;

/**
 * OpenAI-compatible chat completions request payload.
 */
interface OpenRouterRequest {
  readonly model: string;
  readonly messages: readonly {
    readonly role: 'system' | 'user';
    readonly content: string;
  }[];
  readonly response_format?: { readonly type: 'json_object' };
  readonly temperature?: number;
  readonly max_tokens?: number;
}

/**
 * Outcome type for request building.
 * Uses the same categories from the async adapter contract for consistency.
 */
type OpenRouterRequestOutcome =
  | { category: 'ready'; result: OpenRouterRequest }
  | { category: 'invalid-output'; errorCode: string; message: string; retryable: boolean };

/**
 * Check if a string contains forbidden patterns.
 * Returns true if any forbidden pattern is found.
 */
function containsForbiddenData(content: string): boolean {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(content)) {
      return true;
    }
  }
  return false;
}

/**
 * Serialize the user message content from ModelAdapterInputV1.
 * Extracts only the semantic data, intelligence, and request - no metadata.
 */
function serializeUserMessage(input: ModelAdapterInputV1): string {
  const lines: string[] = [];

  // Project overview
  lines.push(`Project Overview:`);
  lines.push(`- Project ID: ${input.snapshot.projectId}`);
  lines.push(`- Revision: ${input.snapshot.revisionId}`);
  lines.push(`- Duration: ${input.snapshot.composition.durationUs} microseconds`);
  lines.push(`- Aspect Ratio: ${input.snapshot.composition.aspectRatio}`);
  lines.push(`- Frame Rate: ${input.snapshot.composition.frameRate.num}/${input.snapshot.composition.frameRate.den} fps`);
  lines.push(`- Resolution: ${input.snapshot.composition.width}x${input.snapshot.composition.height}`);

  // Brand readiness summary
  lines.push(`\nBrand Readiness:`);
  lines.push(`- Has Brand Kit: ${input.brandReadiness.hasBrandKit}`);
  lines.push(`- Colors Available: ${input.brandReadiness.colorsAvailable}`);
  lines.push(`- Fonts Available: ${input.brandReadiness.fontsAvailable}`);
  lines.push(`- Logo Available: ${input.brandReadiness.logoAvailable}`);

  // Scenes summary
  lines.push(`\nScenes (${input.snapshot.scenes.length}):`);
  for (const scene of input.snapshot.scenes) {
    lines.push(`- Scene ${scene.id}: ${scene.purpose} (${scene.startUs}-${scene.endUs}us)`);
    lines.push(`  Visual Coverage: ${scene.visualCoverage}`);
  }

  // Assets summary
  lines.push(`\nAssets (${input.snapshot.assets.length}):`);
  for (const asset of input.snapshot.assets) {
    lines.push(`- Asset ${asset.id}: ${asset.kind}, name: ${asset.name}`);
  }

  // Scene coverages
  lines.push(`\nScene Coverages (${input.sceneCoverages.length}):`);
  for (const coverage of input.sceneCoverages) {
    lines.push(`- Scene ${coverage.sceneId}: visualDensity=${coverage.visualDensity}, visualElements=${coverage.visualElementCount}`);
  }

  // Project readiness
  lines.push(`\nProject Readiness:`);
  lines.push(`- Readiness Level: ${input.projectReadiness.readinessLevel}`);
  lines.push(`- Duration Aligned: ${input.projectReadiness.durationAligned}`);
  lines.push(`- Aspect Ratio Aligned: ${input.projectReadiness.aspectRatioAligned}`);
  lines.push(`- Blockers: ${input.projectReadiness.blockers.length}`);

  // Intelligence rules
  lines.push(`\nIntelligence Rules (${input.rules.length}):`);
  for (const rule of input.rules) {
    lines.push(`- ${rule.ruleId}: ${rule.category} (severity: ${rule.severity})`);
  }

  // User request
  lines.push(`\nUser Request:`);
  lines.push(`- Request: ${input.request.request}`);
  lines.push(`- Scope: ${input.request.scope}`);
  if (input.request.brief) {
    lines.push(`- Brief: ${input.request.brief}`);
  }
  if (input.request.destination) {
    lines.push(`- Destination: ${input.request.destination}`);
  }
  if (input.request.durationTargetUs) {
    lines.push(`- Duration Target: ${input.request.durationTargetUs} microseconds`);
  }

  return lines.join('\n');
}

/**
 * Build an OpenRouter chat completions request from ModelAdapterInputV1.
 *
 * This is a pure function that:
 * - Accepts typed ModelAdapterInputV1 plus adapter configuration
 * - Produces an OpenAI-compatible chat-completions request payload
 * - Uses a fixed system instruction for JOY Media Creative Brief
 * - Includes semantic snapshot, intelligence, and user request from input
 * - Requires JSON-only ModelAdapterOutputV1 output
 * - Preserves Persian/RTL text exactly
 * - Is byte-stable for identical input/configuration
 * - Does not mutate its input
 * - Fails closed when input contains forbidden data or exceeds prompt size
 * - Never includes secrets, paths, URLs, or audit metadata in payload
 *
 * @param input - The validated model adapter input
 * @param config - Adapter configuration with model ID
 * @returns A typed outcome with either the request or an error
 *
 * @example
 * ```ts
 * const input = createTestInput();
 * const request = buildOpenRouterRequest(input, { modelId: 'openrouter/mistral-large' });
 * if (request.category === 'ready') {
 *   // request.result is a valid OpenRouterRequest
 * }
 * ```
 */
function buildOpenRouterRequest(
  input: ModelAdapterInputV1,
  config: { readonly modelId: string },
): OpenRouterRequestOutcome {
  // Serialize the user message
  const userMessage = serializeUserMessage(input);

  // Check for forbidden data in the serialized message
  if (containsForbiddenData(userMessage)) {
    return {
      category: 'invalid-output',
      errorCode: 'OPENROUTER_FORBIDDEN_DATA',
      message: 'Input contains forbidden patterns (secrets, paths, URLs, or sensitive data)',
      retryable: false,
    };
  }

  // Check prompt size limit
  const totalContent = CREATIVE_BRIEF_SYSTEM_INSTRUCTION + '\n\n' + userMessage;
  if (totalContent.length > MAX_PROMPT_CHARS) {
    return {
      category: 'invalid-output',
      errorCode: 'OPENROUTER_PROMPT_TOO_LARGE',
      message: `Prompt exceeds maximum character limit (${MAX_PROMPT_CHARS})`,
      retryable: false,
    };
  }

  // Build the request payload
  const request: OpenRouterRequest = {
    model: config.modelId,
    messages: [
      {
        role: 'system',
        content: CREATIVE_BRIEF_SYSTEM_INSTRUCTION,
      },
      {
        role: 'user',
        content: userMessage,
      },
    ],
    response_format: {
      type: 'json_object',
    },
    // Conservative settings for deterministic output
    temperature: 0.0,
    max_tokens: MAX_OUTPUT_TOKENS,
  };

  return {
    category: 'ready',
    result: request,
  };
}

/**
 * Type for the request builder configuration.
 */
interface OpenRouterRequestConfig {
  readonly modelId: string;
}

/**
 * Codec that combines both encoding and decoding capabilities.
 * This is a convenience export for consumers that want both operations.
 */
const OpenRouterCodec = {
  build: buildOpenRouterRequest,
  decode: decodeOpenRouterResponse,
} as const;

// ============================================================================
// OpenRouter Response Decoder - WP-37 S4-F10-B
// ============================================================================

import { isModelAdapterOutputV1 } from '@joy-media/agent-tools';

/**
 * OpenAI-compatible/OpenRouter response envelope.
 * This is the structure returned by OpenRouter's chat completions API.
 */
interface OpenRouterResponse {
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
type OpenRouterDecoderOutcome =
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
function decodeOpenRouterResponse(
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
