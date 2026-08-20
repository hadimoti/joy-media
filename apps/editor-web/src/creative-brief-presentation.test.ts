import { describe, expect, it } from 'vitest';
import type { EvidenceRefV1 } from '@joy-media/project-schema';
import type { CreativeBriefV1 } from '@joy-media/agent-tools';
import {
  createCreativeBriefMetrics,
  formatBriefDurationUs,
  formatBriefEvidence,
} from './creative-brief-presentation.js';

const BRIEF: CreativeBriefV1 = {
  schemaVersion: 1,
  snapshotRevisionId: 'rev-1',
  projectId: 'project-1',
  request: 'ویدیو را بهتر کن',
  interpretedGoal: {
    userIntent: 'ویدیو را بهتر کن',
    inferredGoal: 'Improve pacing',
    resolvedGoal: 'Improve pacing',
    confidence: 'high',
  },
  distinction: { facts: [], inferences: [] },
  assumptions: [],
  recommendations: [],
  blockedBy: [],
  requiresHumanDecision: [],
  warnings: [],
  intelligence: {
    brand: {
      projectId: 'project-1',
      revisionId: 'rev-1',
      colorsAvailable: true,
      fontsAvailable: true,
      logoAvailable: false,
      voiceInstructionsAvailable: false,
      toneInstructionsAvailable: false,
      hasBrandKit: true,
      brandCompleteness: 'partial',
      missingComponents: [],
      warnings: [],
      evidence: [],
    },
    scenes: [],
    project: {
      projectId: 'project-1',
      revisionId: 'rev-1',
      destination: 'instagram-reel',
      destinationAligned: true,
      durationTargetUs: 65_000_000,
      compositionDurationUs: 65_000_000,
      durationAligned: true,
      aspectRatio: '9:16',
      aspectRatioAligned: true,
      capabilities: {},
      blockers: [],
      evidence: [],
    },
    rules: [],
  },
  meta: { generatedAt: '2026-08-20T00:00:00.000Z', modelAdapter: 'test', processingTimeMs: 1 },
};

describe('creative brief presentation helpers', () => {
  it('formats microseconds as stable compact durations', () => {
    expect(formatBriefDurationUs(30_000_000)).toBe('30s');
    expect(formatBriefDurationUs(65_000_000)).toBe('1m 05s');
  });

  it('formats evidence with the explicit end timestamp', () => {
    const evidence: EvidenceRefV1[] = [
      { id: 'clip-1', kind: 'clip', startUs: 5_000_000, endUs: 8_000_000 },
    ];
    expect(formatBriefEvidence(evidence)).toContain('0:05–0:08');
    expect(formatBriefEvidence(evidence)).not.toContain('0:13');
  });

  it('derives available structured metrics and preserves source text', () => {
    const metrics = createCreativeBriefMetrics(BRIEF);
    expect(metrics.map((metric) => metric.id)).toEqual([
      'duration',
      'aspect-ratio',
      'scenes',
      'destination',
      'brand',
    ]);
    expect(metrics.find((metric) => metric.id === 'duration')?.value).toBe('1m 05s');
    expect(metrics.find((metric) => metric.id === 'destination')?.value).toBe('instagram-reel');
    expect(BRIEF.request).toBe('ویدیو را بهتر کن');
  });
});
