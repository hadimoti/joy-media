/**
 * Model Adapter Tests - WP-37 S3
 *
 * Tests for the deterministic fake model adapter.
 * Proves: deterministic output, no network, no async, all modes work.
 */

import { describe, it, expect } from 'vitest';

import type { SemanticProjectSnapshotV1 } from '@joy-media/project-schema';
import type {
  BrandReadinessV1,
  SceneCoverageV1,
  ProjectReadinessV1,
  IntelligenceRuleV1,
} from '@joy-media/project-schema';

import {
  createFakeModelAdapter,
  createValidFakeAdapter,
  createMalformedFakeAdapter,
  createUnsafeFakeAdapter,
  createExcessiveFakeAdapter,
  createEmptyFakeAdapter,
  createFailureFakeAdapter,
} from './model-adapter.js';

// Minimal valid test fixtures using satisfies
const MINIMAL_SNAPSHOT = {
  schemaVersion: 1 as const,
  projectId: 'test-project' as const,
  revisionId: 'rev-001' as const,
  capturedAt: '2026-08-17T00:00:00.000Z',
  composition: {
    durationUs: 10_000_000 as const,
    frameRate: { num: 30, den: 1 } as const,
    width: 1920 as const,
    height: 1080 as const,
    aspectRatio: '16:9' as const,
  },
  goal: {
    destination: 'youtube' as const,
    durationTargetUs: 10_000_000 as const,
    brief: 'Test brief',
  },
  brand: {
    hasBrandKit: false,
    colorsAvailable: false,
    fontsAvailable: false,
    logoAvailable: false,
    voiceInstructionsAvailable: false,
    toneInstructionsAvailable: false,
    prohibitedClaims: [],
    prohibitedEffects: [],
    warnings: [],
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
} satisfies SemanticProjectSnapshotV1;

const MINIMAL_BRAND_READINESS = {
  projectId: 'test-project' as const,
  revisionId: 'rev-001' as const,
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
} satisfies BrandReadinessV1;

const MINIMAL_SCENE_COVERAGE = {
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
} satisfies SceneCoverageV1;

const MINIMAL_PROJECT_READINESS = {
  projectId: 'test-project' as const,
  revisionId: 'rev-001' as const,
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
  sceneCount: 1 as const,
  scenesWithVisuals: 1 as const,
  scenesWithAudio: 0 as const,
  scenesWithCaptions: 0 as const,
  evidence: [] as const,
} satisfies ProjectReadinessV1;

const MINIMAL_RULES: readonly IntelligenceRuleV1[] = [];

const MINIMAL_REQUEST = {
  snapshotRevisionId: 'rev-001',
  projectId: 'test-project',
  request: 'Improve the pacing of my video',
  scope: 'pacing' as const,
} as const;

function createInput() {
  return {
    snapshot: MINIMAL_SNAPSHOT,
    brandReadiness: MINIMAL_BRAND_READINESS,
    sceneCoverages: [MINIMAL_SCENE_COVERAGE] as const,
    projectReadiness: MINIMAL_PROJECT_READINESS,
    rules: MINIMAL_RULES,
    request: MINIMAL_REQUEST,
  } as const;
}

// ==========================================================================
// Determinism Tests
// ==========================================================================

describe('Model Adapter Determinism', () => {
  it('should produce identical outputs for identical inputs (valid mode)', () => {
    const adapter = createValidFakeAdapter(42);
    const input = createInput();
    const result1 = adapter.createBrief(input);
    const result2 = adapter.createBrief(input);
    expect(result1).toEqual(result2);
    expect(result1.interpretedGoal).toBeDefined();
    expect(result1.distinction).toBeDefined();
  });

  it('should produce stable IDs with same seed', () => {
    const adapter1 = createValidFakeAdapter(42);
    const adapter2 = createValidFakeAdapter(42);
    const input = createInput();
    const result1 = adapter1.createBrief(input);
    const result2 = adapter2.createBrief(input);
    expect(result1.recommendations[0]?.id).toBe(result2.recommendations[0]?.id);
  });
});

// ==========================================================================
// Mode Tests
// ==========================================================================

describe('Model Adapter Modes', () => {
  it('valid mode produces well-formed output', () => {
    const adapter = createValidFakeAdapter();
    const input = createInput();
    const result = adapter.createBrief(input);
    expect(result.interpretedGoal.userIntent).toBeDefined();
    expect(result.interpretedGoal.userIntent.length).toBeGreaterThan(0);
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it('malformed mode produces intentionally invalid output', () => {
    const adapter = createMalformedFakeAdapter();
    const input = createInput();
    const result = adapter.createBrief(input);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations[0]?.id).toBe('');
  });

  it('unsafe mode produces output with forbidden patterns', () => {
    const adapter = createUnsafeFakeAdapter();
    const input = createInput();
    const result = adapter.createBrief(input);
    const unsafeStrings: string[] = [];
    const addIfString = (s: unknown) => {
      if (typeof s === 'string') unsafeStrings.push(s);
    };
    addIfString(result.interpretedGoal.userIntent);
    addIfString(result.interpretedGoal.inferredGoal);
    addIfString(result.interpretedGoal.resolvedGoal);
    result.distinction.facts.forEach((f) => addIfString(f.statement));
    result.assumptions.forEach((a) => addIfString(a.statement));
    result.recommendations.forEach((r) => {
      addIfString(r.rationale);
      addIfString(r.expectedBenefit);
    });
    const hasForbidden = unsafeStrings.some(
      (s) =>
        s.includes('sk-') ||
        s.includes('Bearer ') ||
        s.includes('password') ||
        s.includes('api_key') ||
        s.includes('secret') ||
        s.includes('exec:') ||
        s.includes('rm -rf') ||
        s.includes('s3://') ||
        s.includes('https://'),
    );
    expect(hasForbidden).toBe(true);
  });

  it('excessive mode produces oversized arrays', () => {
    const adapter = createExcessiveFakeAdapter();
    const input = createInput();
    const result = adapter.createBrief(input);
    expect(result.recommendations.length).toBeGreaterThan(20);
    expect(result.assumptions.length).toBeGreaterThan(10);
  });

  it('empty mode produces minimal output', () => {
    const adapter = createEmptyFakeAdapter();
    const input = createInput();
    const result = adapter.createBrief(input);
    expect(result.recommendations.length).toBe(0);
    expect(result.assumptions.length).toBe(0);
  });

  it('failure mode throws an error', () => {
    const adapter = createFailureFakeAdapter();
    const input = createInput();
    expect(() => adapter.createBrief(input)).toThrow();
  });
});

// ==========================================================================
// Synchronous Behavior Tests
// ==========================================================================

describe('Model Adapter Synchronous Behavior', () => {
  it('createBrief should be synchronous', () => {
    const adapter = createValidFakeAdapter();
    const input = createInput();
    const result = adapter.createBrief(input);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toHaveProperty('interpretedGoal');
  });

  it('should complete instantly without async operations', () => {
    const adapter = createValidFakeAdapter();
    const input = createInput();
    const start = Date.now();
    const result = adapter.createBrief(input);
    const end = Date.now();
    expect(end - start).toBeLessThan(10);
    expect(result).toBeDefined();
  });
});

// ==========================================================================
// Adapter Metadata Tests
// ==========================================================================

describe('Model Adapter Metadata', () => {
  it('should identify as test-only', () => {
    const adapter = createValidFakeAdapter();
    expect(adapter.isTestOnly).toBe(true);
  });

  it('should have correct adapter names for different modes', () => {
    expect(createValidFakeAdapter().adapterName).toBe('fake-valid-v1');
    expect(createMalformedFakeAdapter().adapterName).toBe('fake-malformed-v1');
    expect(createUnsafeFakeAdapter().adapterName).toBe('fake-unsafe-v1');
  });
});
