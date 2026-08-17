/**
 * Creative Brief Orchestration Tests - WP-37 S3-C
 *
 * Focused orchestration tests for createCreativeBrief().
 * Proves: pure, deterministic, validated, no side effects.
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
  createCreativeBrief,
  createCreativeBriefInput,
  DEFAULT_DETERMINISTIC_CLOCK,
  verifyPersianPreservation,
} from './creative-brief.js';
import type {
  CreativeBriefV1,
  CreativeBriefRequestV1,
} from './creative-brief.js';
import {
  createValidFakeAdapter,
  createMalformedFakeAdapter,
  createUnsafeFakeAdapter,
  createExcessiveFakeAdapter,
  createEmptyFakeAdapter,
  createFailureFakeAdapter,
  type CreativeModelAdapter,
} from './model-adapter.js';

// ==========================================================================
// Test Fixtures
// ==========================================================================

const MINIMAL_SNAPSHOT = {
  schemaVersion: 1 as const,
  projectId: 'test-project' as const,
  revisionId: 'rev-001' as const,
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
  sceneCount: 2 as const,
  scenesWithVisuals: 2 as const,
  scenesWithAudio: 0 as const,
  scenesWithCaptions: 0 as const,
  evidence: [] as const,
} as const;

const MINIMAL_RULES: readonly IntelligenceRuleV1[] = [] as const;

const MINIMAL_REQUEST: CreativeBriefRequestV1 = {
  snapshotRevisionId: 'rev-001',
  projectId: 'test-project',
  request: 'Improve the pacing of my video',
  scope: 'pacing',
} as const;

function createValidInput(
  overrides: Partial<{
    snapshot: Partial<SemanticProjectSnapshotV1>;
    request: Partial<CreativeBriefRequestV1>;
    brandReadiness: Partial<BrandReadinessV1>;
    projectReadiness: Partial<ProjectReadinessV1>;
    sceneCoverages: Partial<SceneCoverageV1>[];
    rules: readonly IntelligenceRuleV1[];
  }> = {},
): {
  snapshot: SemanticProjectSnapshotV1;
  request: CreativeBriefRequestV1;
  brandReadiness: BrandReadinessV1;
  sceneCoverages: readonly SceneCoverageV1[];
  projectReadiness: ProjectReadinessV1;
  rules: readonly IntelligenceRuleV1[];
} {
  return {
    snapshot: { ...MINIMAL_SNAPSHOT, ...overrides.snapshot },
    request: { ...MINIMAL_REQUEST, ...overrides.request } as CreativeBriefRequestV1,
    brandReadiness: { ...MINIMAL_BRAND_READINESS, ...overrides.brandReadiness } as BrandReadinessV1,
    sceneCoverages: [
      { ...MINIMAL_SCENE_COVERAGE, ...overrides.sceneCoverages?.[0] } as SceneCoverageV1,
    ],
    projectReadiness: { ...MINIMAL_PROJECT_READINESS, ...overrides.projectReadiness } as ProjectReadinessV1,
    rules: [...MINIMAL_RULES, ...(overrides.rules ?? [])] as const,
  };
}

// ==========================================================================
// Happy Path Tests
// ==========================================================================

describe('createCreativeBrief Orchestration', () => {
  describe('Valid fake-adapter happy path', () => {
    it('produces a valid CreativeBriefV1 with valid adapter', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const adapter = createValidFakeAdapter();
      const result = createCreativeBrief(input, adapter);

      expect(result.schemaVersion).toBe(1);
      expect(result.snapshotRevisionId).toBe('rev-001');
      expect(result.projectId).toBe('test-project');
      expect(result.request).toBe('Improve the pacing of my video');
      expect(result.interpretedGoal).toBeDefined();
      expect(result.interpretedGoal.userIntent).toBeDefined();
      expect(result.distinction).toBeDefined();
      expect(Array.isArray(result.recommendations)).toBe(true);
      expect(Array.isArray(result.assumptions)).toBe(true);
      expect(result.intelligence).toBeDefined();
      expect(result.intelligence.brand).toBeDefined();
      expect(result.meta).toBeDefined();
      expect(result.meta.modelAdapter).toBe('fake-valid-v1');
      expect(result.meta.generatedAt).toBe(DEFAULT_DETERMINISTIC_CLOCK());
    });

    it('uses injected clock for deterministic timestamps', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const customClock = () => '2026-01-01T12:00:00.000Z' as const;
      const adapter = createValidFakeAdapter();
      const result = createCreativeBrief(input, adapter, { clock: customClock });

      expect(result.meta.generatedAt).toBe('2026-01-01T12:00:00.000Z');
    });

    it('uses default deterministic clock when no clock provided', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const adapter = createValidFakeAdapter();
      const result = createCreativeBrief(input, adapter);

      expect(result.meta.generatedAt).toBe(DEFAULT_DETERMINISTIC_CLOCK());
    });
  });

  // ==========================================================================
  // Determinism Tests
  // ==========================================================================

  describe('Byte-stable output with identical input/options', () => {
    it('produces identical outputs for identical inputs', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const adapter = createValidFakeAdapter(42);

      const result1 = createCreativeBrief(input, adapter);
      const result2 = createCreativeBrief(input, adapter);

      expect(result1).toEqual(result2);
    });

    it('produces identical outputs with same seed across different adapter instances', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const adapter1 = createValidFakeAdapter(42);
      const adapter2 = createValidFakeAdapter(42);

      const result1 = createCreativeBrief(input, adapter1);
      const result2 = createCreativeBrief(input, adapter2);

      expect(result1).toEqual(result2);
    });

    it('uses adapter processingTimeMs in meta', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const adapter = createValidFakeAdapter(42);
      // The fake adapter has processingTimeMs: 10 by default
      const result = createCreativeBrief(input, adapter);

      expect(result.meta.processingTimeMs).toBe(10);
    });
  });

  // ==========================================================================
  // Purity Tests - No Mutation
  // ==========================================================================

  describe('No mutation of snapshot, intelligence, or request', () => {
    it('does not mutate the input snapshot', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      // Deep clone the snapshot to compare
      const snapshotClone = JSON.parse(JSON.stringify(snapshot));

      const adapter = createValidFakeAdapter();
      createCreativeBrief(input, adapter);

      // Check that snapshot wasn't mutated
      expect(snapshot).toEqual(snapshotClone);
    });

    it('does not mutate the request', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const requestClone = { ...request };
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const adapter = createValidFakeAdapter();
      createCreativeBrief(input, adapter);

      expect(request).toEqual(requestClone);
    });

    it('does not mutate intelligence objects', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const intelligence = {
        brandReadiness: { ...brandReadiness },
        sceneCoverages: [...sceneCoverages],
        projectReadiness: { ...projectReadiness },
        rules: [...rules],
      };
      const brandReadinessClone = { ...brandReadiness };
      const projectReadinessClone = { ...projectReadiness };

      const input = createCreativeBriefInput(snapshot, intelligence, request);

      const adapter = createValidFakeAdapter();
      createCreativeBrief(input, adapter);

      expect(intelligence.brandReadiness).toEqual(brandReadinessClone);
      expect(intelligence.projectReadiness).toEqual(projectReadinessClone);
    });
  });

  // ==========================================================================
  // Revision/Project Mismatch Tests
  // ==========================================================================

  describe('Stale revision/project rejection', () => {
    it('rejects snapshot revision mismatch', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();

      // Create request with different revision ID
      const mismatchedRequest: CreativeBriefRequestV1 = {
        ...request,
        snapshotRevisionId: 'rev-999',
      };

      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, mismatchedRequest);

      const adapter = createValidFakeAdapter();

      expect(() => createCreativeBrief(input, adapter)).toThrow(
        'Snapshot revision mismatch: snapshot has rev-001, request expects rev-999',
      );
    });

    it('rejects project ID mismatch', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();

      // Create request with different project ID
      const mismatchedRequest: CreativeBriefRequestV1 = {
        ...request,
        projectId: 'wrong-project',
      };

      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, mismatchedRequest);

      const adapter = createValidFakeAdapter();

      expect(() => createCreativeBrief(input, adapter)).toThrow(
        'Project ID mismatch: snapshot has test-project, request has wrong-project',
      );
    });

    it('rejects both revision and project ID mismatch', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();

      const mismatchedRequest: CreativeBriefRequestV1 = {
        ...request,
        snapshotRevisionId: 'rev-999',
        projectId: 'wrong-project',
      };

      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, mismatchedRequest);

      const adapter = createValidFakeAdapter();

      // Revision mismatch is checked first, so that error is thrown
      expect(() => createCreativeBrief(input, adapter)).toThrow(
        'Snapshot revision mismatch: snapshot has rev-001, request expects rev-999',
      );
    });
  });

  // ==========================================================================
  // Adapter Mode Tests - Reject Malformed/Unsafe/Excessive/Empty/Failure
  // ==========================================================================

  describe('Malformed/unsafe/excessive/empty/failure adapter modes rejected', () => {
    it('rejects malformed adapter output', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const adapter = createMalformedFakeAdapter();

      // The malformed adapter returns empty strings for userIntent, inferredGoal, resolvedGoal
      // Our validation checks userIntent first
      expect(() => createCreativeBrief(input, adapter)).toThrow(
        /Model adapter output has invalid interpretedGoal\.(userIntent|inferredGoal|resolvedGoal)/,
      );
    });

    it('rejects unsafe adapter output with forbidden patterns', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const adapter = createUnsafeFakeAdapter();

      // Unsafe adapter returns output with forbidden patterns (secrets, URLs)
      // Our validation should catch this
      expect(() => createCreativeBrief(input, adapter)).toThrow(/Model adapter output contains forbidden patterns/);
    });

    it('accepts excessive adapter output but validates it', () => {
      // Excessive mode produces oversized arrays, but createCreativeBrief should still work
      // The final validation will check array lengths
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const adapter = createExcessiveFakeAdapter();

      // This should throw due to excessive recommendations (> 20)
      // The error comes from final validation, not from adapter output validation
      expect(() => createCreativeBrief(input, adapter)).toThrow(/recommendations count must be <= 20/);
    });

    it('rejects empty adapter output with invalid fields', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const adapter = createEmptyFakeAdapter();

      // Empty adapter returns empty strings for inferredGoal and resolvedGoal
      // which are invalid, so it should be rejected
      expect(() => createCreativeBrief(input, adapter)).toThrow(
        'Model adapter output has invalid interpretedGoal.inferredGoal',
      );
    });

    it('rejects failure adapter mode', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const adapter = createFailureFakeAdapter();

      expect(() => createCreativeBrief(input, adapter)).toThrow(/Model adapter failed/);
    });
  });

  // ==========================================================================
  // Persian Request Tests
  // ==========================================================================

  describe('Persian request preserved', () => {
    it('preserves Persian request text through the brief', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput({
          request: {
            request: 'ویدئو من را برای اینستاگرام بهتر کنید',
          },
        });
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const adapter = createValidFakeAdapter();
      const result = createCreativeBrief(input, adapter);

      expect(result.request).toBe('ویدئو من را برای اینستاگرام بهتر کنید');
      expect(verifyPersianPreservation(request, result)).toBe(true);
    });

    it('handles Persian request with valid adapter', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput({
          request: {
            request: 'لطفا ویدئو را ویرایش کنید',
          },
        });
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const adapter = createValidFakeAdapter();
      const result = createCreativeBrief(input, adapter);

      expect(result.schemaVersion).toBe(1);
      expect(result.request).toBe('لطفا ویدئو را ویرایش کنید');
    });
  });

  // ==========================================================================
  // Evidence Validation Tests
  // ==========================================================================

  describe('Invalid evidence rejected', () => {
    it('rejects recommendations with invalid evidence references', () => {
      // This test requires a custom adapter that returns invalid evidence
      // We'll create a simple test adapter inline
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();

      // Create a custom adapter that returns invalid evidence
      const invalidEvidenceAdapter: CreativeModelAdapter = {
        adapterName: 'test-invalid-evidence',
        isTestOnly: true,
        createBrief: () => ({
          interpretedGoal: {
            userIntent: 'Test intent',
            inferredGoal: 'Test inferred',
            resolvedGoal: 'Test resolved',
            confidence: 'high' as const,
          },
          distinction: {
            facts: [],
            inferences: [],
          },
          assumptions: [],
          recommendations: [
            {
              id: 'test-rec-001',
              kind: 'pacing',
              confidence: 'high' as const,
              // Invalid evidence - references non-existent marker
              evidence: [{ id: 'non-existent-scene', kind: 'marker' as const }],
              rationale: 'Test rationale',
              expectedBenefit: 'Test benefit',
              risk: 'none' as const,
              scope: {},
            },
          ],
          blockedBy: [],
          requiresHumanDecision: [],
          meta: {
            processingTimeMs: 10,
          },
        }),
      };

      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      // The evidence validation happens and should add warnings
      // But it doesn't throw - it adds error warnings
      const result = createCreativeBrief(input, invalidEvidenceAdapter);

      // Check that invalid evidence was detected and added as warnings
      expect(result.warnings.some(w => w.code === 'invalid-evidence-reference')).toBe(true);
    });

    it('rejects evidence that fails validation in final brief', () => {
      // Create a scenario where the adapter output would fail final validation
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();

      const invalidFinalAdapter: CreativeModelAdapter = {
        adapterName: 'test-invalid-final',
        isTestOnly: true,
        createBrief: () => ({
          interpretedGoal: {
            userIntent: '', // Empty - will fail validation
            inferredGoal: 'Test',
            resolvedGoal: 'Test',
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
          meta: {
            processingTimeMs: 10,
          },
        }),
      };

      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      // This should fail during adapter output validation
      expect(() => createCreativeBrief(input, invalidFinalAdapter)).toThrow(
        'Model adapter output has invalid interpretedGoal.userIntent',
      );
    });
  });

  // ==========================================================================
  // Return Type Tests
  // ==========================================================================

  describe('Return type validation', () => {
    it('returns only CreativeBriefV1, never other types', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const adapter = createValidFakeAdapter();
      const result = createCreativeBrief(input, adapter);

      // Verify it has all required CreativeBriefV1 fields
      expect(result.schemaVersion).toBe(1);
      expect(typeof result.snapshotRevisionId).toBe('string');
      expect(typeof result.projectId).toBe('string');
      expect(typeof result.request).toBe('string');
      expect(result.interpretedGoal).toBeDefined();
      expect(result.distinction).toBeDefined();
      expect(Array.isArray(result.recommendations)).toBe(true);
      expect(Array.isArray(result.assumptions)).toBe(true);
      expect(Array.isArray(result.blockedBy)).toBe(true);
      expect(Array.isArray(result.requiresHumanDecision)).toBe(true);
      expect(result.intelligence).toBeDefined();
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(result.meta).toBeDefined();

      // Verify it does NOT have any prohibited fields
      const resultKeys = Object.keys(result);
      expect(resultKeys).not.toContain('execCommand');
      expect(resultKeys).not.toContain('history');
      expect(resultKeys).not.toContain('cache');
    });

    it('does not include command payloads, approvals, jobs, or mutations', () => {
      const { snapshot, request, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();
      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, request);

      const adapter = createValidFakeAdapter();
      const result = createCreativeBrief(input, adapter);

      // Check that the result doesn't contain any operation-like fields
      const resultKeys = Object.keys(result);
      const prohibitedKeys = [
        'commands',
        'approvals',
        'jobs',
        'mutations',
        'history',
        'cache',
        'telemetry',
        'state',
        'uiState',
      ];

      for (const key of prohibitedKeys) {
        expect(resultKeys).not.toContain(key);
      }
    });
  });

  // ==========================================================================
  // Request Validation Tests
  // ==========================================================================

  describe('Request validation', () => {
    it('rejects invalid request with validation errors', () => {
      const { snapshot, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();

      const invalidRequest: CreativeBriefRequestV1 = {
        snapshotRevisionId: 'rev-001',
        projectId: 'test-project',
        request: '', // Empty request - invalid
        scope: 'pacing',
      };

      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, invalidRequest);

      const adapter = createValidFakeAdapter();

      expect(() => createCreativeBrief(input, adapter)).toThrow(/Invalid creative brief request/);
    });

    it('rejects request with unknown scope', () => {
      const { snapshot, brandReadiness, sceneCoverages, projectReadiness, rules } =
        createValidInput();

      const invalidRequest: CreativeBriefRequestV1 = {
        snapshotRevisionId: 'rev-001',
        projectId: 'test-project',
        request: 'Test request',
        scope: 'invalid-scope' as never, // Cast to never to bypass TS
      };

      const input = createCreativeBriefInput(snapshot, {
        brandReadiness,
        sceneCoverages,
        projectReadiness,
        rules,
      }, invalidRequest);

      const adapter = createValidFakeAdapter();

      expect(() => createCreativeBrief(input, adapter)).toThrow(/Invalid creative brief request/);
    });
  });
});
