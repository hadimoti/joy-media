/**
 * Async Model Adapter Interface - WP-37 S4-F6
 *
 * Provides the asynchronous server-side boundary for real KiloCode/OpenRouter
 * Creative Brief runtime. This is the production-facing async contract.
 *
 * The sync CreativeModelAdapter (in model-adapter.ts) remains test-only for S3.
 * These two interfaces are intentionally separate to prevent unsafe casting.
 */

import type { ModelAdapterInputV1, ModelAdapterOutputV1 } from './model-adapter.js';
import type {
  RecommendationKind,
  InferenceConfidence,
  RecommendationRisk,
} from './creative-brief.js';

// ==========================================================================
// Async Runtime Contract Types
// ==========================================================================

/**
 * Outcome categories for async adapter operations.
 * Used for typed error handling and audit logging.
 */
export type AsyncOutcomeCategory =
  | 'ready' // Model call succeeded and returned valid output
  | 'unavailable' // Provider is not configured or healthy
  | 'policy-denied' // Request denied by server policy (opt-in, ownership, auth)
  | 'invalid-output' // Model returned output that failed S3 validation
  | 'provider-failed' // Provider returned an error (rate limit, auth, internal)
  | 'timeout' // Request exceeded timeoutMs
  | 'cancelled'; // Request was aborted via AbortSignal

/**
 * Detailed outcome with category and optional metadata.
 */
export interface AsyncOutcome<T = ModelAdapterOutputV1> {
  readonly category: AsyncOutcomeCategory;
  readonly result?: T; // Only present when category === 'ready'
  readonly errorCode?: string; // Provider-specific error code
  readonly message?: string; // Human-readable message (no secrets)
  readonly retryable: boolean; // Whether the caller may retry
  readonly durationMs: number; // Time spent in ms
}

/**
 * Audit event sink that receives redacted events.
 * No sensitive data (prompts, model outputs, credentials) may be included.
 */
export interface AuditEventSink {
  emit(event: {
    readonly correlationId: string;
    readonly adapterName: string;
    readonly eventType: 'start' | 'end' | 'error';
    readonly status: AsyncOutcomeCategory;
    readonly durationMs?: number;
    readonly inputTokenCount?: number;
    readonly outputTokenCount?: number;
    readonly errorCode?: string;
  }): void;
}

/**
 * Runtime options for async adapter calls.
 * Contains only safe runtime metadata - no credentials, URLs, or raw project data.
 */
export interface AsyncAdapterOptions {
  /**
   * AbortSignal for cooperative cancellation.
   * Adapter MUST check this signal and reject with 'cancelled' outcome if aborted.
   */
  readonly signal?: AbortSignal;

  /**
   * Maximum time in ms before the call times out.
   * Adapter MUST reject with 'timeout' outcome if exceeded.
   */
  readonly timeoutMs?: number;

  /**
   * Correlation ID for tracing and audit purposes.
   * MUST be included in all logs and error responses (redacted).
   */
  readonly correlationId: string;

  /**
   * Maximum spend in USD cents for this request.
   * Adapter MUST reject with spend-limit related outcome if exceeded.
   * Default: derived from server policy.
   */
  readonly spendLimitUsdCents?: number;

  /**
   * Redacted audit event sink.
   * Adapter MUST write audit events here (with redacted input/output).
   */
  readonly auditSink?: AuditEventSink;
}

/**
 * Asynchronous model adapter interface for server-side runtime.
 * Real provider adapters implement this interface.
 *
 * Key requirements:
 * - Asynchronous: returns Promise for real network I/O
 * - Accepts only ModelAdapterInputV1 (bounded, validated data)
 * - Returns Promise<ModelAdapterOutputV1> for success
 * - Uses AsyncOutcome for typed failure categories
 * - No network, no persistence, no real model calls in test-only mode
 * - MUST respect AsyncAdapterOptions (cancellation, timeout, audit)
 */
export interface AsyncCreativeModelAdapter {
  /**
   * Unique name for this adapter (e.g., 'kilocode-creative-v1', 'openrouter-creative-v1')
   */
  readonly adapterName: string;

  /**
   * Whether this adapter is for test purposes only.
   * Real adapters MUST have isTestOnly: false.
   * Test-only adapters MUST NOT be bundled in production.
   */
  readonly isTestOnly: boolean;

  /**
   * Create a creative brief from the input asynchronously.
   * May perform network I/O, must handle cancellation and timeout.
   *
   * @param input - Validated ModelAdapterInputV1 (bounded, safe data only)
   * @param options - Runtime options including cancellation, timeout, correlation
   * @returns Promise resolving to AsyncOutcome<ModelAdapterOutputV1>
   *
   * Implementation notes:
   * - MUST check options.signal for abort and return { category: 'cancelled', ... }
   * - MUST respect options.timeoutMs and return { category: 'timeout', ... }
   * - MUST write to options.auditSink if provided (redacted events only)
   * - MUST respect options.spendLimitUsdCents
   * - MUST NOT include secrets, prompts, or raw outputs in any returned data
   */
  createBrief(
    input: ModelAdapterInputV1,
    options: AsyncAdapterOptions,
  ): Promise<AsyncOutcome<ModelAdapterOutputV1>>;
}

// ==========================================================================
// Test-Only Deterministic Async Fake Adapter
// ==========================================================================

/**
 * Mode for the async fake adapter to produce different outcomes.
 * These modes are deterministic and produce stable outputs for the same inputs.
 */
export type FakeAsyncAdapterMode =
  | 'valid' // Well-formed, deterministic valid output
  | 'unavailable' // Provider not configured/healthy
  | 'policy-denied' // Policy rejection (not opted-in, not owner)
  | 'invalid-output' // Output that would fail S3 validation
  | 'provider-failed' // Provider returned an error
  | 'timeout' // Simulate timeout (when timeoutMs is small)
  | 'cancelled'; // Simulate cancellation (when signal is aborted)

/**
 * Configuration for creating a test-only async fake adapter.
 * This is NOT exported from the package root to prevent production use.
 */
export interface FakeAsyncAdapterConfig {
  /** The mode this adapter should operate in */
  readonly mode: FakeAsyncAdapterMode;
  /** Seed for deterministic ID generation */
  readonly seed?: number;
  /** Fixed processing time override (ms) */
  readonly processingTimeMs?: number;
  /** Fixed delay before responding (ms) - for timeout/cancellation testing */
  readonly responseDelayMs?: number;
}

/**
 * Default configuration for valid mode in async fake adapter.
 */
const DEFAULT_FAKE_ASYNC_CONFIG: FakeAsyncAdapterConfig = {
  mode: 'valid',
  seed: 42,
  processingTimeMs: 10,
  responseDelayMs: 0,
};

/**
 * Deterministic ID generator using seed.
 * Produces stable IDs for the same seed and index.
 */
function generateDeterministicIdAsync(seed: number, prefix: string, index: number): string {
  const combined = `${seed}-${prefix}-${index}`;
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    hash = (hash << 5) - hash + combined.charCodeAt(i);
    hash |= 0;
  }
  const hashStr = Math.abs(hash).toString(16).padStart(8, '0').substring(0, 8);
  return `${prefix}-${hashStr}-${index}`;
}

/**
 * Map evidence refs to CreativeEvidenceRefV1.
 * This is a simplified version for the async fake adapter.
 */
import type { EvidenceRefV1 } from '@joy-media/project-schema';
import type { CreativeEvidenceRefV1 } from './creative-brief.js';

function toCreativeEvidenceAsync(
  refs: readonly EvidenceRefV1[],
  detail?: string,
): readonly CreativeEvidenceRefV1[] {
  return refs.map((ref) => ({
    ...ref,
    detail,
    s3Detail: detail,
  })) as readonly CreativeEvidenceRefV1[];
}

/**
 * Extract evidence references from S1/S2 data.
 * Only references valid, canonical evidence from the snapshot.
 */
import type {
  SemanticProjectSnapshotV1,
  SceneCoverageV1,
  IntelligenceRuleV1,
} from '@joy-media/project-schema';

function extractValidEvidenceAsync(
  snapshot: SemanticProjectSnapshotV1,
  _sceneCoverages: readonly SceneCoverageV1[],
  _rules: readonly IntelligenceRuleV1[],
  count: number = 3,
): readonly EvidenceRefV1[] {
  const evidence: EvidenceRefV1[] = [];

  if (evidence.length < count && snapshot.composition) {
    evidence.push({
      id: snapshot.composition.aspectRatio,
      kind: 'composition',
    });
  }

  for (const scene of snapshot.scenes) {
    if (evidence.length >= count) break;
    evidence.push({
      id: scene.id,
      kind: 'marker',
      startUs: scene.startUs,
      endUs: scene.endUs,
    });
  }

  for (const asset of snapshot.assets) {
    if (evidence.length >= count) break;
    evidence.push({
      id: asset.id,
      kind: 'asset',
    });
  }

  return evidence;
}

/**
 * Base async fake adapter that can be configured for different modes.
 * All implementations are asynchronous, deterministic, and test-only.
 * This class is NOT exported from the package root.
 */
class BaseFakeAsyncModelAdapter implements AsyncCreativeModelAdapter {
  readonly adapterName: string;
  readonly isTestOnly = true;
  private readonly config: FakeAsyncAdapterConfig;

  constructor(name: string, config: FakeAsyncAdapterConfig) {
    this.adapterName = name;
    this.config = config;
  }

  async createBrief(
    input: ModelAdapterInputV1,
    options: AsyncAdapterOptions,
  ): Promise<AsyncOutcome<ModelAdapterOutputV1>> {
    const startTime = Date.now();
    // Check for cancellation before doing any work
    if (options.signal?.aborted) {
      return {
        category: 'cancelled',
        message: 'Request was already aborted',
        retryable: false,
        durationMs: 0,
      };
    }

    // Check for immediate timeout
    const effectiveTimeout = options.timeoutMs ?? 30000;
    if (effectiveTimeout <= 0) {
      return {
        category: 'timeout',
        message: 'Immediate timeout',
        retryable: true,
        durationMs: 0,
      };
    }

    // Emit start audit event if sink provided
    options.auditSink?.emit({
      correlationId: options.correlationId,
      adapterName: this.adapterName,
      eventType: 'start',
      status: this.config.mode as AsyncOutcomeCategory,
    });

    // Simulate delay for timeout/cancellation testing
    if (this.config.responseDelayMs && this.config.responseDelayMs > 0) {
      try {
        // Check signal during delay
        await new Promise((resolve, reject) => {
          const checkInterval = 50;
          const totalDelay = this.config.responseDelayMs!;
          let elapsed = 0;

          const interval = setInterval(() => {
            elapsed += checkInterval;
            if (elapsed >= totalDelay) {
              clearInterval(interval);
              resolve(undefined);
            }
            if (options.signal?.aborted) {
              clearInterval(interval);
              reject(new Error('aborted'));
            }
          }, checkInterval);

          // Also set a timeout in case the signal never aborts
          setTimeout(() => {
            clearInterval(interval);
            resolve(undefined);
          }, totalDelay);
        });
      } catch {
        // Aborted during delay
        const durationMs = Date.now() - startTime;
        options.auditSink?.emit({
          correlationId: options.correlationId,
          adapterName: this.adapterName,
          eventType: 'error',
          status: 'cancelled',
          durationMs,
          errorCode: 'ABORTED_DURING_DELAY',
        });
        return {
          category: 'cancelled',
          message: 'Request was aborted during processing',
          retryable: false,
          durationMs,
        };
      }
    }

    // Check cancellation again after delay
    if (options.signal?.aborted) {
      const durationMs = Date.now() - startTime;
      options.auditSink?.emit({
        correlationId: options.correlationId,
        adapterName: this.adapterName,
        eventType: 'error',
        status: 'cancelled',
        durationMs,
      });
      return {
        category: 'cancelled',
        message: 'Request was aborted before processing',
        retryable: false,
        durationMs,
      };
    }

    // Handle timeout mode
    if (this.config.mode === 'timeout') {
      const durationMs = Date.now() - startTime;
      options.auditSink?.emit({
        correlationId: options.correlationId,
        adapterName: this.adapterName,
        eventType: 'error',
        status: 'timeout',
        durationMs,
      });
      return {
        category: 'timeout',
        message: 'Simulated timeout',
        retryable: true,
        durationMs,
      };
    }

    // Generate output for valid mode
    let result: AsyncOutcome<ModelAdapterOutputV1>;

    switch (this.config.mode) {
      case 'valid':
        result = this.createValidAsyncBrief(input, startTime);
        break;
      case 'unavailable':
        result = {
          category: 'unavailable',
          message: 'Provider is not configured or healthy',
          errorCode: 'ADAPTER_NOT_CONFIGURED',
          retryable: true,
          durationMs: Date.now() - startTime,
        };
        break;
      case 'policy-denied':
        result = {
          category: 'policy-denied',
          message: 'Request denied by server policy',
          errorCode: 'NOT_OPTED_IN',
          retryable: false,
          durationMs: Date.now() - startTime,
        };
        break;
      case 'invalid-output':
        result = {
          category: 'invalid-output',
          message: 'Model returned output that failed validation',
          errorCode: 'INVALID_OUTPUT_STRUCTURE',
          retryable: false,
          durationMs: Date.now() - startTime,
        };
        break;
      case 'provider-failed':
        result = {
          category: 'provider-failed',
          message: 'Provider returned an error',
          errorCode: 'PROVIDER_INTERNAL_ERROR',
          retryable: true,
          durationMs: Date.now() - startTime,
        };
        break;
      case 'cancelled':
        // Already handled above, but include for completeness
        result = {
          category: 'cancelled',
          message: 'Request was cancelled',
          retryable: false,
          durationMs: Date.now() - startTime,
        };
        break;
      default:
        result = this.createValidAsyncBrief(input, startTime);
    }

    // Emit end/error audit event
    const durationMs = Date.now() - startTime;
    const auditEvent: Parameters<AuditEventSink['emit']>[0] = {
      correlationId: options.correlationId,
      adapterName: this.adapterName,
      eventType: result.category === 'ready' ? 'end' : 'error',
      status: result.category,
      durationMs,
      ...(result.errorCode !== undefined && { errorCode: result.errorCode }),
    };
    options.auditSink?.emit(auditEvent);

    // For valid results, add the outcome
    if (result.category === 'ready') {
      return result;
    }

    // For non-ready results, ensure duration is set
    return {
      ...result,
      durationMs,
    };
  }

  private createValidAsyncBrief(
    input: ModelAdapterInputV1,
    startTime: number,
  ): AsyncOutcome<ModelAdapterOutputV1> {
    const seed = this.config.seed ?? 42;
    const evidence = extractValidEvidenceAsync(
      input.snapshot,
      input.sceneCoverages,
      input.rules,
      5,
    );

    const sceneIds = input.snapshot.scenes.map((s) => s.id);
    const allSceneIds: readonly string[] | undefined = sceneIds.length > 0 ? sceneIds : undefined;

    // Generate deterministic recommendations
    const recommendations = [] as Array<{
      id: string;
      kind: RecommendationKind;
      confidence: InferenceConfidence;
      evidence: readonly CreativeEvidenceRefV1[];
      rationale: string;
      expectedBenefit: string;
      proposedIntent?: string;
      risk: RecommendationRisk;
      scope: {
        sceneIds?: readonly string[];
        startUs?: number;
        endUs?: number;
        elementIds?: readonly string[];
      };
    }>;

    if (input.snapshot.scenes.length > 1) {
      recommendations.push({
        id: generateDeterministicIdAsync(seed, 'pacing', 0),
        kind: 'pacing',
        confidence: 'high' as const,
        evidence: toCreativeEvidenceAsync(evidence.slice(0, 2), 'pacing-analysis'),
        rationale: 'Scene transitions could benefit from tighter pacing',
        expectedBenefit: 'Improved viewer retention',
        proposedIntent: 'adjust-scene-pacing',
        risk: 'reversible-local' as const,
        scope: {
          ...(allSceneIds !== undefined && { sceneIds: allSceneIds }),
          ...(input.snapshot.scenes[0]?.startUs !== undefined && {
            startUs: input.snapshot.scenes[0]!.startUs,
          }),
          ...(input.snapshot.scenes[input.snapshot.scenes.length - 1]?.endUs !== undefined && {
            endUs: input.snapshot.scenes[input.snapshot.scenes.length - 1]!.endUs,
          }),
        },
      });
    }

    const assumptions = [
      {
        id: generateDeterministicIdAsync(seed, 'assumption', 0),
        statement: 'User wants to improve project quality',
        confidence: 'high' as const,
        evidence: toCreativeEvidenceAsync(evidence.slice(0, 1)),
        verified: true,
      },
    ] as const;

    const facts = [
      {
        id: generateDeterministicIdAsync(seed, 'fact', 0),
        statement: `Project has ${input.snapshot.scenes.length} scenes`,
        source: 's1' as const,
        evidence: evidence.slice(0, 1),
      },
      {
        id: generateDeterministicIdAsync(seed, 'fact', 1),
        statement: `Aspect ratio is ${input.snapshot.composition.aspectRatio}`,
        source: 's1' as const,
        evidence: evidence.slice(0, 1),
      },
    ] as const;

    const inferences = [
      {
        id: generateDeterministicIdAsync(seed, 'inference', 0),
        statement: 'Project would benefit from additional visual elements',
        confidence: 'medium' as const,
        rationale: 'Based on scene coverage analysis',
        evidence: toCreativeEvidenceAsync(evidence.slice(0, 2)),
      },
    ] as const;

    const output: ModelAdapterOutputV1 = {
      interpretedGoal: {
        userIntent: input.request.request,
        inferredGoal: `Improve ${input.request.scope} quality of the project`,
        resolvedGoal: `Generate actionable recommendations to enhance ${input.request.scope}`,
        confidence: 'high' as const,
      },
      distinction: {
        facts,
        inferences,
      },
      assumptions,
      recommendations,
      blockedBy: [],
      requiresHumanDecision: [],
      meta: {
        processingTimeMs: this.config.processingTimeMs ?? 10,
      },
    };

    return {
      category: 'ready',
      result: output,
      retryable: false,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Create a test-only async fake adapter with the specified configuration.
 * This adapter is asynchronous, deterministic, and pure.
 * It must never make network calls.
 *
 * NOTE: This function is NOT exported from the package root to prevent production use.
 * It is only available for internal test use within this package.
 *
 * @param config - Configuration for the fake adapter mode
 * @returns An AsyncCreativeModelAdapter instance with isTestOnly: true
 */
export function createFakeAsyncModelAdapter(
  config: FakeAsyncAdapterConfig = DEFAULT_FAKE_ASYNC_CONFIG,
): AsyncCreativeModelAdapter {
  const name = `fake-async-${config.mode}-v1`;
  return new BaseFakeAsyncModelAdapter(name, config);
}

/**
 * Create a valid async fake adapter (default mode).
 * Produces well-formed, deterministic creative briefs asynchronously.
 * This function is NOT exported from the package root.
 */
export function createValidFakeAsyncAdapter(seed: number = 42): AsyncCreativeModelAdapter {
  return createFakeAsyncModelAdapter({
    mode: 'valid',
    seed,
    processingTimeMs: 10,
    responseDelayMs: 0,
  });
}

/**
 * Create an unavailable async fake adapter for testing.
 * This function is NOT exported from the package root.
 */
export function createUnavailableFakeAsyncAdapter(): AsyncCreativeModelAdapter {
  return createFakeAsyncModelAdapter({ mode: 'unavailable' });
}

/**
 * Create a policy-denied async fake adapter for testing.
 * This function is NOT exported from the package root.
 */
export function createPolicyDeniedFakeAsyncAdapter(): AsyncCreativeModelAdapter {
  return createFakeAsyncModelAdapter({ mode: 'policy-denied' });
}

/**
 * Create an invalid-output async fake adapter for testing.
 * This function is NOT exported from the package root.
 */
export function createInvalidOutputFakeAsyncAdapter(): AsyncCreativeModelAdapter {
  return createFakeAsyncModelAdapter({ mode: 'invalid-output' });
}

/**
 * Create a provider-failed async fake adapter for testing.
 * This function is NOT exported from the package root.
 */
export function createProviderFailedFakeAsyncAdapter(): AsyncCreativeModelAdapter {
  return createFakeAsyncModelAdapter({ mode: 'provider-failed' });
}

/**
 * Create a timeout async fake adapter for testing.
 * This function is NOT exported from the package root.
 */
export function createTimeoutFakeAsyncAdapter(): AsyncCreativeModelAdapter {
  return createFakeAsyncModelAdapter({ mode: 'timeout', responseDelayMs: 100 });
}

/**
 * Create a cancelled async fake adapter for testing.
 * This function is NOT exported from the package root.
 */
export function createCancelledFakeAsyncAdapter(): AsyncCreativeModelAdapter {
  return createFakeAsyncModelAdapter({ mode: 'cancelled' });
}
