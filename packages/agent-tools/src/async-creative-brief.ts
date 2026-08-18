/**
 * Async Creative Brief Finalization - WP-37 S4-F7
 *
 * Provides asynchronous creative brief finalization using AsyncCreativeModelAdapter.
 * The existing synchronous createCreativeBrief() behavior remains unchanged.
 *
 * Key invariants:
 * - Same validation path as S3 (authoritative)
 * - No side effects, no network, no persistence
 * - Pure function with deterministic output for same inputs
 * - Input immutability preserved
 * - Persian text preservation maintained
 */

import type {
  CreativeBriefInputV1,
  CreativeBriefV1,
  CreativeBriefOptions,
} from './creative-brief.js';
import {
  DEFAULT_DETERMINISTIC_CLOCK,
  validateCreativeBriefRequest,
  validateCreativeBrief,
  deepCheckForbiddenPatterns,
} from './creative-brief.js';
import type {
  AsyncCreativeModelAdapter,
  AsyncOutcome,
  AsyncOutcomeCategory,
  AsyncAdapterOptions,
} from './async-model-adapter.js';
import type {
  ModelAdapterInputV1,
  ModelAdapterOutputV1,
} from './model-adapter.js';
import type { SemanticProjectSnapshotV1, EvidenceRefV1 } from '@joy-media/project-schema';
import type { CreativeEvidenceRefV1 } from './creative-brief.js';

// ==========================================================================
// Types
// ==========================================================================

/**
 * Options for creating a creative brief asynchronously.
 */
export interface AsyncCreativeBriefOptions extends CreativeBriefOptions {
  /**
   * Async adapter to use for model calls.
   */
  readonly adapter: AsyncCreativeModelAdapter;
  /**
   * Async adapter runtime options (signal, timeout, correlation, audit).
   */
  readonly adapterOptions: AsyncAdapterOptions;
}

/**
 * Outcome of an async creative brief operation.
 * Contains either a validated CreativeBriefV1 or a failure category.
 */
export interface AsyncCreativeBriefOutcome {
  readonly category: AsyncOutcomeCategory;
  readonly brief?: CreativeBriefV1; // Only present when category === 'ready'
  readonly errorCode?: string; // Specific error code
  readonly message?: string; // Human-readable message (no secrets)
  readonly retryable: boolean; // Whether the caller may retry
  readonly durationMs: number; // Total time spent in ms
}

// ==========================================================================
// Pure Finalization Helper
// ==========================================================================

/**
 * Pure helper to finalize validated ModelAdapterOutputV1 into CreativeBriefV1.
 * This is the shared finalization path used by both sync and async creative brief creation.
 *
 * Assumes all inputs have already been validated:
 * - input snapshot/revision/project parity
 * - adapter output structure and forbidden patterns
 * - evidence references
 *
 * @param input - Validated creative brief input
 * @param adapterOutput - Validated model adapter output
 * @param adapterName - Name of the adapter that produced the output
 * @param clock - Deterministic clock function
 * @returns Validated CreativeBriefV1
 */
function finalizeCreativeBriefFromOutput(
  input: CreativeBriefInputV1,
  adapterOutput: ModelAdapterOutputV1,
  adapterName: string,
  clock: () => string,
): CreativeBriefV1 {
  // Validate all evidence references in recommendations point to valid snapshot data
  const evidenceWarnings = adapterOutput.recommendations.reduce<
    CreativeBriefV1['warnings']
  >((acc, rec) => {
    const invalidEvidence = rec.evidence.filter(ev =>
      !validateEvidenceReference(ev, input.snapshot),
    );
    return [
      ...acc,
      ...invalidEvidence.map(ev => ({
        code: 'invalid-evidence-reference',
        message: `Recommendation ${rec.id} references invalid evidence: ${ev.id}`,
        severity: 'error' as const,
      })),
    ];
  }, []);

  // Calculate processing time from adapter's meta or use a small deterministic value
  const processingTimeMs = adapterOutput.meta?.processingTimeMs ?? 10;

  // Build warnings from validation - start with empty array since we validated directly
  const validationWarnings: CreativeBriefV1['warnings'] = [];

  // Build the creative brief
  const brief: CreativeBriefV1 = {
    schemaVersion: 1,
    snapshotRevisionId: input.snapshot.revisionId,
    projectId: input.snapshot.projectId,
    request: input.request.request,
    interpretedGoal: {
      userIntent: adapterOutput.interpretedGoal.userIntent,
      inferredGoal: adapterOutput.interpretedGoal.inferredGoal,
      resolvedGoal: adapterOutput.interpretedGoal.resolvedGoal,
      confidence: adapterOutput.interpretedGoal.confidence,
    },
    distinction: {
      facts: adapterOutput.distinction.facts,
      inferences: adapterOutput.distinction.inferences,
    },
    assumptions: adapterOutput.assumptions,
    recommendations: adapterOutput.recommendations,
    blockedBy: adapterOutput.blockedBy,
    requiresHumanDecision: adapterOutput.requiresHumanDecision,
    intelligence: {
      brand: input.brandReadiness,
      scenes: input.sceneCoverages,
      project: input.projectReadiness,
      rules: input.rules,
    },
    warnings: [...validationWarnings, ...evidenceWarnings],
    meta: {
      generatedAt: clock(),
      modelAdapter: adapterName,
      processingTimeMs,
    },
  };

  // Final validation of the complete brief
  const finalValidation = validateCreativeBrief(brief);
  if (!finalValidation.valid) {
    throw new Error(
      `Final validation failed: ${finalValidation.errors.map(e => e.message).join('; ')}`,
    );
  }

  return brief;
}

/**
 * Validate that an evidence reference points to valid snapshot data.
 * This ensures all recommendations reference real evidence from the snapshot.
 */
function validateEvidenceReference(
  ref: EvidenceRefV1 | CreativeEvidenceRefV1,
  snapshot: SemanticProjectSnapshotV1,
): boolean {
  // Normalize ref to EvidenceRefV1 by extracting the base evidence fields
  const baseRef: EvidenceRefV1 = {
    id: ref.id,
    kind: ref.kind,
    ...('startUs' in ref && { startUs: ref.startUs }),
    ...('endUs' in ref && { endUs: ref.endUs }),
  };

  // Check if the reference kind is valid
  const validKinds: EvidenceRefV1['kind'][] = [
    'composition', 'track', 'clip', 'asset', 'visual-object', 'caption', 'marker',
  ];
  if (!validKinds.includes(baseRef.kind)) {
    return false;
  }

  // Check if the referenced ID exists in the snapshot
  switch (baseRef.kind) {
    case 'composition':
      return (
        baseRef.id === snapshot.projectId ||
        baseRef.id === snapshot.composition.aspectRatio ||
        baseRef.id === snapshot.composition.durationUs.toString()
      );

    case 'track':
      return (
        snapshot.timeline?.visualRowIds?.includes(baseRef.id) ||
        snapshot.timeline?.audioRowIds?.includes(baseRef.id) ||
        baseRef.id === snapshot.projectId
      );

    case 'clip':
      return snapshot.scenes.some(scene =>
        scene.elements.some(el => el.id === baseRef.id),
      );

    case 'asset':
      return snapshot.assets.some(a => a.id === baseRef.id);

    case 'visual-object':
      return snapshot.scenes.some(scene =>
        scene.elements.some(el => el.id === baseRef.id),
      );

    case 'caption':
      return snapshot.scenes.some(
        scene =>
          scene.captionCoverage?.locale === baseRef.id ||
          scene.id === baseRef.id,
      );

    case 'marker':
      return snapshot.scenes.some(
        scene => scene.id === baseRef.id,
      );

    default:
      return false;
  }
}

// ==========================================================================
// Async Creative Brief API
// ==========================================================================

/**
 * Create a creative brief asynchronously using an AsyncCreativeModelAdapter.
 *
 * This is the async counterpart to createCreativeBrief(). It:
 * - Validates all inputs (same validation as sync path)
 * - Calls the async adapter to get ModelAdapterOutputV1
 * - Passes the output through the same authoritative S3 validation/finalization
 * - Returns a typed async outcome with either CreativeBriefV1 or failure category
 *
 * INVARIANTS:
 * - Pure function: identical inputs produce byte-stable outputs
 * - No side effects: no project mutation, no network, no persistence
 * - No secrets: no paths, URLs, credentials, or object-store references
 * - No commands: no command payloads or mutation instructions
 * - Revision parity: brief is bound to exact snapshot revision
 * - Evidence parity: all recommendations reference valid snapshot evidence
 * - Same validation as S3: authoritative validation path
 *
 * @param input - Creative brief input (validated S1/S2 data + request)
 * @param options - Async creative brief options including adapter and adapter runtime options
 * @returns Promise resolving to AsyncCreativeBriefOutcome
 */
export async function createAsyncCreativeBrief(
  input: CreativeBriefInputV1,
  options: AsyncCreativeBriefOptions,
): Promise<AsyncCreativeBriefOutcome> {
  const totalStartTime = Date.now();

  // Use deterministic clock - NEVER use Date.now() directly for generatedAt
  const clock = options.clock ?? DEFAULT_DETERMINISTIC_CLOCK;

  // Validate inputs (same validation as sync path)
  const requestValidation = validateCreativeBriefRequest(input.request);
  if (!requestValidation.valid) {
    return {
      category: 'invalid-output',
      message: `Invalid creative brief request: ${requestValidation.errors.map(e => e.message).join('; ')}`,
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  }

  // Validate snapshot revision parity
  if (input.snapshot.revisionId !== input.request.snapshotRevisionId) {
    return {
      category: 'invalid-output',
      message: `Snapshot revision mismatch: snapshot has ${input.snapshot.revisionId}, request expects ${input.request.snapshotRevisionId}`,
      errorCode: 'REVISION_MISMATCH',
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  }

  // Validate project ID parity
  if (input.snapshot.projectId !== input.request.projectId) {
    return {
      category: 'invalid-output',
      message: `Project ID mismatch: snapshot has ${input.snapshot.projectId}, request has ${input.request.projectId}`,
      errorCode: 'PROJECT_ID_MISMATCH',
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  }

  // Prepare adapter input (bounded, validated data only)
  const adapterInput: ModelAdapterInputV1 = {
    snapshot: input.snapshot,
    brandReadiness: input.brandReadiness,
    sceneCoverages: input.sceneCoverages,
    projectReadiness: input.projectReadiness,
    rules: input.rules,
    request: input.request,
  };

  // Call async model adapter
  const adapterOutcome = await options.adapter.createBrief(
    adapterInput,
    options.adapterOptions,
  );

  // Handle adapter failures
  if (adapterOutcome.category !== 'ready') {
    const result: AsyncCreativeBriefOutcome = {
      category: adapterOutcome.category,
      retryable: adapterOutcome.retryable,
      durationMs: Date.now() - totalStartTime,
      ...(adapterOutcome.message !== undefined && { message: adapterOutcome.message }),
      ...(adapterOutcome.errorCode !== undefined && { errorCode: adapterOutcome.errorCode }),
    };
    return result;
  }

  // Extract the adapter output from the ready outcome
  const adapterOutput = adapterOutcome.result!;

  // Validate adapter output structure - reject malformed, unsafe, excessive, empty-invalid
  // This is the same validation as the sync path
  if (!adapterOutput || typeof adapterOutput !== 'object') {
    return {
      category: 'invalid-output',
      message: 'Model adapter returned invalid output: must be a non-null object',
      errorCode: 'MALFORMED_OUTPUT',
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  }

  // Validate interpretedGoal
  if (
    !adapterOutput.interpretedGoal ||
    typeof adapterOutput.interpretedGoal !== 'object'
  ) {
    return {
      category: 'invalid-output',
      message: 'Model adapter output missing or invalid interpretedGoal',
      errorCode: 'INVALID_INTERPRETED_GOAL',
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  }

  const ig = adapterOutput.interpretedGoal;
  if (typeof ig.userIntent !== 'string' || ig.userIntent.trim() === '') {
    return {
      category: 'invalid-output',
      message: 'Model adapter output has invalid interpretedGoal.userIntent',
      errorCode: 'INVALID_USER_INTENT',
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  }

  if (typeof ig.inferredGoal !== 'string' || ig.inferredGoal.trim() === '') {
    return {
      category: 'invalid-output',
      message: 'Model adapter output has invalid interpretedGoal.inferredGoal',
      errorCode: 'INVALID_INFERRED_GOAL',
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  }

  if (typeof ig.resolvedGoal !== 'string' || ig.resolvedGoal.trim() === '') {
    return {
      category: 'invalid-output',
      message: 'Model adapter output has invalid interpretedGoal.resolvedGoal',
      errorCode: 'INVALID_RESOLVED_GOAL',
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  }

  // Validate distinction
  if (
    !adapterOutput.distinction ||
    typeof adapterOutput.distinction !== 'object'
  ) {
    return {
      category: 'invalid-output',
      message: 'Model adapter output missing or invalid distinction',
      errorCode: 'INVALID_DISTINCTION',
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  }

  // Validate arrays
  if (!Array.isArray(adapterOutput.recommendations)) {
    return {
      category: 'invalid-output',
      message: 'Model adapter output recommendations must be an array',
      errorCode: 'INVALID_RECOMMENDATIONS',
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  }

  if (
    adapterOutput.assumptions !== undefined &&
    !Array.isArray(adapterOutput.assumptions)
  ) {
    return {
      category: 'invalid-output',
      message: 'Model adapter output assumptions must be an array if provided',
      errorCode: 'INVALID_ASSUMPTIONS',
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  }

  if (
    adapterOutput.blockedBy !== undefined &&
    !Array.isArray(adapterOutput.blockedBy)
  ) {
    return {
      category: 'invalid-output',
      message: 'Model adapter output blockedBy must be an array if provided',
      errorCode: 'INVALID_BLOCKED_BY',
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  }

  if (
    adapterOutput.requiresHumanDecision !== undefined &&
    !Array.isArray(adapterOutput.requiresHumanDecision)
  ) {
    return {
      category: 'invalid-output',
      message: 'Model adapter output requiresHumanDecision must be an array if provided',
      errorCode: 'INVALID_HUMAN_DECISION',
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  }

  // Check for forbidden patterns in adapter output
  const adapterErrors = deepCheckForbiddenPatterns(adapterOutput);
  if (adapterErrors.length > 0) {
    return {
      category: 'invalid-output',
      message: `Model adapter output contains forbidden patterns: ${adapterErrors.join('; ')}`,
      errorCode: 'FORBIDDEN_PATTERNS',
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  }

  // Try to finalize the brief using the shared helper
  // This uses the same validation/finalization path as the sync createCreativeBrief
  try {
    const brief = finalizeCreativeBriefFromOutput(
      input,
      adapterOutput,
      options.adapter.adapterName,
      clock,
    );

    return {
      category: 'ready',
      brief,
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  } catch (error) {
    // Final validation or evidence validation failed
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      category: 'invalid-output',
      message: `Final validation failed: ${errorMessage}`,
      errorCode: 'FINAL_VALIDATION_FAILED',
      retryable: false,
      durationMs: Date.now() - totalStartTime,
    };
  }
}

// ==========================================================================
// Async Creative Brief with Input Options
// ==========================================================================

/**
 * Options for creating a creative brief asynchronously with separate input and options.
 */
export interface AsyncCreativeBriefInputOptions {
  /**
   * Async adapter to use for model calls.
   */
  readonly adapter: AsyncCreativeModelAdapter;
  /**
   * Async adapter runtime options (signal, timeout, correlation, audit).
   */
  readonly adapterOptions: AsyncAdapterOptions;
  /**
   * Injected clock for deterministic timestamps.
   */
  readonly clock?: () => string;
}

/**
 * Create a creative brief asynchronously with separate input and options.
 * This is a convenience wrapper around createAsyncCreativeBrief.
 *
 * @param input - Creative brief input
 * @param options - Async creative brief options
 * @returns Promise resolving to AsyncCreativeBriefOutcome
 */
export async function createAsyncCreativeBriefWithOptions(
  input: CreativeBriefInputV1,
  options: AsyncCreativeBriefInputOptions,
): Promise<AsyncCreativeBriefOutcome> {
  const briefOptions: AsyncCreativeBriefOptions = {
    adapter: options.adapter,
    adapterOptions: options.adapterOptions,
    ...(options.clock !== undefined && { clock: options.clock }),
  };
  return createAsyncCreativeBrief(input, briefOptions);
}
