/**
 * Creative Brief Runtime Tests - WP-37 S4-F8
 *
 * Focused tests for the injectable Creative Brief runtime boundary.
 */

import { describe, it, expect, vi } from 'vitest';
import { UnavailableCreativeBriefRuntime, DEFAULT_CREATIVE_BRIEF_RUNTIME } from './creative-brief-runtime.js';
import type { CreativeBriefRuntime, CreativeBriefRuntimeContext } from './creative-brief-runtime.js';
import type { AsyncCreativeBriefOutcome, AsyncOutcomeCategory, CreativeBriefInputV1 } from '@joy-media/agent-tools';
import type { SemanticProjectSnapshotV1, BrandReadinessV1, SceneCoverageV1, ProjectReadinessV1, IntelligenceRuleV1 } from '@joy-media/project-schema';

const mockCreativeBriefInput: CreativeBriefInputV1 = {
  snapshot: {
    schemaVersion: 1,
    projectId: 'test-project-id',
    revisionId: 'test-revision-id',
    capturedAt: '2026-08-17T00:00:00.000Z',
    composition: { durationUs: 1000000, frameRate: { num: 30, den: 1 }, width: 1920, height: 1080, aspectRatio: '16:9' },
    brand: { hasBrandKit: false, colorsAvailable: false, fontsAvailable: false, logoAvailable: false, voiceInstructionsAvailable: false, toneInstructionsAvailable: false, prohibitedClaims: [], prohibitedEffects: [], warnings: [] },
    scenes: [],
    timeline: { compositionId: 'comp-1', durationUs: 1000000, frameRate: { num: 30, den: 1 }, width: 1920, height: 1080, aspectRatio: '16:9', visualTrackCount: 1, audioTrackCount: 1, totalClipCount: 0, visualRowIds: [], audioRowIds: [] },
    assets: [],
    capabilities: {},
    warnings: [],
    truncation: { clipsOmitted: 0, assetsOmitted: 0, visualObjectsOmitted: 0, scenesOmitted: 0, totalEstimateBytes: 0 },
  },
  brandReadiness: {
    projectId: 'test-project-id',
    revisionId: 'test-revision-id',
    colorsAvailable: false,
    fontsAvailable: false,
    logoAvailable: false,
    voiceInstructionsAvailable: false,
    toneInstructionsAvailable: false,
    prohibitedClaims: [],
    prohibitedEffects: [],
    hasBrandKit: false,
    brandCompleteness: 'none',
    missingComponents: [],
    warnings: [],
    evidence: [],
  },
  sceneCoverages: [],
  projectReadiness: {
    projectId: 'test-project-id',
    revisionId: 'test-revision-id',
    destination: undefined,
    destinationAligned: true,
    destinationMismatch: undefined,
    durationTargetUs: undefined,
    compositionDurationUs: 1000000,
    durationAligned: true,
    durationGapUs: undefined,
    aspectRatio: '16:9',
    aspectRatioAligned: true,
    aspectRatioMismatch: undefined,
    captionAvailable: false,
    audioAvailable: false,
    generatedAssetsAvailable: false,
    readinessLevel: 'unknown',
    blockers: [],
    warnings: [],
    sceneCount: 0,
    scenesWithVisuals: 0,
    scenesWithAudio: 0,
    scenesWithCaptions: 0,
    evidence: [],
  },
  rules: [],
  request: { projectId: 'test-project-id', snapshotRevisionId: 'test-revision-id', request: 'test brief', scope: 'video' },
};

const mockRuntimeContext: CreativeBriefRuntimeContext = {
  correlationId: 'test-correlation-id',
  timeoutMs: 30000,
  spendLimitUsdCents: 1000,
};

function makeOutcome(category: AsyncOutcomeCategory, brief?: any): AsyncCreativeBriefOutcome {
  return {
    category,
    brief,
    message: `Test ${category}`,
    errorCode: category.toUpperCase(),
    retryable: category === 'timeout' || category === 'unavailable',
    durationMs: category === 'ready' ? 100 : 0,
  };
}

describe('UnavailableCreativeBriefRuntime', () => {
  it('should return unavailable outcome', async () => {
    const runtime = new UnavailableCreativeBriefRuntime();
    const outcome = await runtime.execute(mockCreativeBriefInput, mockRuntimeContext);

    expect(outcome.category).toBe('unavailable');
    expect(outcome.errorCode).toBe('RUNTIME_UNAVAILABLE');
    expect(outcome.message).toBe('Creative brief runtime is not configured');
    expect(outcome.retryable).toBe(false);
    expect(outcome.brief).toBeUndefined();
  });

  it('should not make network calls', async () => {
    const runtime = new UnavailableCreativeBriefRuntime();
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = vi.fn(() => {
      fetchCalled = true;
      throw new Error('Unexpected network call');
    });

    try {
      await runtime.execute(mockCreativeBriefInput, mockRuntimeContext);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    }
  });
});

describe('DEFAULT_CREATIVE_BRIEF_RUNTIME', () => {
  it('should be unavailable runtime', () => {
    expect(DEFAULT_CREATIVE_BRIEF_RUNTIME).toBeInstanceOf(UnavailableCreativeBriefRuntime);
  });

  it('should return unavailable', async () => {
    const outcome = await DEFAULT_CREATIVE_BRIEF_RUNTIME.execute(
      mockCreativeBriefInput,
      mockRuntimeContext,
    );
    expect(outcome.category).toBe('unavailable');
  });
});

describe('CreativeBriefRuntime contract', () => {
  it('should have execute method', async () => {
    const runtime: CreativeBriefRuntime = {
      execute: vi.fn().mockResolvedValue(makeOutcome('ready')),
    };
    expect(typeof runtime.execute).toBe('function');
  });

  it('should return Promise of AsyncCreativeBriefOutcome', async () => {
    const runtime: CreativeBriefRuntime = {
      execute: vi.fn().mockResolvedValue(makeOutcome('ready')),
    };

    const result = runtime.execute(mockCreativeBriefInput, mockRuntimeContext);
    expect(result).toBeInstanceOf(Promise);

    const outcome = await result;
    expect(outcome).toHaveProperty('category');
    expect(outcome).toHaveProperty('retryable');
    expect(outcome).toHaveProperty('durationMs');
  });

  it('should propagate all failure categories', async () => {
    const categories: AsyncOutcomeCategory[] = [
      'unavailable', 'policy-denied', 'invalid-output',
      'provider-failed', 'timeout', 'cancelled',
    ];

    for (const category of categories) {
      const runtime: CreativeBriefRuntime = {
        execute: vi.fn().mockResolvedValue(makeOutcome(category)),
      };
      const outcome = await runtime.execute(mockCreativeBriefInput, mockRuntimeContext);
      expect(outcome.category).toBe(category);
    }
  });

  it('should receive input and context', async () => {
    let receivedInput: any;
    let receivedContext: any;
    const runtime: CreativeBriefRuntime = {
      execute: vi.fn().mockImplementation((input, ctx) => {
        receivedInput = input;
        receivedContext = ctx;
        return Promise.resolve(makeOutcome('ready'));
      }),
    };

    await runtime.execute(mockCreativeBriefInput, mockRuntimeContext);

    expect(receivedInput).toEqual(mockCreativeBriefInput);
    expect(receivedContext).toEqual(mockRuntimeContext);
  });
});
