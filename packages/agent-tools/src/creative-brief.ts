/**
 * Creative Brief and Read-Only Critique - WP-37 S3
 *
 * Pure, deterministic creative brief derivation from semantic snapshots.
 * No LLM calls, no network, no persistence, no secrets, no project mutation.
 */

import type {
  SemanticProjectSnapshotV1,
  ProjectRevisionId,
  EvidenceRefV1,
} from '@joy-media/project-schema';

import type {
  BrandReadinessV1,
  SceneCoverageV1,
  ProjectReadinessV1,
  IntelligenceRuleV1,
  IntelligenceEvidenceRefV1,
} from '@joy-media/project-schema';

import type {
  CreativeModelAdapter,
  ModelAdapterInputV1,
  ModelAdapterOutputV1,
} from './model-adapter.js';

// ============================================================================
// S3 Types
// ============================================================================

/**
 * Allowed scope for a creative brief request.
 * Bounds the model's authority to specific, reviewable aspects.
 */
export type CreativeBriefScope =
  | 'pacing'
  | 'caption-coverage'
  | 'visual-coverage'
  | 'brand-alignment'
  | 'audio-quality'
  | 'structure'
  | 'general';

/**
 * Allowed destination presets for project goals
 */
export type DestinationPreset =
  | 'instagram-reel'
  | 'instagram-story'
  | 'tiktok'
  | 'youtube-short'
  | 'youtube-video'
  | 'twitter-x'
  | 'facebook-reel'
  | 'linkedin-video'
  | 'custom';

/**
 * Confidence level for model inferences.
 * Facts from S1/S2 are always high confidence.
 * Model inferences must be honestly labeled.
 */
export type InferenceConfidence = 'low' | 'medium' | 'high';

/**
 * Risk classification for recommendations.
 * Determines approval requirements.
 */
export type RecommendationRisk =
  | 'none' // Purely advisory, no mutation
  | 'reversible-local' // Local-only, can be undone
  | 'destructive' // Cannot be undone without manual intervention
  | 'remote-egress' // Requires network access
  | 'spend'; // Incurs cost

/**
 * Kind of creative recommendation.
 * Each kind corresponds to a specific, bounded change category.
 */
export type RecommendationKind =
  | 'pacing'
  | 'caption'
  | 'visual-coverage'
  | 'brand'
  | 'audio'
  | 'transition'
  | 'color'
  | 'structure';

/**
 * Stable recommendation identifier.
 * Format: <kind>.<scope>.<specific-identifier>
 * Example: "pacing.hook.add-broll-001"
 */
export type RecommendationId = string;

/**
 * Evidence reference that can reference S1 evidence or add S3-specific context.
 */
export interface CreativeEvidenceRefV1 extends IntelligenceEvidenceRefV1 {
  /** Optional S3-specific detail about the evidence */
  readonly s3Detail?: string;
}

/**
 * An assumption made by the model when interpreting the request.
 * Must be explicitly stated and verifiable against snapshot data.
 */
export interface AssumptionV1 {
  readonly id: string;
  readonly statement: string;
  readonly confidence: InferenceConfidence;
  readonly evidence: readonly CreativeEvidenceRefV1[];
  /** Whether this assumption was verified against snapshot facts */
  readonly verified: boolean;
}

/**
 * A capability gap that blocks execution of a recommendation.
 * Never fabricated as "ready" - must be truthfully reported.
 */
export interface CapabilityGapV1 {
  readonly id: string;
  readonly capability: string;
  readonly status: 'setup-required' | 'unavailable' | 'unknown';
  readonly message: string;
  readonly evidence: readonly CreativeEvidenceRefV1[];
}

/**
 * A decision that requires human judgment.
 * Model cannot and should not make this decision automatically.
 */
export interface HumanDecisionV1 {
  readonly id: string;
  readonly question: string;
  readonly context: string;
  readonly options: readonly string[];
  readonly evidence: readonly CreativeEvidenceRefV1[];
}

/**
 * A creative recommendation with full provenance.
 *
 * RULES:
 * - Every recommendation MUST reference valid snapshot evidence
 * - Subjective language ("premium", "cinematic", "luxury", "on-brand")
 *   must be framed as low/medium confidence inference, never as fact
 * - proposedIntent is NON-EXECUTABLE - it is a hint only
 * - risk must be honestly classified
 */
export interface CreativeRecommendationV1 {
  readonly id: RecommendationId;
  readonly kind: RecommendationKind;
  readonly confidence: InferenceConfidence;
  readonly evidence: readonly CreativeEvidenceRefV1[];
  readonly rationale: string;
  readonly expectedBenefit: string;
  /** Non-executable hint for what action might address this */
  readonly proposedIntent?: string;
  readonly risk: RecommendationRisk;
  /** Scope or range this recommendation applies to */
  readonly scope: {
    readonly sceneIds?: readonly string[];
    readonly startUs?: number;
    readonly endUs?: number;
    readonly elementIds?: readonly string[];
  };
}

/**
 * Bounded user request for a creative brief.
 *
 * VALIDATION RULES:
 * - request must be non-empty and bounded in length
 * - scope must be a known CreativeBriefScope
 * - snapshotRevisionId must match the provided snapshot
 * - allowedRecommendationKinds must be a subset of known kinds
 * - No paths, URLs, secrets, or command payloads allowed
 */
export interface CreativeBriefRequestV1 {
  readonly snapshotRevisionId: ProjectRevisionId;
  readonly projectId: string;
  /** User's creative request/goal */
  readonly request: string;
  /** Bounded scope of the request */
  readonly scope: CreativeBriefScope;
  /** Maximum number of recommendations to return */
  readonly maxRecommendations?: number;
  /** Whitelist of recommendation kinds to consider (empty = all allowed) */
  readonly allowedRecommendationKinds?: readonly RecommendationKind[];
  /** Destination preset if user specified one */
  readonly destination?: DestinationPreset;
  /** Duration target in microseconds if specified */
  readonly durationTargetUs?: number;
  /** Brief description/additional context */
  readonly brief?: string;
}

/**
 * The interpreted goal after processing the user request.
 * Distinguishes between:
 * - userIntent: what the user explicitly asked for
 * - inferredGoal: what the system understands the user wants
 * - resolvedGoal: the specific, bounded goal to address
 */
export interface InterpretedGoalV1 {
  readonly userIntent: string;
  readonly inferredGoal: string;
  readonly resolvedGoal: string;
  readonly confidence: InferenceConfidence;
}

/**
 * Distinguishes between deterministic S2 facts and model inferences.
 * This is CRITICAL for trust and auditability.
 */
export interface FactInferenceDistinctionV1 {
  /** Deterministic facts from S1/S2 that are always true */
  readonly facts: readonly {
    readonly id: string;
    readonly statement: string;
    readonly source: 's1' | 's2' | 'snapshot';
    readonly evidence: readonly EvidenceRefV1[];
  }[];
  /** Model inferences that may be uncertain or context-dependent */
  readonly inferences: readonly {
    readonly id: string;
    readonly statement: string;
    readonly confidence: InferenceConfidence;
    readonly rationale: string;
    readonly evidence: readonly CreativeEvidenceRefV1[];
  }[];
}

/**
 * The complete creative brief result.
 *
 * INVARIANTS:
 * - snapshotRevisionId must match the input snapshot
 * - All evidence references must be valid and point to real snapshot data
 * - Facts and inferences must be explicitly distinguished
 * - No command payloads, DOM references, or mutation instructions
 * - No secrets, paths, URLs, or provider credentials
 * - Pure function: identical inputs produce byte-stable outputs
 */
export interface CreativeBriefV1 {
  readonly schemaVersion: 1;
  readonly snapshotRevisionId: ProjectRevisionId;
  readonly projectId: string;
  readonly request: string;
  readonly interpretedGoal: InterpretedGoalV1;
  readonly distinction: FactInferenceDistinctionV1;
  readonly assumptions: readonly AssumptionV1[];
  readonly recommendations: readonly CreativeRecommendationV1[];
  readonly blockedBy: readonly CapabilityGapV1[];
  readonly requiresHumanDecision: readonly HumanDecisionV1[];
  /** S2 intelligence that was used as input */
  readonly intelligence: {
    readonly brand: BrandReadinessV1;
    readonly scenes: readonly SceneCoverageV1[];
    readonly project: ProjectReadinessV1;
    readonly rules: readonly IntelligenceRuleV1[];
  };
  /** Warnings about limitations or uncertainties */
  readonly warnings: readonly {
    readonly code: string;
    readonly message: string;
    readonly severity: 'info' | 'warning' | 'error';
  }[];
  /** Metadata about the brief generation */
  readonly meta: {
    readonly generatedAt: string;
    readonly modelAdapter: string; // 'fake-v1' for test adapter, or future real adapter name
    readonly processingTimeMs: number;
  };
}

// ============================================================================
// Validation Types
// ============================================================================

/** Result of validating a CreativeBriefRequestV1 */
export interface BriefRequestValidationResult {
  readonly valid: boolean;
  readonly errors: readonly {
    readonly code: string;
    readonly message: string;
    readonly field?: string;
  }[];
  readonly warnings: readonly {
    readonly code: string;
    readonly message: string;
    readonly field?: string;
  }[];
}

/** Result of validating a CreativeBriefV1 */
export interface BriefValidationResult {
  readonly valid: boolean;
  readonly errors: readonly {
    readonly code: string;
    readonly message: string;
    readonly path?: string;
  }[];
  readonly warnings: readonly {
    readonly code: string;
    readonly message: string;
    readonly path?: string;
  }[];
}

// ============================================================================
// S3 Orchestration Input
// ============================================================================

/**
 * Complete input for S3 orchestration.
 * Contains everything needed to produce a creative brief WITHOUT
 * accessing any external state.
 */
export interface CreativeBriefInputV1 {
  readonly snapshot: SemanticProjectSnapshotV1;
  readonly brandReadiness: BrandReadinessV1;
  readonly sceneCoverages: readonly SceneCoverageV1[];
  readonly projectReadiness: ProjectReadinessV1;
  readonly rules: readonly IntelligenceRuleV1[];
  readonly request: CreativeBriefRequestV1;
}

/**
 * Options for brief generation
 */
export interface CreativeBriefOptions {
  /** Injected clock for deterministic timestamps (defaults to a deterministic value, NOT Date.now) */
  readonly clock?: () => string;
  /** Whether to include debug information in the result */
  readonly includeDebug?: boolean;
}

// ==========================================================================
// Deterministic Clock
// ==========================================================================

/**
 * Default deterministic clock for tests.
 * Returns a fixed ISO timestamp to ensure byte-stable outputs.
 * Production code should inject a real clock through options.
 */
export const DEFAULT_DETERMINISTIC_CLOCK = () => '2026-08-17T00:00:00.000Z' as const;

/**
 * Get a deterministic clock value for the given input.
 * Uses injected clock if provided, otherwise uses the deterministic default.
 * This ensures S3 orchestration is pure and produces byte-stable outputs.
 */
function getClock(options: CreativeBriefOptions): () => string {
  return options.clock ?? DEFAULT_DETERMINISTIC_CLOCK;
}

// ============================================================================
// Security / Purity Constraints
// ============================================================================

/**
 * Patterns that are forbidden in any S3 string field.
 * These indicate potential secret, path, URL, or command leakage.
 *
 * IMPORTANT: We only block credential-shaped values, not generic words.
 * Words like "token", "auth", "OpenAI", "Google" without credential patterns are allowed.
 * Only actual credential formats like "sk-1234567890abcdef" or "Bearer eyJ..." are blocked.
 */
export const FORBIDDEN_PATTERNS = [
  // Command execution patterns
  /\b(C|D|E|F):\\\[^\s\\]*\b/i,
  /bexecs*:/i,
  /brms+-s*r[af]/i,
  /\b\/([^\s/]+\/)+[^\s/]+\b/,
  // URLs and object store references
  /\bhttps?:\/\/[^\s]+/i,
  /\bftp:\/\/[^\s]+/i,
  /\bgs:\/\/[^\s]+/i,
  /\bs3:\/\/[^\s]+/i,
  /\bblob:[^\s]+/i,
  /\bdata:[^\s]+/i,
  // Common secret patterns - only match credential-shaped values (prefix + long alphanumeric)
  // sk- prefix (OpenAI, etc.)
  /\bsk-[a-zA-Z0-9]{10,}\b/i,
  // pk- prefix (stripe, etc.)
  /\bpk-[a-zA-Z0-9]{10,}\b/i,
  // api_key or apikey patterns
  /\bapi[_-]?key[_-]?[a-zA-Z0-9]{10,}\b/i,
  // secret followed by underscore/plus and long value
  /\bsecret[_-][a-zA-Z0-9]{10,}\b/i,
  // password followed by equals or underscore and value
  /\bpassword[=][^\s]{10,}\b/i,
  /\bpassword[_-][a-zA-Z0-9]{10,}\b/i,
  // credential followed by underscore and long value
  /\bcredential[_-][a-zA-Z0-9]{10,}\b/i,
  // auth followed by underscore/plus and long value (NOT standalone "auth")
  /\bauth[_-][a-zA-Z0-9]{10,}\b/i,
  /\bBearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/,
  // Provider-specific key patterns - only match full key formats
  /\b(openrouter|anthropic|openai|mistral|google|azure)[_-]?sk-[a-zA-Z0-9]{10,}\b/i,
  /\b(openrouter|anthropic|openai|mistral|google|azure)[_-]?api[_-]?key[a-zA-Z0-9_-]{10,}\b/i,
  // AWS/Cloud credentials
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[0-9a-zA-Z/+]{40}\b/,
] as const;

/** Maximum lengths for various fields to prevent unbounded data */
export const MAX_LENGTHS = {
  request: 2000,
  brief: 1000,
  rationale: 500,
  expectedBenefit: 500,
  proposedIntent: 200,
  recommendationId: 100,
  assumptionStatement: 500,
  capability: 100,
  humanDecisionQuestion: 500,
  humanDecisionContext: 1000,
  recommendationCount: 20,
  assumptionCount: 10,
  capabilityGapCount: 10,
  humanDecisionCount: 10,
  evidenceRefCount: 10,
} as const;

// ============================================================================
// Recommendation Kind Constants
// ============================================================================

export const RECOMMENDATION_KINDS: readonly RecommendationKind[] = [
  'pacing',
  'caption',
  'visual-coverage',
  'brand',
  'audio',
  'transition',
  'color',
  'structure',
] as const;

export const CREATIVE_BRIEF_SCOPES: readonly CreativeBriefScope[] = [
  'pacing',
  'caption-coverage',
  'visual-coverage',
  'brand-alignment',
  'audio-quality',
  'structure',
  'general',
] as const;

export const DESTINATION_PRESETS: readonly DestinationPreset[] = [
  'instagram-reel',
  'instagram-story',
  'tiktok',
  'youtube-short',
  'youtube-video',
  'twitter-x',
  'facebook-reel',
  'linkedin-video',
  'custom',
] as const;

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate a CreativeBriefRequestV1
 * Returns errors for any violation of the contract
 */
export function validateCreativeBriefRequest(request: unknown): BriefRequestValidationResult {
  const errors: { code: string; message: string; field?: string }[] = [];
  const warnings: { code: string; message: string; field?: string }[] = [];

  // Must be an object
  if (!request || typeof request !== 'object') {
    return {
      valid: false,
      errors: [{ code: 'invalid-type', message: 'Request must be a non-null object' }],
      warnings: [],
    };
  }

  const r = request as Record<string, unknown>;

  // Check required fields
  if (typeof r.snapshotRevisionId !== 'string' || r.snapshotRevisionId.trim() === '') {
    errors.push({
      code: 'missing-snapshot-revision',
      message: 'snapshotRevisionId is required and must be a non-empty string',
      field: 'snapshotRevisionId',
    });
  }

  if (typeof r.projectId !== 'string' || r.projectId.trim() === '') {
    errors.push({
      code: 'missing-project-id',
      message: 'projectId is required and must be a non-empty string',
      field: 'projectId',
    });
  }

  if (typeof r.request !== 'string' || r.request.trim() === '') {
    errors.push({
      code: 'missing-request',
      message: 'request is required and must be a non-empty string',
      field: 'request',
    });
  } else if (r.request.length > MAX_LENGTHS.request) {
    errors.push({
      code: 'request-too-long',
      message: `request must be <= ${MAX_LENGTHS.request} characters`,
      field: 'request',
    });
  }

  if (
    typeof r.scope !== 'string' ||
    !CREATIVE_BRIEF_SCOPES.includes(r.scope as CreativeBriefScope)
  ) {
    errors.push({
      code: 'invalid-scope',
      message: `scope must be one of: ${CREATIVE_BRIEF_SCOPES.join(', ')}`,
      field: 'scope',
    });
  }

  // Check optional fields
  if (r.brief !== undefined && typeof r.brief !== 'string') {
    errors.push({
      code: 'invalid-brief',
      message: 'brief must be a string if provided',
      field: 'brief',
    });
  } else if (typeof r.brief === 'string' && r.brief.length > MAX_LENGTHS.brief) {
    errors.push({
      code: 'brief-too-long',
      message: `brief must be <= ${MAX_LENGTHS.brief} characters`,
      field: 'brief',
    });
  }

  if (
    r.destination !== undefined &&
    !DESTINATION_PRESETS.includes(r.destination as DestinationPreset)
  ) {
    errors.push({
      code: 'invalid-destination',
      message: `destination must be one of: ${DESTINATION_PRESETS.join(', ')}`,
      field: 'destination',
    });
  }

  if (
    r.durationTargetUs !== undefined &&
    (typeof r.durationTargetUs !== 'number' || r.durationTargetUs < 0)
  ) {
    errors.push({
      code: 'invalid-duration',
      message: 'durationTargetUs must be a non-negative number if provided',
      field: 'durationTargetUs',
    });
  }

  if (
    r.maxRecommendations !== undefined &&
    (typeof r.maxRecommendations !== 'number' ||
      r.maxRecommendations <= 0 ||
      r.maxRecommendations > MAX_LENGTHS.recommendationCount)
  ) {
    errors.push({
      code: 'invalid-max-recommendations',
      message: `maxRecommendations must be between 1 and ${MAX_LENGTHS.recommendationCount}`,
      field: 'maxRecommendations',
    });
  }

  if (r.allowedRecommendationKinds !== undefined) {
    if (!Array.isArray(r.allowedRecommendationKinds)) {
      errors.push({
        code: 'invalid-allowed-kinds',
        message: 'allowedRecommendationKinds must be an array if provided',
        field: 'allowedRecommendationKinds',
      });
    } else {
      for (const kind of r.allowedRecommendationKinds as unknown[]) {
        if (
          typeof kind !== 'string' ||
          !RECOMMENDATION_KINDS.includes(kind as RecommendationKind)
        ) {
          errors.push({
            code: 'invalid-recommendation-kind',
            message: `allowedRecommendationKinds contains invalid value: ${kind}`,
            field: 'allowedRecommendationKinds',
          });
          break;
        }
      }
    }
  }

  // Check for forbidden patterns in string fields
  const stringFields = ['snapshotRevisionId', 'projectId', 'request', 'brief', 'destination'];
  for (const field of stringFields) {
    if (typeof r[field] === 'string') {
      const value = r[field] as string;
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(value)) {
          errors.push({
            code: 'forbidden-pattern',
            message: `Field '${field}' contains forbidden pattern`,
            field,
          });
          break;
        }
      }
    }
  }

  // Check for unknown fields
  const knownFields: readonly string[] = [
    'snapshotRevisionId',
    'projectId',
    'request',
    'scope',
    'maxRecommendations',
    'allowedRecommendationKinds',
    'destination',
    'durationTargetUs',
    'brief',
  ];
  for (const key of Object.keys(r)) {
    if (!knownFields.includes(key)) {
      errors.push({ code: 'unknown-field', message: `Unknown field: ${key}`, field: key });
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors as BriefRequestValidationResult['errors'],
    warnings: warnings as BriefRequestValidationResult['warnings'],
  };
}

/**
 * Validate a CreativeBriefV1
 * Returns errors for any violation of the contract
 */
export function validateCreativeBrief(brief: unknown): BriefValidationResult {
  const errors: { code: string; message: string; path?: string }[] = [];
  const warnings: { code: string; message: string; path?: string }[] = [];

  if (!brief || typeof brief !== 'object') {
    return {
      valid: false,
      errors: [{ code: 'invalid-type', message: 'Brief must be a non-null object' }],
      warnings: [],
    };
  }

  const b = brief as Record<string, unknown>;

  // Check schema version
  if (b.schemaVersion !== 1) {
    errors.push({
      code: 'invalid-schema-version',
      message: 'schemaVersion must be 1',
      path: 'schemaVersion',
    });
  }

  // Check required fields
  if (typeof b.snapshotRevisionId !== 'string' || b.snapshotRevisionId.trim() === '') {
    errors.push({
      code: 'missing-snapshot-revision',
      message: 'snapshotRevisionId is required',
      path: 'snapshotRevisionId',
    });
  }

  if (typeof b.projectId !== 'string' || b.projectId.trim() === '') {
    errors.push({
      code: 'missing-project-id',
      message: 'projectId is required',
      path: 'projectId',
    });
  }

  if (typeof b.request !== 'string' || b.request.trim() === '') {
    errors.push({ code: 'missing-request', message: 'request is required', path: 'request' });
  }

  // Validate interpretedGoal
  if (!b.interpretedGoal || typeof b.interpretedGoal !== 'object') {
    errors.push({
      code: 'missing-interpreted-goal',
      message: 'interpretedGoal is required',
      path: 'interpretedGoal',
    });
  } else {
    const ig = b.interpretedGoal as Record<string, unknown>;
    if (typeof ig.userIntent !== 'string' || ig.userIntent.trim() === '') {
      errors.push({
        code: 'missing-user-intent',
        message: 'interpretedGoal.userIntent is required',
        path: 'interpretedGoal.userIntent',
      });
    }
    if (typeof ig.inferredGoal !== 'string' || ig.inferredGoal.trim() === '') {
      errors.push({
        code: 'missing-inferred-goal',
        message: 'interpretedGoal.inferredGoal is required',
        path: 'interpretedGoal.inferredGoal',
      });
    }
    if (typeof ig.resolvedGoal !== 'string' || ig.resolvedGoal.trim() === '') {
      errors.push({
        code: 'missing-resolved-goal',
        message: 'interpretedGoal.resolvedGoal is required',
        path: 'interpretedGoal.resolvedGoal',
      });
    }
    if (
      ig.confidence !== undefined &&
      !['low', 'medium', 'high'].includes(ig.confidence as string)
    ) {
      errors.push({
        code: 'invalid-confidence',
        message: 'interpretedGoal.confidence must be low, medium, or high',
        path: 'interpretedGoal.confidence',
      });
    }
  }

  // Validate distinction
  if (!b.distinction || typeof b.distinction !== 'object') {
    errors.push({
      code: 'missing-distinction',
      message: 'distinction is required',
      path: 'distinction',
    });
  }

  // Validate recommendations array
  if (!Array.isArray(b.recommendations)) {
    errors.push({
      code: 'missing-recommendations',
      message: 'recommendations must be an array',
      path: 'recommendations',
    });
  } else if (b.recommendations.length > MAX_LENGTHS.recommendationCount) {
    errors.push({
      code: 'too-many-recommendations',
      message: `recommendations count must be <= ${MAX_LENGTHS.recommendationCount}`,
      path: 'recommendations',
    });
  } else {
    for (const [idx, rec] of (b.recommendations as unknown[]).entries()) {
      const recErrors = validateRecommendation(
        rec as Record<string, unknown>,
        `recommendations[${idx}]`,
      );
      errors.push(...recErrors);
    }
  }

  // Validate assumptions array
  if (b.assumptions !== undefined && !Array.isArray(b.assumptions)) {
    errors.push({
      code: 'invalid-assumptions',
      message: 'assumptions must be an array if provided',
      path: 'assumptions',
    });
  } else if (Array.isArray(b.assumptions) && b.assumptions.length > MAX_LENGTHS.assumptionCount) {
    errors.push({
      code: 'too-many-assumptions',
      message: `assumptions count must be <= ${MAX_LENGTHS.assumptionCount}`,
      path: 'assumptions',
    });
  }

  // Validate blockedBy array
  if (b.blockedBy !== undefined && !Array.isArray(b.blockedBy)) {
    errors.push({
      code: 'invalid-blocked-by',
      message: 'blockedBy must be an array if provided',
      path: 'blockedBy',
    });
  } else if (Array.isArray(b.blockedBy) && b.blockedBy.length > MAX_LENGTHS.capabilityGapCount) {
    errors.push({
      code: 'too-many-blocked-by',
      message: `blockedBy count must be <= ${MAX_LENGTHS.capabilityGapCount}`,
      path: 'blockedBy',
    });
  }

  // Validate requiresHumanDecision array
  if (b.requiresHumanDecision !== undefined && !Array.isArray(b.requiresHumanDecision)) {
    errors.push({
      code: 'invalid-human-decisions',
      message: 'requiresHumanDecision must be an array if provided',
      path: 'requiresHumanDecision',
    });
  } else if (
    Array.isArray(b.requiresHumanDecision) &&
    b.requiresHumanDecision.length > MAX_LENGTHS.humanDecisionCount
  ) {
    errors.push({
      code: 'too-many-human-decisions',
      message: `requiresHumanDecision count must be <= ${MAX_LENGTHS.humanDecisionCount}`,
      path: 'requiresHumanDecision',
    });
  }

  // Validate intelligence
  if (!b.intelligence || typeof b.intelligence !== 'object') {
    errors.push({
      code: 'missing-intelligence',
      message: 'intelligence is required',
      path: 'intelligence',
    });
  }

  // Validate warnings array
  if (b.warnings !== undefined && !Array.isArray(b.warnings)) {
    errors.push({
      code: 'invalid-warnings',
      message: 'warnings must be an array if provided',
      path: 'warnings',
    });
  }

  // Validate meta
  if (!b.meta || typeof b.meta !== 'object') {
    errors.push({ code: 'missing-meta', message: 'meta is required', path: 'meta' });
  } else {
    const meta = b.meta as Record<string, unknown>;
    if (typeof meta.generatedAt !== 'string') {
      errors.push({
        code: 'missing-generated-at',
        message: 'meta.generatedAt is required',
        path: 'meta.generatedAt',
      });
    }
    if (typeof meta.modelAdapter !== 'string') {
      errors.push({
        code: 'missing-model-adapter',
        message: 'meta.modelAdapter is required',
        path: 'meta.modelAdapter',
      });
    }
    if (typeof meta.processingTimeMs !== 'number' || meta.processingTimeMs < 0) {
      errors.push({
        code: 'invalid-processing-time',
        message: 'meta.processingTimeMs must be a non-negative number',
        path: 'meta.processingTimeMs',
      });
    }
  }

  // Check for forbidden patterns in all string fields
  const checkForbiddenInObject = (obj: unknown, path: string): void => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const currentPath = path ? `${path}.${key}` : key;
      if (typeof value === 'string') {
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(value)) {
            errors.push({
              code: 'forbidden-pattern',
              message: `Forbidden pattern in ${currentPath}`,
              path: currentPath,
            });
            break;
          }
        }
      } else if (typeof value === 'object' && value !== null) {
        checkForbiddenInObject(value, currentPath);
      }
    }
  };
  checkForbiddenInObject(b, '');

  return {
    valid: errors.length === 0,
    errors: errors as BriefValidationResult['errors'],
    warnings: warnings as BriefValidationResult['warnings'],
  };
}

/**
 * Validate a single CreativeRecommendationV1
 */
function validateRecommendation(
  rec: Record<string, unknown>,
  path: string,
): BriefValidationResult['errors'] {
  const errors: { code: string; message: string; path?: string }[] = [];

  if (typeof rec.id !== 'string' || rec.id.trim() === '') {
    errors.push({
      code: 'invalid-recommendation-id',
      message: 'id is required',
      path: `${path}.id`,
    });
  } else if (rec.id.length > MAX_LENGTHS.recommendationId) {
    errors.push({
      code: 'recommendation-id-too-long',
      message: `id must be <= ${MAX_LENGTHS.recommendationId} characters`,
      path: `${path}.id`,
    });
  }

  if (
    typeof rec.kind !== 'string' ||
    !RECOMMENDATION_KINDS.includes(rec.kind as RecommendationKind)
  ) {
    errors.push({
      code: 'invalid-recommendation-kind',
      message: `kind must be one of: ${RECOMMENDATION_KINDS.join(', ')}`,
      path: `${path}.kind`,
    });
  }

  if (typeof rec.confidence !== 'string' || !['low', 'medium', 'high'].includes(rec.confidence)) {
    errors.push({
      code: 'invalid-confidence',
      message: 'confidence must be low, medium, or high',
      path: `${path}.confidence`,
    });
  }

  if (!Array.isArray(rec.evidence)) {
    errors.push({
      code: 'invalid-evidence',
      message: 'evidence must be an array',
      path: `${path}.evidence`,
    });
  } else if (rec.evidence.length > MAX_LENGTHS.evidenceRefCount) {
    errors.push({
      code: 'too-much-evidence',
      message: `evidence count must be <= ${MAX_LENGTHS.evidenceRefCount}`,
      path: `${path}.evidence`,
    });
  }

  if (typeof rec.rationale !== 'string' || rec.rationale.trim() === '') {
    errors.push({
      code: 'invalid-rationale',
      message: 'rationale is required',
      path: `${path}.rationale`,
    });
  } else if (rec.rationale.length > MAX_LENGTHS.rationale) {
    errors.push({
      code: 'rationale-too-long',
      message: `rationale must be <= ${MAX_LENGTHS.rationale} characters`,
      path: `${path}.rationale`,
    });
  }

  if (typeof rec.expectedBenefit !== 'string' || rec.expectedBenefit.trim() === '') {
    errors.push({
      code: 'invalid-expected-benefit',
      message: 'expectedBenefit is required',
      path: `${path}.expectedBenefit`,
    });
  } else if (rec.expectedBenefit.length > MAX_LENGTHS.expectedBenefit) {
    errors.push({
      code: 'expected-benefit-too-long',
      message: `expectedBenefit must be <= ${MAX_LENGTHS.expectedBenefit} characters`,
      path: `${path}.expectedBenefit`,
    });
  }

  if (rec.proposedIntent !== undefined && typeof rec.proposedIntent !== 'string') {
    errors.push({
      code: 'invalid-proposed-intent',
      message: 'proposedIntent must be a string if provided',
      path: `${path}.proposedIntent`,
    });
  } else if (
    typeof rec.proposedIntent === 'string' &&
    rec.proposedIntent.length > MAX_LENGTHS.proposedIntent
  ) {
    errors.push({
      code: 'proposed-intent-too-long',
      message: `proposedIntent must be <= ${MAX_LENGTHS.proposedIntent} characters`,
      path: `${path}.proposedIntent`,
    });
  }

  if (
    typeof rec.risk !== 'string' ||
    !['none', 'reversible-local', 'destructive', 'remote-egress', 'spend'].includes(rec.risk)
  ) {
    errors.push({
      code: 'invalid-risk',
      message: 'risk must be a valid risk classification',
      path: `${path}.risk`,
    });
  }

  if (!rec.scope || typeof rec.scope !== 'object') {
    errors.push({ code: 'invalid-scope', message: 'scope is required', path: `${path}.scope` });
  }

  return errors as BriefValidationResult['errors'];
}

// ============================================================================
// Security Validation
// ============================================================================

/**
 * Check if a string contains any forbidden patterns (secrets, paths, URLs, etc.)
 */
export function containsForbiddenPattern(value: string): boolean {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Deep-check an object for any forbidden patterns in string fields
 */
export function deepCheckForbiddenPatterns(obj: unknown): string[] {
  const violations: string[] = [];

  const check = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(value)) {
          violations.push(`${path}: contains forbidden pattern`);
          break;
        }
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        check(value[i], `${path}[${i}]`);
      }
    } else if (value !== null && typeof value === 'object') {
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        check(val, path ? `${path}.${key}` : key);
      }
    }
  };

  check(obj, '');
  return violations;
}

// ==========================================================================
// S3 Orchestration
// ==========================================================================

/**
 * Create a creative brief from snapshot, S2 intelligence, and user request.
 *
 * This is the MAIN S3 orchestration function.
 * It is READ-ONLY: no mutations, no network, no persistence.
 *
 * STEPS:
 * 1. Validate all inputs (snapshot, intelligence, request)
 * 2. Validate snapshot revision parity with request
 * 3. Pass validated inputs to model adapter
 * 4. Validate model output
 * 5. Construct CreativeBriefV1 from adapter output + intelligence
 * 6. Return validated creative brief
 *
 * INVARIANTS:
 * - Pure function: identical inputs produce byte-stable outputs
 * - No side effects: no project mutation, no network, no persistence
 * - No secrets: no paths, URLs, credentials, or object-store references
 * - No commands: no command payloads or mutation instructions
 * - Revision parity: brief is bound to exact snapshot revision
 * - Evidence parity: all recommendations reference valid snapshot evidence
 */
export function createCreativeBrief(
  input: CreativeBriefInputV1,
  adapter: CreativeModelAdapter,
  options: CreativeBriefOptions = {},
): CreativeBriefV1 {
  // Use deterministic clock - NEVER use Date.now() directly
  const clock = getClock(options);

  // We track processing time using the adapter's reported time
  // In a real implementation, this would be measured, but for pure/deterministic
  // behavior in S3, we use the adapter's reported processing time
  // Note: We do NOT use Date.now() - that would break determinism

  // Validate inputs
  const requestValidation = validateCreativeBriefRequest(input.request);
  if (!requestValidation.valid) {
    throw new Error(
      `Invalid creative brief request: ${requestValidation.errors.map((e) => e.message).join('; ')}`,
    );
  }

  // Validate snapshot revision parity
  if (input.snapshot.revisionId !== input.request.snapshotRevisionId) {
    throw new Error(
      `Snapshot revision mismatch: snapshot has ${input.snapshot.revisionId}, request expects ${input.request.snapshotRevisionId}`,
    );
  }

  // Validate project ID parity
  if (input.snapshot.projectId !== input.request.projectId) {
    throw new Error(
      `Project ID mismatch: snapshot has ${input.snapshot.projectId}, request has ${input.request.projectId}`,
    );
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

  // Call model adapter synchronously
  // The adapter interface is synchronous for test-only fake adapter
  // Real adapters would be async and require different orchestration
  let adapterOutput: ModelAdapterOutputV1;
  try {
    adapterOutput = adapter.createBrief(adapterInput);
  } catch (error) {
    throw new Error(
      `Model adapter failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Validate adapter output structure - reject malformed, unsafe, excessive, empty-invalid
  if (!adapterOutput || typeof adapterOutput !== 'object') {
    throw new Error('Model adapter returned invalid output: must be a non-null object');
  }

  // Validate interpretedGoal
  if (!adapterOutput.interpretedGoal || typeof adapterOutput.interpretedGoal !== 'object') {
    throw new Error('Model adapter output missing or invalid interpretedGoal');
  }
  const ig = adapterOutput.interpretedGoal;
  if (typeof ig.userIntent !== 'string' || ig.userIntent.trim() === '') {
    throw new Error('Model adapter output has invalid interpretedGoal.userIntent');
  }
  if (typeof ig.inferredGoal !== 'string' || ig.inferredGoal.trim() === '') {
    throw new Error('Model adapter output has invalid interpretedGoal.inferredGoal');
  }
  if (typeof ig.resolvedGoal !== 'string' || ig.resolvedGoal.trim() === '') {
    throw new Error('Model adapter output has invalid interpretedGoal.resolvedGoal');
  }

  // Validate distinction
  if (!adapterOutput.distinction || typeof adapterOutput.distinction !== 'object') {
    throw new Error('Model adapter output missing or invalid distinction');
  }

  // Validate arrays
  if (!Array.isArray(adapterOutput.recommendations)) {
    throw new Error('Model adapter output recommendations must be an array');
  }
  if (adapterOutput.assumptions !== undefined && !Array.isArray(adapterOutput.assumptions)) {
    throw new Error('Model adapter output assumptions must be an array if provided');
  }
  if (adapterOutput.blockedBy !== undefined && !Array.isArray(adapterOutput.blockedBy)) {
    throw new Error('Model adapter output blockedBy must be an array if provided');
  }
  if (
    adapterOutput.requiresHumanDecision !== undefined &&
    !Array.isArray(adapterOutput.requiresHumanDecision)
  ) {
    throw new Error('Model adapter output requiresHumanDecision must be an array if provided');
  }

  // Check for forbidden patterns in adapter output
  const adapterErrors = deepCheckForbiddenPatterns(adapterOutput);
  if (adapterErrors.length > 0) {
    throw new Error(
      `Model adapter output contains forbidden patterns: ${adapterErrors.join('; ')}`,
    );
  }

  // Use adapter output directly (already properly typed by ModelAdapterOutputV1)
  const output = adapterOutput;

  // Calculate processing time from adapter's meta or use a small deterministic value
  // We don't use Date.now() - the adapter provides its processing time for determinism
  const processingTimeMs = output.meta?.processingTimeMs ?? 10;

  // Build warnings from validation - start with empty array since we validated directly
  const validationWarnings: CreativeBriefV1['warnings'] = [];

  // Verify all evidence references in recommendations point to valid snapshot data
  // Build evidence warnings immutably using reduce
  const evidenceWarnings = output.recommendations.reduce<CreativeBriefV1['warnings']>(
    (acc, rec) => {
      const invalidEvidence = rec.evidence.filter(
        (ev) => !validateEvidenceReference(ev, input.snapshot),
      );
      return [
        ...acc,
        ...invalidEvidence.map((ev) => ({
          code: 'invalid-evidence-reference',
          message: `Recommendation ${rec.id} references invalid evidence: ${ev.id}`,
          severity: 'error' as const,
        })),
      ];
    },
    [],
  );

  // Build the creative brief
  const brief: CreativeBriefV1 = {
    schemaVersion: 1,
    snapshotRevisionId: input.snapshot.revisionId,
    projectId: input.snapshot.projectId,
    request: input.request.request,
    interpretedGoal: {
      userIntent: output.interpretedGoal.userIntent,
      inferredGoal: output.interpretedGoal.inferredGoal,
      resolvedGoal: output.interpretedGoal.resolvedGoal,
      confidence: output.interpretedGoal.confidence,
    },
    distinction: {
      facts: output.distinction.facts,
      inferences: output.distinction.inferences,
    },
    assumptions: output.assumptions,
    recommendations: output.recommendations,
    blockedBy: output.blockedBy,
    requiresHumanDecision: output.requiresHumanDecision,
    intelligence: {
      brand: input.brandReadiness,
      scenes: input.sceneCoverages,
      project: input.projectReadiness,
      rules: input.rules,
    },
    warnings: [...validationWarnings, ...evidenceWarnings],
    meta: {
      generatedAt: clock(),
      modelAdapter: adapter.adapterName,
      processingTimeMs,
    },
  };

  // Final validation of the complete brief
  const finalValidation = validateCreativeBrief(brief);
  if (!finalValidation.valid) {
    throw new Error(
      `Final validation failed: ${finalValidation.errors.map((e) => e.message).join('; ')}`,
    );
  }

  return brief;
}

/**
 * Validate that an evidence reference points to valid snapshot data.
 * This ensures all recommendations reference real evidence from the snapshot.
 */
function validateEvidenceReference(
  ref: EvidenceRefV1,
  snapshot: SemanticProjectSnapshotV1,
): boolean {
  // Check if the reference kind is valid
  const validKinds: EvidenceRefV1['kind'][] = [
    'composition',
    'track',
    'clip',
    'asset',
    'visual-object',
    'caption',
    'marker',
  ];
  if (!validKinds.includes(ref.kind)) {
    return false;
  }

  // Check if the referenced ID exists in the snapshot
  switch (ref.kind) {
    case 'composition':
      // Composition references are valid if they match projectId or other composition-level IDs
      return (
        ref.id === snapshot.projectId ||
        ref.id === snapshot.composition.aspectRatio ||
        ref.id === snapshot.composition.durationUs.toString()
      );

    case 'track':
      // Check if track exists in snapshot
      return (
        snapshot.timeline?.visualRowIds?.includes(ref.id) ||
        snapshot.timeline?.audioRowIds?.includes(ref.id) ||
        ref.id === snapshot.projectId
      );

    case 'clip':
      // Check if clip exists in any scene
      return snapshot.scenes.some((scene) => scene.elements.some((el) => el.id === ref.id));

    case 'asset':
      // Check if asset exists
      return snapshot.assets.some((a) => a.id === ref.id);

    case 'visual-object':
      // Visual objects are referenced by ID in elements
      return snapshot.scenes.some((scene) => scene.elements.some((el) => el.id === ref.id));

    case 'caption':
      // Check caption documents
      return snapshot.scenes.some(
        (scene) => scene.captionCoverage?.locale === ref.id || scene.id === ref.id,
      );

    case 'marker':
      // Scene markers
      return snapshot.scenes.some((scene) => scene.id === ref.id);

    default:
      return false;
  }
}

/**
 * Create a creative brief input from its components.
 * This is a convenience function for building the input object.
 */
export function createCreativeBriefInput(
  snapshot: SemanticProjectSnapshotV1,
  intelligence: {
    brandReadiness: BrandReadinessV1;
    sceneCoverages: readonly SceneCoverageV1[];
    projectReadiness: ProjectReadinessV1;
    rules: readonly IntelligenceRuleV1[];
  },
  request: CreativeBriefRequestV1,
): CreativeBriefInputV1 {
  return {
    snapshot,
    brandReadiness: intelligence.brandReadiness,
    sceneCoverages: intelligence.sceneCoverages,
    projectReadiness: intelligence.projectReadiness,
    rules: intelligence.rules,
    request,
  };
}

// ==========================================================================
// Persian/RTL Support
// ==========================================================================

/**
 * Verify that Persian/RTL content is preserved through the brief.
 * This is a validation helper for tests.
 */
export function verifyPersianPreservation(
  request: CreativeBriefRequestV1,
  brief: CreativeBriefV1,
): boolean {
  // Check that the request text is preserved exactly
  if (request.request !== brief.request) {
    return false;
  }

  // Check that all recommendations with Persian text preserve it
  for (const rec of brief.recommendations) {
    if (containsPersian(rec.rationale) && !rec.rationale.includes(request.request)) {
      // This is a loose check - in practice, we verify byte-for-byte preservation
      // through deterministic tests
      return false;
    }
  }

  return true;
}

/**
 * Check if a string contains Persian (RTL) characters.
 */
export function containsPersian(text: string): boolean {
  // Persian Unicode range: U+0600 to U+06FF (Arabic script includes Persian)
  // Also includes U+200F (Right-to-Left Mark)
  return /[\u0600-\u06FF\u200F]/.test(text);
}
