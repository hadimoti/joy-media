/**
 * Model Adapter Interface and Deterministic Fake Adapter - WP-37 S3
 *
 * Provides a strict boundary between S3 orchestration and model implementations.
 * The fake adapter is synchronous, deterministic, and test-only.
 * No network, no real provider, no credentials, no timeouts.
 */

import type {
  SemanticProjectSnapshotV1,
  EvidenceRefV1,
  SceneSummaryV1,
} from '@joy-media/project-schema';

import type {
  BrandReadinessV1,
  SceneCoverageV1,
  ProjectReadinessV1,
  IntelligenceRuleV1,
  IntelligenceEvidenceRefV1,
} from '@joy-media/project-schema';

import type {
  CreativeBriefRequestV1,
  InferenceConfidence,
  RecommendationRisk,
  RecommendationKind,
  CreativeEvidenceRefV1,
} from './creative-brief.js';

// ==========================================================================
// Model Adapter Types
// ==========================================================================

/**
 * Input to the model adapter.
 * Contains ONLY bounded, validated data from S1/S2 and the user request.
 * No DOM, no raw project objects, no paths, no URLs, no secrets, no command payloads.
 */
export interface ModelAdapterInputV1 {
  readonly snapshot: SemanticProjectSnapshotV1;
  readonly brandReadiness: BrandReadinessV1;
  readonly sceneCoverages: readonly SceneCoverageV1[];
  readonly projectReadiness: ProjectReadinessV1;
  readonly rules: readonly IntelligenceRuleV1[];
  readonly request: CreativeBriefRequestV1;
}

/**
 * Output from the model adapter.
 * This is the raw model response that will be validated and wrapped into CreativeBriefV1.
 */
export interface ModelAdapterOutputV1 {
  readonly interpretedGoal: {
    readonly userIntent: string;
    readonly inferredGoal: string;
    readonly resolvedGoal: string;
    readonly confidence: InferenceConfidence;
  };
  readonly distinction: {
    readonly facts: readonly {
      readonly id: string;
      readonly statement: string;
      readonly source: 's1' | 's2' | 'snapshot';
      readonly evidence: readonly EvidenceRefV1[];
    }[];
    readonly inferences: readonly {
      readonly id: string;
      readonly statement: string;
      readonly confidence: InferenceConfidence;
      readonly rationale: string;
      readonly evidence: readonly CreativeEvidenceRefV1[];
    }[];
  };
  readonly assumptions: readonly {
    readonly id: string;
    readonly statement: string;
    readonly confidence: InferenceConfidence;
    readonly evidence: readonly CreativeEvidenceRefV1[];
    readonly verified: boolean;
  }[];
  readonly recommendations: readonly {
    readonly id: string;
    readonly kind: RecommendationKind;
    readonly confidence: InferenceConfidence;
    readonly evidence: readonly CreativeEvidenceRefV1[];
    readonly rationale: string;
    readonly expectedBenefit: string;
    readonly proposedIntent?: string;
    readonly risk: RecommendationRisk;
    readonly scope: {
      readonly sceneIds?: readonly string[];
      readonly startUs?: number;
      readonly endUs?: number;
      readonly elementIds?: readonly string[];
    };
  }[];
  readonly blockedBy: readonly {
    readonly id: string;
    readonly capability: string;
    readonly status: 'setup-required' | 'unavailable' | 'unknown';
    readonly message: string;
    readonly evidence: readonly CreativeEvidenceRefV1[];
  }[];
  readonly requiresHumanDecision: readonly {
    readonly id: string;
    readonly question: string;
    readonly context: string;
    readonly options: readonly string[];
    readonly evidence: readonly CreativeEvidenceRefV1[];
  }[];
  /** Processing time in ms (for deterministic fake adapter, this is injected) */
  readonly meta?: {
    readonly processingTimeMs?: number;
  };
}

/**
 * Model adapter interface.
 * Implementations MUST be pure functions with no side effects.
 *
 * Key requirements:
 * - Synchronous for test-only fake adapter (S3 uses sync orchestration)
 * - Accepts only ModelAdapterInputV1
 * - Returns only ModelAdapterOutputV1
 * - No network, no persistence, no real model calls in fake mode
 * - Deterministic: identical inputs produce byte-stable outputs
 */
export interface CreativeModelAdapter {
  /**
   * Unique name for this adapter (e.g., 'fake-v1', 'fake-malformed', 'fake-unsafe')
   */
  readonly adapterName: string;

  /**
   * Whether this adapter is for test purposes only.
   * Real adapters would be async and require provider configuration.
   */
  readonly isTestOnly: boolean;

  /**
   * Create a creative brief from the input.
   * MUST be synchronous for fake adapter compatibility.
   * MUST be pure: no side effects, no external state access.
   */
  createBrief(input: ModelAdapterInputV1): ModelAdapterOutputV1;
}

// ==========================================================================
// Fake Adapter Types
// ==========================================================================

/** Mode for the fake adapter to produce different types of output */
export type FakeAdapterMode =
  | 'valid'              // Well-formed, deterministic output
  | 'malformed'          // Intentionally invalid output (missing fields, wrong types)
  | 'unsafe'             // Output with forbidden patterns (secrets, paths, URLs)
  | 'excessive'          // Oversized arrays/strings to test boundary validation
  | 'empty'              // Minimal/empty brief
  | 'failure';           // Throws an error

/** Configuration for creating a fake adapter */
export interface FakeAdapterConfig {
  /** The mode this adapter should operate in */
  readonly mode: FakeAdapterMode;
  /** Seed for deterministic ID generation */
  readonly seed?: number;
  /** Fixed clock value for deterministic timestamps (ISO string) */
  readonly clockValue?: string;
  /** Processing time override */
  readonly processingTimeMs?: number;
}

/** Default configuration for valid mode */
const DEFAULT_VALID_CONFIG: FakeAdapterConfig = {
  mode: 'valid',
  seed: 42,
  clockValue: '2026-08-17T00:00:00.000Z',
  processingTimeMs: 10,
};

/**
 * Deterministic ID generator using seed.
 * Produces stable IDs for the same seed and index.
 */
function generateDeterministicId(seed: number, prefix: string, index: number): string {
  // Simple deterministic hash based on seed and index
  const combined = `${seed}-${prefix}-${index}`;
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    hash = (hash << 5) - hash + combined.charCodeAt(i);
    hash |= 0; // Convert to 32-bit integer
  }
  // Take first 8 chars of hash in hex, combined with prefix
  const hashStr = Math.abs(hash).toString(16).padStart(8, '0').substring(0, 8);
  return `${prefix}-${hashStr}-${index}`;
}

/**
 * Extract evidence references from S1/S2 data for use in fake adapter output.
 * Only references valid, canonical evidence from the snapshot.
 */
function extractValidEvidence(
  snapshot: SemanticProjectSnapshotV1,
  sceneCoverages: readonly SceneCoverageV1[],
  rules: readonly IntelligenceRuleV1[],
  count: number = 3,
): readonly EvidenceRefV1[] {
  const evidence: EvidenceRefV1[] = [];

  // Add composition evidence
  if (evidence.length < count && snapshot.composition) {
    evidence.push({
      id: snapshot.composition.aspectRatio,
      kind: 'composition',
    });
  }

  // Add scene evidence
  for (const scene of snapshot.scenes) {
    if (evidence.length >= count) break;
    evidence.push({
      id: scene.id,
      kind: 'marker',
      startUs: scene.startUs,
      endUs: scene.endUs,
    });
  }

  // Add asset evidence if available
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
 * Map evidence refs to CreativeEvidenceRefV1 (adds optional detail and s3Detail fields)
 */
function toCreativeEvidence(
  refs: readonly EvidenceRefV1[],
  s3Detail?: string,
): readonly CreativeEvidenceRefV1[] {
  return refs.map(ref => ({
    ...ref,
    detail: s3Detail,
    s3Detail,
  })) as readonly CreativeEvidenceRefV1[];
}

// ==========================================================================
// Fake Adapter Implementation
// ==========================================================================

/**
 * Base fake adapter that can be configured for different modes.
 * All implementations are synchronous, deterministic, and pure.
 */
class BaseFakeModelAdapter implements CreativeModelAdapter {
  readonly adapterName: string;
  readonly isTestOnly = true;
  private readonly config: FakeAdapterConfig;

  constructor(name: string, config: FakeAdapterConfig) {
    this.adapterName = name;
    this.config = config;
  }

  createBrief(input: ModelAdapterInputV1): ModelAdapterOutputV1 {
    switch (this.config.mode) {
      case 'valid':
        return this.createValidBrief(input);
      case 'malformed':
        return this.createMalformedBrief(input);
      case 'unsafe':
        return this.createUnsafeBrief(input);
      case 'excessive':
        return this.createExcessiveBrief(input);
      case 'empty':
        return this.createEmptyBrief(input);
      case 'failure':
        throw new Error('Fake adapter failure mode: model unavailable');
      default:
        // Should never happen, but return valid as fallback
        return this.createValidBrief(input);
    }
  }

  /**
   * Create a valid, well-formed deterministic brief.
   * Uses snapshot data to generate realistic, bounded recommendations.
   */
  private createValidBrief(input: ModelAdapterInputV1): ModelAdapterOutputV1 {
    const seed = this.config.seed ?? 42;
    const evidence = extractValidEvidence(
      input.snapshot,
      input.sceneCoverages,
      input.rules,
      5,
    );

    const sceneIds = input.snapshot.scenes.map(s => s.id);
    const primarySceneId = sceneIds[0] ?? 'unknown';
    const allSceneIds: readonly string[] | undefined = sceneIds.length > 0 ? sceneIds : undefined;

    // Generate deterministic recommendations based on snapshot analysis
    const recommendations: Array<{
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
    }> = [];

    // Pacing recommendation
    if (input.snapshot.scenes.length > 1) {
      recommendations.push({
        id: generateDeterministicId(seed, 'pacing', 0),
        kind: 'pacing',
        confidence: 'high' as const,
        evidence: toCreativeEvidence(evidence.slice(0, 2), 'pacing-analysis'),
        rationale: 'Scene transitions could benefit from tighter pacing to maintain viewer engagement',
        expectedBenefit: 'Improved viewer retention through optimized scene timing',
        proposedIntent: 'adjust-scene-pacing',
        risk: 'reversible-local' as const,
        scope: {
          ...(allSceneIds !== undefined && { sceneIds: allSceneIds }),
          ...(input.snapshot.scenes[0]?.startUs !== undefined && { startUs: input.snapshot.scenes[0]!.startUs }),
          ...(input.snapshot.scenes[input.snapshot.scenes.length - 1]?.endUs !== undefined && { endUs: input.snapshot.scenes[input.snapshot.scenes.length - 1]!.endUs }),
        } as ModelAdapterOutputV1['recommendations'][number]['scope'],
      });
    }

    // Caption recommendation
    if (input.sceneCoverages.some(s => !s.hasCaptions)) {
      recommendations.push({
        id: generateDeterministicId(seed, 'caption', 0),
        kind: 'caption',
        confidence: 'medium' as const,
        evidence: toCreativeEvidence(evidence.slice(0, 2), 'caption-analysis'),
        rationale: 'Some scenes lack captions which could improve accessibility and SEO',
        expectedBenefit: 'Increased accessibility and searchability',
        proposedIntent: 'add-caption-track',
        risk: 'reversible-local' as const,
        scope: {
          sceneIds,
        },
      });
    }

    // Visual coverage recommendation
    if (input.sceneCoverages.some(s => s.visualDensity === 'sparse' || s.visualDensity === 'none')) {
      recommendations.push({
        id: generateDeterministicId(seed, 'visual-coverage', 0),
        kind: 'visual-coverage',
        confidence: 'medium' as const,
        evidence: toCreativeEvidence(evidence.slice(0, 2), 'visual-coverage-analysis'),
        rationale: 'Some scenes have sparse or no visual coverage which may reduce viewer engagement',
        expectedBenefit: 'Enhanced visual interest and information density',
        proposedIntent: 'add-visual-broll',
        risk: 'reversible-local' as const,
        scope: {
          sceneIds,
        },
      });
    }

    // Brand alignment recommendation
    if (!input.brandReadiness.hasBrandKit) {
      recommendations.push({
        id: generateDeterministicId(seed, 'brand', 0),
        kind: 'brand',
        confidence: 'low' as const,
        evidence: toCreativeEvidence(evidence.slice(0, 2), 'brand-analysis'),
        rationale: 'Project lacks complete brand kit which may affect brand consistency',
        expectedBenefit: 'Stronger brand presence and recognition',
        proposedIntent: 'setup-brand-kit',
        risk: 'none' as const,
        scope: {},
      });
    }

    // Generate assumptions
    const assumptions = [
      {
        id: generateDeterministicId(seed, 'assumption', 0),
        statement: 'User wants to improve project quality for social media distribution',
        confidence: 'high' as const,
        evidence: toCreativeEvidence(evidence.slice(0, 1)),
        verified: true,
      },
    ];

    // If destination is specified, add assumption about it
    if (input.request.destination) {
      assumptions.push({
        id: generateDeterministicId(seed, 'assumption', 1),
        statement: `Target destination is ${input.request.destination} with its specific requirements`,
        confidence: 'high' as const,
        evidence: toCreativeEvidence(evidence.slice(0, 1)),
        verified: true,
      });
    }

    // Generate facts from S1/S2
    const facts = [] as Array<{
      id: string;
      statement: string;
      source: 's1' | 's2' | 'snapshot';
      evidence: readonly EvidenceRefV1[];
    }>;

    facts.push({
      id: generateDeterministicId(seed, 'fact', 0),
      statement: `Project has ${input.snapshot.scenes.length} scenes with total duration of ${input.snapshot.composition.durationUs} microseconds`,
      source: 's1' as const,
      evidence: evidence.slice(0, 1),
    });

    facts.push({
      id: generateDeterministicId(seed, 'fact', 1),
      statement: `Project aspect ratio is ${input.snapshot.composition.aspectRatio}`,
      source: 's1' as const,
      evidence: evidence.slice(0, 1),
    });

    // Add brand facts if available
    if (input.brandReadiness.hasBrandKit) {
      facts.push({
        id: generateDeterministicId(seed, 'fact', 2),
        statement: 'Project has brand kit configured',
        source: 's2' as const,
        evidence: evidence.slice(0, 1),
      });
    }

    // Generate inferences
    const inferences = [] as Array<{
      id: string;
      statement: string;
      confidence: InferenceConfidence;
      rationale: string;
      evidence: readonly CreativeEvidenceRefV1[];
    }>;

    inferences.push({
      id: generateDeterministicId(seed, 'inference', 0),
      statement: 'Project would benefit from additional visual elements',
      confidence: 'medium' as const,
      rationale: 'Based on scene coverage analysis showing sparse visual coverage',
      evidence: toCreativeEvidence(evidence.slice(0, 2)),
    });

    // Generate blockedBy from rules
    const blockedBy = [] as Array<{
      id: string;
      capability: string;
      status: 'setup-required' | 'unavailable' | 'unknown';
      message: string;
      evidence: readonly CreativeEvidenceRefV1[];
    }>;
    for (const rule of input.rules) {
      if (rule.severity === 'error') {
        blockedBy.push({
          id: generateDeterministicId(seed, 'blocker', blockedBy.length),
          capability: rule.ruleId,
          status: 'unavailable' as const,
          message: rule.message,
          evidence: toCreativeEvidence(rule.evidence),
        });
      }
    }

    // Generate human decisions if there are warnings or setup-required capabilities
    const requiresHumanDecision = [] as Array<{
      id: string;
      question: string;
      context: string;
      options: readonly string[];
      evidence: readonly CreativeEvidenceRefV1[];
    }>;

    // Check for missing brand components
    if (!input.brandReadiness.hasBrandKit) {
      requiresHumanDecision.push({
        id: generateDeterministicId(seed, 'decision', 0),
        question: 'Should we set up a brand kit for this project?',
        context: 'Brand kit is missing which may affect visual consistency',
        options: ['Yes, set up brand kit', 'No, continue without brand kit', 'Later'],
        evidence: toCreativeEvidence(evidence.slice(0, 1)),
      });
    }

    return {
      interpretedGoal: {
        userIntent: input.request.request,
        inferredGoal: `Improve ${input.request.scope} quality of the project`,
        resolvedGoal: `Generate actionable recommendations to enhance ${input.request.scope} within project constraints`,
        confidence: 'high' as const,
      },
      distinction: {
        facts,
        inferences,
      },
      assumptions,
      recommendations,
      blockedBy,
      requiresHumanDecision,
      meta: {
        processingTimeMs: this.config.processingTimeMs ?? 10,
      },
    };
  }

  /**
   * Create malformed output with intentional errors for testing validation.
   */
  private createMalformedBrief(_input: ModelAdapterInputV1): ModelAdapterOutputV1 {
    // Return intentionally malformed data
    return {
      // Missing interpretedGoal - will fail validation
      interpretedGoal: {
        userIntent: '',
        inferredGoal: '',
        resolvedGoal: '',
        confidence: 'high' as const,
      },
      distinction: {
        facts: [
          {
            id: '', // Empty ID
            statement: 'This is a malformed fact',
            source: 's1' as const,
            evidence: [],
          },
        ],
        inferences: [],
      },
      assumptions: [],
      recommendations: [
        {
          id: '', // Empty ID - invalid
          kind: 'invalid-kind' as RecommendationKind, // Invalid kind
          confidence: 'invalid-confidence' as InferenceConfidence, // Invalid confidence
          evidence: [],
          rationale: '', // Empty rationale - invalid
          expectedBenefit: '', // Empty expected benefit - invalid
          proposedIntent: 'some-intent',
          risk: 'invalid-risk' as RecommendationRisk, // Invalid risk
          scope: {},
        },
      ],
      blockedBy: [],
      requiresHumanDecision: [],
    };
  }

  /**
   * Create unsafe output with forbidden patterns for security testing.
   */
  private createUnsafeBrief(_input: ModelAdapterInputV1): ModelAdapterOutputV1 {
    return {
      interpretedGoal: {
        userIntent: 'sk-1234567890abcdef', // Secret in user intent
        inferredGoal: 'Access token: pk-1234567890', // Another secret
        resolvedGoal: 'https://api.example.com/secret', // URL in resolved goal
        confidence: 'high' as const,
      },
      distinction: {
        facts: [
          {
            id: 'fact-1',
            statement: 'Path is C:\\Users\\secret\\file.txt', // Windows path
            source: 's1' as const,
            evidence: [],
          },
        ],
        inferences: [
          {
            id: 'inference-1',
            statement: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', // Bearer token
            confidence: 'high' as const,
            rationale: 's3://bucket/secret-file', // S3 URL
            evidence: [],
          },
        ],
      },
      assumptions: [
        {
          id: 'assumption-1',
          statement: 'API key is openrouter-sk-12345', // Provider key
          confidence: 'high' as const,
          evidence: [],
          verified: false,
        },
      ],
      recommendations: [
        {
          id: 'rec-1',
          kind: 'pacing',
          confidence: 'high' as const,
          evidence: [],
          rationale: 'Password is hunter2', // Password
          expectedBenefit: 'Credential found: sk-abc123', // Secret
          proposedIntent: 'exec: rm -rf /', // Command injection
          risk: 'none' as const,
          scope: {},
        },
      ],
      blockedBy: [],
      requiresHumanDecision: [],
    };
  }

  /**
   * Create excessive output with oversized arrays/strings for boundary testing.
   */
  private createExcessiveBrief(_input: ModelAdapterInputV1): ModelAdapterOutputV1 {
    const seed = this.config.seed ?? 42;

    // Create oversized arrays
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
    for (let i = 0; i < 25; i++) { // More than max of 20
      recommendations.push({
        id: generateDeterministicId(seed, 'rec', i),
        kind: 'pacing',
        confidence: 'high' as const,
        evidence: [],
        // Very long rationale - exceeds max of 500
        rationale: 'A'.repeat(600),
        // Very long expected benefit - exceeds max of 500
        expectedBenefit: 'B'.repeat(600),
        proposedIntent: 'C'.repeat(300), // Exceeds max of 200
        risk: 'none' as const,
        scope: {},
      });
    }

    const assumptions = [] as Array<{
      id: string;
      statement: string;
      confidence: InferenceConfidence;
      evidence: readonly CreativeEvidenceRefV1[];
      verified: boolean;
    }>;
    for (let i = 0; i < 15; i++) { // More than max of 10
      assumptions.push({
        id: generateDeterministicId(seed, 'assumption', i),
        statement: 'D'.repeat(600), // Exceeds max of 500
        confidence: 'high' as const,
        evidence: [],
        verified: false,
      });
    }

    const blockedBy = [] as Array<{
      id: string;
      capability: string;
      status: 'setup-required' | 'unavailable' | 'unknown';
      message: string;
      evidence: readonly CreativeEvidenceRefV1[];
    }>;
    for (let i = 0; i < 15; i++) { // More than max of 10
      blockedBy.push({
        id: generateDeterministicId(seed, 'blocker', i),
        capability: 'E'.repeat(150), // Exceeds max of 100
        status: 'unavailable' as const,
        message: 'F'.repeat(600),
        evidence: [],
      });
    }

    const humanDecisions = [] as Array<{
      id: string;
      question: string;
      context: string;
      options: readonly string[];
      evidence: readonly CreativeEvidenceRefV1[];
    }>;
    for (let i = 0; i < 15; i++) { // More than max of 10
      humanDecisions.push({
        id: generateDeterministicId(seed, 'decision', i),
        question: 'G'.repeat(600), // Exceeds max of 500
        context: 'H'.repeat(1100), // Exceeds max of 1000
        options: ['I'.repeat(300), 'J'.repeat(300), 'K'.repeat(300)],
        evidence: [],
      });
    }

    return {
      interpretedGoal: {
        userIntent: 'A'.repeat(2100), // Exceeds max request length
        inferredGoal: 'B'.repeat(600),
        resolvedGoal: 'C'.repeat(600),
        confidence: 'high' as const,
      },
      distinction: {
        facts: [],
        inferences: [],
      },
      assumptions,
      recommendations,
      blockedBy,
      requiresHumanDecision: humanDecisions,
    };
  }

  /**
   * Create minimal/empty brief for testing empty state handling.
   */
  private createEmptyBrief(_input: ModelAdapterInputV1): ModelAdapterOutputV1 {
    return {
      interpretedGoal: {
        userIntent: _input.request.request,
        inferredGoal: '',
        resolvedGoal: '',
        confidence: 'low' as const,
      },
      distinction: {
        facts: [],
        inferences: [],
      },
      assumptions: [],
      recommendations: [],
      blockedBy: [],
      requiresHumanDecision: [],
    };
  }
}

// ==========================================================================
// Factory Functions
// ==========================================================================

/**
 * Create a fake model adapter with the specified configuration.
 * The adapter is synchronous, deterministic, and pure.
 *
 * @param config - Configuration for the fake adapter mode
 * @returns A CreativeModelAdapter instance
 */
export function createFakeModelAdapter(
  config: FakeAdapterConfig = DEFAULT_VALID_CONFIG,
): CreativeModelAdapter {
  const name = `fake-${config.mode}-v1`;
  return new BaseFakeModelAdapter(name, config);
}

/**
 * Create a valid fake adapter (default mode).
 * This produces well-formed, deterministic creative briefs.
 */
export function createValidFakeAdapter(
  seed: number = 42,
): CreativeModelAdapter {
  return createFakeModelAdapter({
    mode: 'valid',
    seed,
    clockValue: '2026-08-17T00:00:00.000Z',
    processingTimeMs: 10,
  });
}

/**
 * Create a malformed fake adapter for testing validation.
 */
export function createMalformedFakeAdapter(): CreativeModelAdapter {
  return createFakeModelAdapter({ mode: 'malformed' });
}

/**
 * Create an unsafe fake adapter for testing security validation.
 */
export function createUnsafeFakeAdapter(): CreativeModelAdapter {
  return createFakeModelAdapter({ mode: 'unsafe' });
}

/**
 * Create an excessive fake adapter for testing boundary validation.
 */
export function createExcessiveFakeAdapter(): CreativeModelAdapter {
  return createFakeModelAdapter({ mode: 'excessive' });
}

/**
 * Create an empty fake adapter for testing empty state handling.
 */
export function createEmptyFakeAdapter(): CreativeModelAdapter {
  return createFakeModelAdapter({ mode: 'empty' });
}

/**
 * Create a failure fake adapter that throws an error.
 */
export function createFailureFakeAdapter(): CreativeModelAdapter {
  return createFakeModelAdapter({ mode: 'failure' });
}

/**
 * Default configuration for fake adapter (valid mode).
 */
export const DEFAULT_FAKE_CONFIG: FakeAdapterConfig = DEFAULT_VALID_CONFIG;

// ==========================================================================
// Type Guards
// ==========================================================================

/**
 * Type guard to check if an unknown value is a ModelAdapterInputV1.
 */
export function isModelAdapterInputV1(value: unknown): value is ModelAdapterInputV1 {
  if (!value || typeof value !== 'object') return false;

  const input = value as Record<string, unknown>;

  return (
    typeof input.snapshot === 'object' && input.snapshot !== null &&
    typeof input.brandReadiness === 'object' && input.brandReadiness !== null &&
    Array.isArray(input.sceneCoverages) &&
    typeof input.projectReadiness === 'object' && input.projectReadiness !== null &&
    Array.isArray(input.rules) &&
    typeof input.request === 'object' && input.request !== null
  );
}

/**
 * Type guard to check if an unknown value is a ModelAdapterOutputV1.
 */
export function isModelAdapterOutputV1(value: unknown): value is ModelAdapterOutputV1 {
  if (!value || typeof value !== 'object') return false;

  const output = value as Record<string, unknown>;

  return (
    typeof output.interpretedGoal === 'object' && output.interpretedGoal !== null &&
    typeof output.distinction === 'object' && output.distinction !== null &&
    Array.isArray(output.assumptions) &&
    Array.isArray(output.recommendations) &&
    Array.isArray(output.blockedBy) &&
    Array.isArray(output.requiresHumanDecision)
  );
}
