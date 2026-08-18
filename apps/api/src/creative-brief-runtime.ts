/**
 * Creative Brief Runtime - WP-37 S4-F8
 *
 * Defines the server-side injectable runtime boundary for Creative Brief generation.
 * The default implementation returns unavailable; real implementations will
 * integrate with AsyncCreativeModelAdapter from @joy-media/agent-tools.
 */

import type {
  CreativeBriefServerRequest,
} from './creative-brief-request-validation.js';
import type { AsyncCreativeBriefOutcome } from '@joy-media/agent-tools';
import type { AsyncOutcomeCategory } from '@joy-media/agent-tools';

// ============================================================================
// Types
// ============================================================================

/**
 * Safe execution metadata for creative brief runtime calls.
 * Contains only non-sensitive information needed for execution.
 */
export interface CreativeBriefRuntimeContext {
  /**
   * Correlation ID for tracing across services.
   * MUST be included in logs and audit events.
   */
  readonly correlationId: string;

  /**
   * AbortSignal for cooperative cancellation.
   * Optional - runtime may provide its own default.
   */
  readonly signal?: AbortSignal | undefined;

  /**
   * Maximum time in ms for the entire operation.
   */
  readonly timeoutMs?: number | undefined;

  /**
   * Maximum spend limit in USD cents for this request.
   */
  readonly spendLimitUsdCents?: number | undefined;
}

/**
 * Creative Brief Runtime interface.
 * Accepts a validated server request plus safe execution metadata and returns
 * a typed async outcome containing either a CreativeBriefV1 or a failure category.
 */
export interface CreativeBriefRuntime {
  /**
   * Execute creative brief generation for a validated request.
   *
   * Called only after all gates pass:
   * - Authentication verified
   * - Owner confirmed
   * - Project opt-in checked
   * - Request envelope validated
   *
   * @param request - Already validated server request envelope
   * @param context - Safe execution metadata (correlation, cancellation, timeout, spend)
   * @returns Promise resolving to typed outcome
   */
  execute(
    request: CreativeBriefServerRequest,
    context: CreativeBriefRuntimeContext,
  ): Promise<AsyncCreativeBriefOutcome>;
}

// ============================================================================
// Unavailable Runtime Implementation
// ============================================================================

/**
 * Default unavailable creative brief runtime.
 * Returns typed 'unavailable' outcome for all requests.
 *
 * This is the production default to ensure no fake success or real model calls
 * are made unless explicitly configured.
 */
export class UnavailableCreativeBriefRuntime implements CreativeBriefRuntime {
  readonly #name = 'UnavailableCreativeBriefRuntime';

  /**
   * Always returns unavailable outcome.
   * No fake success, no model call, no network request, no credential access.
   */
  async execute(
    _request: CreativeBriefServerRequest,
    context: CreativeBriefRuntimeContext,
  ): Promise<AsyncCreativeBriefOutcome> {
    return {
      category: 'unavailable',
      message: 'Creative brief runtime is not configured',
      errorCode: 'RUNTIME_UNAVAILABLE',
      retryable: false,
      durationMs: 0,
    };
  }
}

// ============================================================================
// Default Instance
// ============================================================================

/**
 * Default singleton instance of unavailable runtime.
 * Used as the production default when no runtime is injected.
 */
export const DEFAULT_CREATIVE_BRIEF_RUNTIME: CreativeBriefRuntime =
  new UnavailableCreativeBriefRuntime();
