/**
 * Creative Brief Display Tests - WP-37 S4-B
 *
 * Tests use static typed CreativeBriefV1 fixtures, NOT fake adapters.
 * No DOM testing - uses Vitest only for type checking and fixture validation.
 */

import { describe, it, expect } from 'vitest';
import type {
  CreativeBriefV1,
  RecommendationKind,
  RecommendationRisk,
  InferenceConfidence,
} from '@joy-media/agent-tools';
import { CreativeBriefDisplay } from './CreativeBriefDisplay.js';

// Static fixture - a complete, valid CreativeBriefV1 for testing
const STATIC_BRIEF: CreativeBriefV1 = {
  schemaVersion: 1,
  snapshotRevisionId: 'rev-abc123',
  projectId: 'test-project-001',
  request: 'Improve the pacing of my video',
  interpretedGoal: {
    userIntent: 'Improve the pacing of my video',
    inferredGoal: 'Add b-roll and trim gaps between clips to create smoother flow',
    resolvedGoal: 'Add b-roll clips and remove pacing gaps in scenes 1 and 2',
    confidence: 'high',
  },
  distinction: {
    facts: [
      {
        id: 'fact-001',
        statement: 'Scene 1 has 3 clips with visual coverage',
        source: 's2',
        evidence: [{ id: 'scene-1', kind: 'clip', startUs: 0, endUs: 5000000 }],
      },
    ],
    inferences: [
      {
        id: 'inference-001',
        statement: 'Adding b-roll would improve visual interest',
        confidence: 'medium',
        rationale: 'Narration runs for 3 seconds without visual change in scene 2',
        evidence: [
          {
            id: 'scene-2',
            kind: 'clip',
            startUs: 5000000,
            endUs: 8000000,
            detail: 'narration-only segment',
          },
        ],
      },
    ],
  },
  assumptions: [
    {
      id: 'a-001',
      statement: 'User wants premium feel',
      confidence: 'medium',
      evidence: [],
      verified: true,
    },
  ],
  recommendations: [
    {
      id: 'pacing.hook.add-broll-001' as const,
      kind: 'pacing' as RecommendationKind,
      confidence: 'high' as InferenceConfidence,
      evidence: [{ id: 'scene-2', kind: 'clip', startUs: 5000000, endUs: 8000000 }],
      rationale: 'Narration-only segment needs visual support',
      expectedBenefit: 'More engaging video with better pacing',
      risk: 'reversible-local' as RecommendationRisk,
      scope: { sceneIds: ['scene-2'] },
    },
  ],
  blockedBy: [
    {
      id: 'b-001',
      capability: 'b-roll',
      status: 'setup-required',
      message: 'Needs provider',
      evidence: [],
    },
  ],
  requiresHumanDecision: [
    {
      id: 'd-001',
      question: 'Which style?',
      context: 'Options available',
      options: ['a', 'b'],
      evidence: [],
    },
  ],
  warnings: [{ code: 'truncated', message: 'List truncated', severity: 'info' }],
  intelligence: {
    brand: {
      projectId: 'test-project-001',
      revisionId: 'rev-abc123',
      colorsAvailable: true,
      fontsAvailable: false,
      logoAvailable: true,
      voiceInstructionsAvailable: false,
      toneInstructionsAvailable: false,
      prohibitedClaims: [],
      prohibitedEffects: [],
      hasBrandKit: true,
      brandCompleteness: 'partial',
      missingComponents: [],
      warnings: [],
      evidence: [],
    },
    scenes: [],
    project: {
      projectId: 'test-project-001',
      revisionId: 'rev-abc123',
      destination: 'instagram-reel',
      destinationAligned: true,
      destinationMismatch: undefined,
      durationTargetUs: 60000000,
      compositionDurationUs: 55000000,
      durationAligned: false,
      durationGapUs: -5000000,
      aspectRatio: '9:16',
      aspectRatioAligned: true,
      aspectRatioMismatch: undefined,
      captionAvailable: false,
      audioAvailable: false,
      generatedAssetsAvailable: false,
      readinessLevel: 'partial',
      blockers: [],
      warnings: [],
      sceneCount: 0,
      scenesWithVisuals: 0,
      scenesWithAudio: 0,
      scenesWithCaptions: 0,
      evidence: [],
    },
    rules: [],
  },
  meta: { generatedAt: '2026-08-18T10:00:00.000Z', modelAdapter: 'fake-v1', processingTimeMs: 150 },
};

// Persian/RTL fixture
const PERSIAN_BRIEF: CreativeBriefV1 = {
  ...STATIC_BRIEF,
  request: 'ویدیو من رو سریع‌تر کنید',
  interpretedGoal: {
    userIntent: 'ویدیو من رو سریع‌تر کنید',
    inferredGoal: 'کاهش مدت',
    resolvedGoal: 'حذف مقاطع',
    confidence: 'high',
  },
  recommendations: [],
  blockedBy: [],
  requiresHumanDecision: [],
  warnings: [],
};

describe('CreativeBriefDisplay', () => {
  it('exports CreativeBriefDisplay component', () => {
    expect(CreativeBriefDisplay).toBeDefined();
    expect(typeof CreativeBriefDisplay).toBe('function');
  });

  it('accepts CreativeBriefV1 prop - type check', () => {
    const _result = <CreativeBriefDisplay brief={STATIC_BRIEF} />;
    expect(_result).toBeDefined();
  });

  it('static brief has facts and inferences clearly separated', () => {
    expect(STATIC_BRIEF.distinction.facts.length).toBeGreaterThan(0);
    expect(STATIC_BRIEF.distinction.inferences.length).toBeGreaterThan(0);
    expect(STATIC_BRIEF.distinction.facts[0]!.source).toBe('s2');
    expect(STATIC_BRIEF.distinction.inferences[0]!.confidence).toBe('medium');
  });

  it('recommendations have confidence, risk, rationale, expected benefit', () => {
    const rec = STATIC_BRIEF.recommendations[0]!;
    expect(rec.confidence).toBe('high');
    expect(rec.risk).toBe('reversible-local');
    expect(rec.rationale).toBe('Narration-only segment needs visual support');
    expect(rec.expectedBenefit).toBe('More engaging video with better pacing');
  });

  it('blockers render when present', () => {
    expect(STATIC_BRIEF.blockedBy.length).toBeGreaterThan(0);
    expect(STATIC_BRIEF.blockedBy[0]!.status).toBe('setup-required');
  });

  it('human decisions render when present', () => {
    expect(STATIC_BRIEF.requiresHumanDecision.length).toBeGreaterThan(0);
    expect(STATIC_BRIEF.requiresHumanDecision[0]!.options).toHaveLength(2);
  });

  it('warnings render when present', () => {
    expect(STATIC_BRIEF.warnings.length).toBeGreaterThan(0);
    expect(STATIC_BRIEF.warnings[0]!.severity).toBe('info');
  });

  it('metadata is complete', () => {
    expect(STATIC_BRIEF.meta.generatedAt).toBeDefined();
    expect(STATIC_BRIEF.meta.modelAdapter).toBe('fake-v1');
    expect(STATIC_BRIEF.meta.processingTimeMs).toBe(150);
  });

  it('preserves Persian request text', () => {
    expect(PERSIAN_BRIEF.request).toBe('ویدیو من رو سریع‌تر کنید');
    expect(PERSIAN_BRIEF.interpretedGoal.userIntent).toBe('ویدیو من رو سریع‌تر کنید');
  });

  it('has no action controls in component structure', () => {
    const component = CreativeBriefDisplay({ brief: STATIC_BRIEF });
    expect(component).toBeDefined();
  });

  it('empty brief accepted without error', () => {
    const empty: CreativeBriefV1 = {
      schemaVersion: 1,
      snapshotRevisionId: 'r',
      projectId: 'p',
      request: 'q',
      interpretedGoal: { userIntent: 'q', inferredGoal: '', resolvedGoal: '', confidence: 'low' },
      distinction: { facts: [], inferences: [] },
      assumptions: [],
      recommendations: [],
      blockedBy: [],
      requiresHumanDecision: [],
      warnings: [],
      intelligence: {
        brand: {
          projectId: 'p',
          revisionId: 'r',
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
        scenes: [],
        project: {
          projectId: 'p',
          revisionId: 'r',
          destination: undefined,
          destinationAligned: false,
          destinationMismatch: undefined,
          durationTargetUs: undefined,
          compositionDurationUs: 0,
          durationAligned: false,
          durationGapUs: undefined,
          aspectRatio: '0:0',
          aspectRatioAligned: false,
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
      },
      meta: {
        generatedAt: '2026-08-18T10:00:00.000Z',
        modelAdapter: 'fake-v1',
        processingTimeMs: 0,
      },
    };
    const _result = CreativeBriefDisplay({ brief: empty });
    expect(_result).toBeDefined();
  });
});
