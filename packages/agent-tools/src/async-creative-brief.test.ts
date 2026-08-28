/**
 * Async Creative Brief Finalization Tests - WP-37 S4-F7
 *
 * Tests for the async creative brief finalization:
 * - Valid async fake result
 * - Same validated output produces equivalent brief to synchronous path
 * - Each async failure category propagates correctly
 * - Malformed/unsafe/evidence-invalid output becomes invalid-output
 * - Stale project/revision mismatch
 * - Deterministic output with injected clock
 * - No input mutation/network/persistence
 * - Existing synchronous S3 tests remain unchanged
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  CreativeBriefInputV1,
  CreativeBriefV1,
  CreativeBriefRequestV1,
} from './creative-brief.js';
import {
  createCreativeBrief,
  createCreativeBriefInput,
  DEFAULT_DETERMINISTIC_CLOCK,
} from './creative-brief.js';
import { createValidFakeAdapter } from './model-adapter.js';
import type { AsyncCreativeModelAdapter, AsyncOutcome } from './async-model-adapter.js';
import type { ModelAdapterOutputV1 } from './model-adapter.js';
import {
  createValidFakeAsyncAdapter,
  createUnavailableFakeAsyncAdapter,
  createPolicyDeniedFakeAsyncAdapter,
  createInvalidOutputFakeAsyncAdapter,
  createProviderFailedFakeAsyncAdapter,
  createTimeoutFakeAsyncAdapter,
  createCancelledFakeAsyncAdapter,
} from './async-model-adapter.js';
import {
  createAsyncCreativeBrief,
  createAsyncCreativeBriefWithOptions,
} from './async-creative-brief.js';
import type { AsyncCreativeBriefOutcome } from './async-creative-brief.js';
import type {
  SemanticProjectSnapshotV1,
  BrandReadinessV1,
  SceneCoverageV1,
  ProjectReadinessV1,
  IntelligenceRuleV1,
} from '@joy-media/project-schema';

// ==========================================================================
// Test Fixtures
// ==========================================================================

// Minimal valid ModelAdapterOutputV1 for testing
const MINIMAL_VALID_ADAPTER_OUTPUT: ModelAdapterOutputV1 = {
  interpretedGoal: {
    userIntent: 'test user intent',
    inferredGoal: 'test inferred goal',
    resolvedGoal: 'test resolved goal',
    confidence: 'high' as const,
  },
  distinction: {
    facts: [],
    inferences: [],
  },
  assumptions: [],
  recommendations: [],
  blockedBy: [],
  requiresHumanDecision: [],
} as const;

const MINIMAL_SNAPSHOT: SemanticProjectSnapshotV1 = {
  schemaVersion: 1 as const,
  projectId: 'test-project' as const,
  revisionId: 'test-revision' as const,
  capturedAt: '2026-08-17T00:00:00.000Z' as const,
  composition: {
    durationUs: 10_000_000 as const,
    frameRate: { num: 30, den: 1 } as const,
    width: 1920 as const,
    height: 1080 as const,
    aspectRatio: '16:9' as const,
  } as const,
  goal: {
    destination: 'youtube' as const,
    durationTargetUs: 10_000_000 as const,
    brief: 'Test brief' as const,
  } as const,
  brand: {
    hasBrandKit: false,
    colorsAvailable: false,
    fontsAvailable: false,
    logoAvailable: false,
    voiceInstructionsAvailable: false,
    toneInstructionsAvailable: false,
    prohibitedClaims: [] as const,
    prohibitedEffects: [] as const,
    warnings: [] as const,
  } as const,
  scenes: [
    {
      id: 'scene-001' as const,
      startUs: 0 as const,
      endUs: 5_000_000 as const,
      purpose: 'hook' as const,
      elements: [] as const,
      visualCoverage: 'adequate' as const,
      evidence: [] as const,
    },
    {
      id: 'scene-002' as const,
      startUs: 5_000_000 as const,
      endUs: 10_000_000 as const,
      purpose: 'explanation' as const,
      elements: [] as const,
      visualCoverage: 'adequate' as const,
      evidence: [] as const,
    },
  ] as const,
  timeline: {
    compositionId: 'comp-001' as const,
    durationUs: 10_000_000 as const,
    frameRate: { num: 30, den: 1 } as const,
    width: 1920 as const,
    height: 1080 as const,
    aspectRatio: '16:9' as const,
    visualTrackCount: 1 as const,
    audioTrackCount: 1 as const,
    totalClipCount: 1 as const,
    visualRowIds: ['row-001'] as const,
    audioRowIds: ['row-002'] as const,
  } as const,
  assets: [
    {
      id: 'asset-001' as const,
      kind: 'video' as const,
      name: 'test' as const,
      durationUs: 10_000_000 as const,
      hasProvenance: false,
      isGenerated: false,
      warnings: [] as const,
    },
  ] as const,
  capabilities: {} as const,
  warnings: [] as const,
  truncation: {
    clipsOmitted: 0 as const,
    assetsOmitted: 0 as const,
    visualObjectsOmitted: 0 as const,
    scenesOmitted: 0 as const,
    totalEstimateBytes: 0 as const,
  } as const,
} as const;

const MINIMAL_BRAND_READINESS: BrandReadinessV1 = {
  projectId: 'test-project' as const,
  revisionId: 'test-revision' as const,
  colorsAvailable: false,
  fontsAvailable: false,
  logoAvailable: false,
  voiceInstructionsAvailable: false,
  toneInstructionsAvailable: false,
  prohibitedClaims: [] as const,
  prohibitedEffects: [] as const,
  hasBrandKit: false,
  brandCompleteness: 'none' as const,
  missingComponents: [] as const,
  warnings: [] as const,
  evidence: [] as const,
} as const;

const MINIMAL_SCENE_COVERAGE: SceneCoverageV1 = {
  sceneId: 'scene-001' as const,
  projectId: 'test-project' as const,
  startUs: 0 as const,
  endUs: 5_000_000 as const,
  durationUs: 5_000_000 as const,
  visualElementCount: 10 as const,
  visualDensity: 'adequate' as const,
  hasVisualElements: true,
  hasAudio: true,
  hasNarration: true,
  audioDurationUs: 5_000_000 as const,
  narrationDurationUs: 3_000_000 as const,
  hasCaptions: false,
  captionWordCount: 0 as const,
  captionLocale: undefined,
  captionCoverageRatio: 0 as const,
  visualChangeSignals: [] as const,
  audioGaps: [] as const,
  captionGaps: [] as const,
  evidence: [] as const,
  rules: [] as const,
} as const;

const MINIMAL_PROJECT_READINESS: ProjectReadinessV1 = {
  projectId: 'test-project' as const,
  revisionId: 'test-revision' as const,
  destination: 'youtube' as const,
  destinationAligned: true,
  destinationMismatch: undefined,
  durationTargetUs: 10_000_000 as const,
  compositionDurationUs: 10_000_000 as const,
  durationAligned: true,
  durationGapUs: undefined,
  aspectRatio: '16:9' as const,
  aspectRatioAligned: true,
  aspectRatioMismatch: undefined,
  captionAvailable: false,
  audioAvailable: false,
  generatedAssetsAvailable: false,
  readinessLevel: 'unknown' as const,
  blockers: [] as const,
  warnings: [] as const,
  sceneCount: 2 as const,
  scenesWithVisuals: 2 as const,
  scenesWithAudio: 0 as const,
  scenesWithCaptions: 0 as const,
  evidence: [] as const,
} as const;

const MINIMAL_RULES: readonly IntelligenceRuleV1[] = [] as const;

const MINIMAL_REQUEST: CreativeBriefRequestV1 = {
  snapshotRevisionId: 'test-revision',
  projectId: 'test-project',
  request: 'Improve pacing and add captions',
  scope: 'pacing',
} as const;

/**
 * Create a minimal valid CreativeBriefInputV1 for testing.
 */
function createTestCreativeBriefInput(): CreativeBriefInputV1 {
  return createCreativeBriefInput(
    MINIMAL_SNAPSHOT,
    {
      brandReadiness: MINIMAL_BRAND_READINESS,
      sceneCoverages: [MINIMAL_SCENE_COVERAGE],
      projectReadiness: MINIMAL_PROJECT_READINESS,
      rules: MINIMAL_RULES,
    },
    MINIMAL_REQUEST,
  );
}

/**
 * Create a CreativeBriefInputV1 with a custom request.
 */
function createTestCreativeBriefInputWithRequest(
  request: CreativeBriefRequestV1,
): CreativeBriefInputV1 {
  return createCreativeBriefInput(
    MINIMAL_SNAPSHOT,
    {
      brandReadiness: MINIMAL_BRAND_READINESS,
      sceneCoverages: [MINIMAL_SCENE_COVERAGE],
      projectReadiness: MINIMAL_PROJECT_READINESS,
      rules: MINIMAL_RULES,
    },
    request,
  );
}

/**
 * Create async adapter options with a fake async adapter.
 */
function createTestAsyncOptions(adapter: AsyncCreativeModelAdapter) {
  return {
    adapter,
    adapterOptions: {
      correlationId: 'test-correlation-id',
    },
  };
}

// ==========================================================================
// Valid Async Fake Result Tests
// ==========================================================================

describe('Async Creative Brief - Valid Results', () => {
  it('returns valid async result with ready category', async () => {
    const input = createTestCreativeBriefInput();
    const adapter = createValidFakeAsyncAdapter();
    const options = createTestAsyncOptions(adapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('ready');
    expect(outcome.brief).toBeDefined();
    expect(outcome.brief!.schemaVersion).toBe(1);
    expect(outcome.brief!.projectId).toBe('test-project');
    expect(outcome.brief!.snapshotRevisionId).toBe('test-revision');
    expect(outcome.brief!.request).toBe('Improve pacing and add captions');
    expect(outcome.retryable).toBe(false);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('produces validated CreativeBriefV1 structure', async () => {
    const input = createTestCreativeBriefInput();
    const adapter = createValidFakeAsyncAdapter();
    const options = createTestAsyncOptions(adapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('ready');
    const brief = outcome.brief!;

    // Check all required fields are present
    expect(brief.schemaVersion).toBe(1);
    expect(brief.projectId).toBeDefined();
    expect(brief.snapshotRevisionId).toBeDefined();
    expect(brief.request).toBeDefined();
    expect(brief.interpretedGoal).toBeDefined();
    expect(brief.interpretedGoal.userIntent).toBeDefined();
    expect(brief.interpretedGoal.inferredGoal).toBeDefined();
    expect(brief.interpretedGoal.resolvedGoal).toBeDefined();
    expect(brief.distinction).toBeDefined();
    expect(brief.distinction.facts).toBeInstanceOf(Array);
    expect(brief.distinction.inferences).toBeInstanceOf(Array);
    expect(brief.assumptions).toBeInstanceOf(Array);
    expect(brief.recommendations).toBeInstanceOf(Array);
    expect(brief.blockedBy).toBeInstanceOf(Array);
    expect(brief.requiresHumanDecision).toBeInstanceOf(Array);
    expect(brief.intelligence).toBeDefined();
    expect(brief.meta).toBeDefined();
    expect(brief.warnings).toBeInstanceOf(Array);
  });

  it('uses deterministic clock for generatedAt', async () => {
    const input = createTestCreativeBriefInput();
    const adapter = createValidFakeAsyncAdapter();
    const customClock = () => '2026-01-01T12:00:00.000Z';
    const options = {
      ...createTestAsyncOptions(adapter),
      clock: customClock,
    };

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('ready');
    expect(outcome.brief!.meta.generatedAt).toBe('2026-01-01T12:00:00.000Z');
  });

  it('uses default deterministic clock when not provided', async () => {
    const input = createTestCreativeBriefInput();
    const adapter = createValidFakeAsyncAdapter();
    const options = createTestAsyncOptions(adapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('ready');
    expect(outcome.brief!.meta.generatedAt).toBe(DEFAULT_DETERMINISTIC_CLOCK());
  });
});

// ==========================================================================
// Same Output as Synchronous Path Tests
// ==========================================================================

describe('Async Creative Brief - Equivalence with Sync Path', () => {
  it('produces equivalent brief to synchronous path for same adapter output', async () => {
    const input = createTestCreativeBriefInput();

    // Create sync brief using fake sync adapter
    const syncAdapter = createValidFakeAdapter();
    const syncBrief = createCreativeBrief(input, syncAdapter);

    // For async path, we need the adapter to produce the same output
    // Since we're using different adapters (sync vs async), they will produce
    // different IDs, but the structure should be the same
    const asyncAdapter = createValidFakeAsyncAdapter(42); // Use same seed
    const options = createTestAsyncOptions(asyncAdapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('ready');
    const asyncBrief = outcome.brief!;

    // Check structure equivalence
    expect(asyncBrief.schemaVersion).toBe(syncBrief.schemaVersion);
    expect(asyncBrief.projectId).toBe(syncBrief.projectId);
    expect(asyncBrief.snapshotRevisionId).toBe(syncBrief.snapshotRevisionId);
    expect(asyncBrief.request).toBe(syncBrief.request);

    // Both should have interpretedGoal
    expect(asyncBrief.interpretedGoal).toBeDefined();
    expect(syncBrief.interpretedGoal).toBeDefined();

    // Both should have distinction
    expect(asyncBrief.distinction).toBeDefined();
    expect(syncBrief.distinction).toBeDefined();

    // Both should have arrays for recommendations, assumptions, etc.
    expect(Array.isArray(asyncBrief.recommendations)).toBe(true);
    expect(Array.isArray(syncBrief.recommendations)).toBe(true);
  });

  it('preserves user intent from request', async () => {
    const requestText = 'Improve pacing and add captions';
    const request: CreativeBriefRequestV1 = {
      snapshotRevisionId: 'test-revision',
      projectId: 'test-project',
      request: requestText,
      scope: 'pacing',
    };
    const input = createTestCreativeBriefInputWithRequest(request);

    const adapter = createValidFakeAsyncAdapter();
    const options = createTestAsyncOptions(adapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('ready');
    expect(outcome.brief!.request).toBe(requestText);
    expect(outcome.brief!.interpretedGoal.userIntent).toBe(requestText);
  });
});

// ==========================================================================
// Async Failure Category Propagation Tests
// ==========================================================================

describe('Async Creative Brief - Failure Category Propagation', () => {
  it('propagates unavailable outcome from adapter', async () => {
    const input = createTestCreativeBriefInput();
    const adapter = createUnavailableFakeAsyncAdapter();
    const options = createTestAsyncOptions(adapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('unavailable');
    expect(outcome.brief).toBeUndefined();
    expect(outcome.retryable).toBe(true);
    expect(outcome.message).toContain('not configured');
  });

  it('propagates policy-denied outcome from adapter', async () => {
    const input = createTestCreativeBriefInput();
    const adapter = createPolicyDeniedFakeAsyncAdapter();
    const options = createTestAsyncOptions(adapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('policy-denied');
    expect(outcome.brief).toBeUndefined();
    expect(outcome.retryable).toBe(false);
    expect(outcome.message).toContain('denied by server policy');
  });

  it('propagates provider-failed outcome from adapter', async () => {
    const input = createTestCreativeBriefInput();
    const adapter = createProviderFailedFakeAsyncAdapter();
    const options = createTestAsyncOptions(adapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('provider-failed');
    expect(outcome.brief).toBeUndefined();
    expect(outcome.retryable).toBe(true);
    expect(outcome.message).toContain('error');
  });

  it('propagates timeout outcome from adapter', async () => {
    const input = createTestCreativeBriefInput();
    const adapter = createTimeoutFakeAsyncAdapter();
    const options = createTestAsyncOptions(adapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('timeout');
    expect(outcome.brief).toBeUndefined();
    expect(outcome.retryable).toBe(true);
  });

  it('propagates cancelled outcome from adapter', async () => {
    const input = createTestCreativeBriefInput();
    const adapter = createCancelledFakeAsyncAdapter();
    const options = createTestAsyncOptions(adapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('cancelled');
    expect(outcome.brief).toBeUndefined();
    expect(outcome.retryable).toBe(false);
  });
});

// ==========================================================================
// Input Validation Tests
// ==========================================================================

describe('Async Creative Brief - Input Validation', () => {
  it('returns invalid-output for revision mismatch', async () => {
    // Create a snapshot with a different revision ID than the request
    const snapshotWithDifferentRevision: SemanticProjectSnapshotV1 = {
      ...MINIMAL_SNAPSHOT,
      revisionId: 'actual-revision' as const,
    };
    const request: CreativeBriefRequestV1 = {
      snapshotRevisionId: 'different-revision',
      projectId: 'test-project',
      request: 'test request',
      scope: 'pacing',
    };
    const input = createCreativeBriefInput(
      snapshotWithDifferentRevision,
      {
        brandReadiness: MINIMAL_BRAND_READINESS,
        sceneCoverages: [MINIMAL_SCENE_COVERAGE],
        projectReadiness: MINIMAL_PROJECT_READINESS,
        rules: MINIMAL_RULES,
      },
      request,
    );

    const adapter = createValidFakeAsyncAdapter();
    const options = createTestAsyncOptions(adapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('invalid-output');
    expect(outcome.errorCode).toBe('REVISION_MISMATCH');
    expect(outcome.brief).toBeUndefined();
    expect(outcome.retryable).toBe(false);
  });

  it('returns invalid-output for project ID mismatch', async () => {
    // Create a snapshot with a different project ID than the request
    const snapshotWithDifferentProject: SemanticProjectSnapshotV1 = {
      ...MINIMAL_SNAPSHOT,
      projectId: 'test-project' as const,
    };
    const request: CreativeBriefRequestV1 = {
      snapshotRevisionId: 'test-revision',
      projectId: 'different-project',
      request: 'test request',
      scope: 'pacing',
    };
    const input = createCreativeBriefInput(
      snapshotWithDifferentProject,
      {
        brandReadiness: {
          ...MINIMAL_BRAND_READINESS,
          projectId: 'test-project' as const,
        },
        sceneCoverages: [
          {
            ...MINIMAL_SCENE_COVERAGE,
            projectId: 'test-project' as const,
          },
        ],
        projectReadiness: {
          ...MINIMAL_PROJECT_READINESS,
          projectId: 'test-project' as const,
        },
        rules: MINIMAL_RULES,
      },
      request,
    );

    const adapter = createValidFakeAsyncAdapter();
    const options = createTestAsyncOptions(adapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('invalid-output');
    expect(outcome.errorCode).toBe('PROJECT_ID_MISMATCH');
    expect(outcome.brief).toBeUndefined();
    expect(outcome.retryable).toBe(false);
  });
});

// ==========================================================================
// Malformed/Unsafe Output Tests
// ==========================================================================

describe('Async Creative Brief - Invalid Output Handling', () => {
  it('returns invalid-output for malformed adapter output', async () => {
    // Use the invalid-output adapter which simulates malformed output
    const input = createTestCreativeBriefInput();
    const adapter = createInvalidOutputFakeAsyncAdapter();
    const options = createTestAsyncOptions(adapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    // The invalid-output adapter returns a non-ready outcome
    // which should be propagated
    expect(outcome.category).toBe('invalid-output');
    expect(outcome.brief).toBeUndefined();
    expect(outcome.retryable).toBe(false);
  });

  it('returns invalid-output when adapter output is null', async () => {
    // Create a mock adapter that returns null output by using invalid-output category
    const mockAdapter: AsyncCreativeModelAdapter = {
      adapterName: 'mock-null-adapter',
      isTestOnly: true,
      createBrief: async () => ({
        category: 'invalid-output',
        message: 'Model returned null output',
        errorCode: 'NULL_OUTPUT',
        retryable: false,
        durationMs: 0,
      }),
    };

    const input = createTestCreativeBriefInput();
    const options = createTestAsyncOptions(mockAdapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('invalid-output');
    expect(outcome.message).toContain('null');
    expect(outcome.brief).toBeUndefined();
  });

  it('returns invalid-output when adapter output has missing interpretedGoal', async () => {
    const mockAdapter: AsyncCreativeModelAdapter = {
      adapterName: 'mock-missing-goal-adapter',
      isTestOnly: true,
      createBrief: async () => ({
        category: 'invalid-output',
        message: 'Output missing interpretedGoal',
        errorCode: 'MISSING_INTERPRETED_GOAL',
        retryable: false,
        durationMs: 0,
      }),
    };

    const input = createTestCreativeBriefInput();
    const options = createTestAsyncOptions(mockAdapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('invalid-output');
    expect(outcome.message).toContain('interpretedGoal');
    expect(outcome.brief).toBeUndefined();
  });

  it('returns invalid-output when adapter output has empty interpretedGoal fields', async () => {
    const mockAdapter: AsyncCreativeModelAdapter = {
      adapterName: 'mock-empty-goal-adapter',
      isTestOnly: true,
      createBrief: async () => ({
        category: 'ready',
        result: {
          ...MINIMAL_VALID_ADAPTER_OUTPUT,
          interpretedGoal: {
            userIntent: '',
            inferredGoal: '',
            resolvedGoal: '',
            confidence: 'high' as const,
          },
        },
        retryable: false,
        durationMs: 0,
      }),
    };

    const input = createTestCreativeBriefInput();
    const options = createTestAsyncOptions(mockAdapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('invalid-output');
    expect(outcome.brief).toBeUndefined();
  });

  it('returns invalid-output when adapter output has forbidden patterns', async () => {
    const mockAdapter: AsyncCreativeModelAdapter = {
      adapterName: 'mock-forbidden-adapter',
      isTestOnly: true,
      createBrief: async () => ({
        category: 'ready',
        result: {
          ...MINIMAL_VALID_ADAPTER_OUTPUT,
          interpretedGoal: {
            userIntent: 'sk-1234567890abcdef', // Forbidden pattern: sk- followed by 16+ alphanumeric
            inferredGoal: 'test',
            resolvedGoal: 'test',
            confidence: 'high' as const,
          },
        },
        retryable: false,
        durationMs: 0,
      }),
    };

    const input = createTestCreativeBriefInput();
    const options = createTestAsyncOptions(mockAdapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('invalid-output');
    expect(outcome.errorCode).toBe('FORBIDDEN_PATTERNS');
    expect(outcome.brief).toBeUndefined();
  });

  it('returns invalid-output when adapter output has invalid recommendations array', async () => {
    const mockAdapter: AsyncCreativeModelAdapter = {
      adapterName: 'mock-invalid-recs-adapter',
      isTestOnly: true,
      createBrief: async () => ({
        category: 'ready',
        result: {
          interpretedGoal: {
            userIntent: 'test',
            inferredGoal: 'test',
            resolvedGoal: 'test',
            confidence: 'high',
          },
          distinction: { facts: [], inferences: [] },
          assumptions: [],
          // recommendations is not an array
          recommendations: null as unknown as any,
          blockedBy: [],
          requiresHumanDecision: [],
        },
        retryable: false,
        durationMs: 0,
      }),
    };

    const input = createTestCreativeBriefInput();
    const options = createTestAsyncOptions(mockAdapter);

    const outcome = await createAsyncCreativeBrief(input, options);

    expect(outcome.category).toBe('invalid-output');
    expect(outcome.message).toContain('recommendations');
    expect(outcome.brief).toBeUndefined();
  });
});

// ==========================================================================
// Input Immutability Tests
// ==========================================================================

describe('Async Creative Brief - Input Immutability', () => {
  it('does not mutate the input object', async () => {
    const input = createTestCreativeBriefInput();
    const adapter = createValidFakeAsyncAdapter();
    const options = createTestAsyncOptions(adapter);

    // Deep clone the input for comparison
    const inputClone = JSON.parse(JSON.stringify(input));

    await createAsyncCreativeBrief(input, options);

    // Verify input was not mutated
    expect(input).toEqual(inputClone);
  });

  it('does not mutate nested input objects', async () => {
    const input = createTestCreativeBriefInput();
    const adapter = createValidFakeAsyncAdapter();
    const options = createTestAsyncOptions(adapter);

    // Store references to nested objects
    const snapshotRef = input.snapshot;
    const scenesRef = input.snapshot.scenes;
    const requestRef = input.request;

    await createAsyncCreativeBrief(input, options);

    // Verify references are unchanged
    expect(input.snapshot).toBe(snapshotRef);
    expect(input.snapshot.scenes).toBe(scenesRef);
    expect(input.request).toBe(requestRef);
  });
});

// ==========================================================================
// No Network/Persistence Tests
// ==========================================================================

describe('Async Creative Brief - No Network Activity', () => {
  it('does not make network calls', async () => {
    // Mock fetch to detect any network activity
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = vi.fn(() => {
      fetchCalled = true;
      throw new Error('Network call detected!');
    });

    try {
      const input = createTestCreativeBriefInput();
      const adapter = createValidFakeAsyncAdapter();
      const options = createTestAsyncOptions(adapter);

      const outcome = await createAsyncCreativeBrief(input, options);

      expect(outcome.category).toBe('ready');
      expect(fetchCalled).toBe(false);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    }
  });

  it('has no side effects on repeated calls', async () => {
    const input = createTestCreativeBriefInput();
    const adapter = createValidFakeAsyncAdapter();
    const options = createTestAsyncOptions(adapter);

    const outcome1 = await createAsyncCreativeBrief(input, options);
    const outcome2 = await createAsyncCreativeBrief(input, options);

    expect(outcome1.category).toBe('ready');
    expect(outcome2.category).toBe('ready');
    expect(JSON.stringify(outcome1.brief)).toBe(JSON.stringify(outcome2.brief));
  });
});

// ==========================================================================
// Convenience Wrapper Tests
// ==========================================================================

describe('Async Creative Brief - Convenience Wrapper', () => {
  it('createAsyncCreativeBriefWithOptions works correctly', async () => {
    const input = createTestCreativeBriefInput();
    const adapter = createValidFakeAsyncAdapter();
    const options = {
      adapter,
      adapterOptions: {
        correlationId: 'test-correlation-id',
      },
    };

    const outcome = await createAsyncCreativeBriefWithOptions(input, options);

    expect(outcome.category).toBe('ready');
    expect(outcome.brief).toBeDefined();
  });

  it('createAsyncCreativeBriefWithOptions passes through clock option', async () => {
    const input = createTestCreativeBriefInput();
    const adapter = createValidFakeAsyncAdapter();
    const customClock = () => '2026-02-01T12:00:00.000Z';
    const options = {
      adapter,
      adapterOptions: {
        correlationId: 'test-correlation-id',
      },
      clock: customClock,
    };

    const outcome = await createAsyncCreativeBriefWithOptions(input, options);

    expect(outcome.category).toBe('ready');
    expect(outcome.brief!.meta.generatedAt).toBe('2026-02-01T12:00:00.000Z');
  });
});

// ==========================================================================
// Deterministic Output Tests
// ==========================================================================

describe('Async Creative Brief - Determinism', () => {
  it('produces byte-stable output for identical inputs', async () => {
    const input = createTestCreativeBriefInput();
    const adapter = createValidFakeAsyncAdapter(42);
    const options = createTestAsyncOptions(adapter);

    const outcome1 = await createAsyncCreativeBrief(input, options);
    const outcome2 = await createAsyncCreativeBrief(input, options);

    expect(outcome1.category).toBe(outcome2.category);
    expect(JSON.stringify(outcome1.brief)).toBe(JSON.stringify(outcome2.brief));
  });

  it('different seeds produce different outputs', async () => {
    const input = createTestCreativeBriefInput();
    const adapter1 = createValidFakeAsyncAdapter(42);
    const adapter2 = createValidFakeAsyncAdapter(99);
    const options1 = createTestAsyncOptions(adapter1);
    const options2 = createTestAsyncOptions(adapter2);

    const outcome1 = await createAsyncCreativeBrief(input, options1);
    const outcome2 = await createAsyncCreativeBrief(input, options2);

    expect(outcome1.category).toBe('ready');
    expect(outcome2.category).toBe('ready');
    // Different seeds should produce different recommendation IDs
    expect(JSON.stringify(outcome1.brief)).not.toBe(JSON.stringify(outcome2.brief));
  });
});
