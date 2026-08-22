import { describe, expect, it } from 'vitest';

import type { VideoReferenceAnalyzeReceipt } from '@joy-media/job-protocol';
import { buildSemanticBrollIndex, SemanticIndexError } from './semantic-index.js';

const receipt: VideoReferenceAnalyzeReceipt = {
  kind: 'video.reference-analyze',
  assetId: 'asset-broll',
  sha256: 'a'.repeat(64),
  bytes: 100,
  descriptor: {
    mimeType: 'video/mp4',
    width: 1920,
    height: 1080,
    durationUs: 12_000_000,
  },
  summary: {
    shotCount: 1,
    cutCount: 0,
    averageShotDurationUs: 3_000_000,
    fastestShotDurationUs: 3_000_000,
    sampleCount: 1,
    transcriptSegmentCount: 1,
    audioBeatCount: 1,
  },
  evidence: [
    {
      id: 'shot-00000000',
      kind: 'shot',
      label: 'Shot 1',
      summary: 'Product closeup with hands entering frame.',
      startUs: 4_000_000,
      durationUs: 3_000_000,
    },
    {
      id: 'transcript-00000000',
      kind: 'transcript',
      label: 'Transcript',
      summary: 'Human transcript',
      segments: [
        {
          startUs: 4_200_000,
          endUs: 5_400_000,
          text: 'show the handmade product detail',
        },
      ],
    },
    {
      id: 'audio-beat-04000000',
      kind: 'audio-beat',
      label: 'Audio beat 4.0s',
      summary: 'Energy peak sampled in the analysis window.',
      startUs: 4_000_000,
      durationUs: 500_000,
      strength: 0.7,
    },
  ],
  evidenceIds: ['shot-00000000', 'transcript-00000000', 'audio-beat-04000000'],
};

describe('buildSemanticBrollIndex', () => {
  it('converts reference receipts into asset shot, caption, and audio evidence', () => {
    const index = buildSemanticBrollIndex({
      projectId: 'project-semantic',
      receipts: [receipt],
      assetLabels: new Map([['asset-broll', 'Handmade detail.mp4']]),
      usedAssetIds: new Set(),
      now: new Date('2026-08-22T01:00:00.000Z'),
    });

    expect(index.projectId).toBe('project-semantic');
    expect(index.assets).toHaveLength(1);
    expect(index.assets[0]).toMatchObject({
      assetId: 'asset-broll',
      displayName: 'Handmade detail.mp4',
      usedInTimeline: false,
    });
    expect(index.assets[0]?.ranges[0]).toMatchObject({
      startUs: 4_000_000,
      durationUs: 3_000_000,
      evidenceIds: [
        'asset-broll.shot-00000000',
        'asset-broll.caption-04200000',
        'asset-broll.audio-beat-04000000',
      ],
    });
    expect(index.evidenceIndex.get('asset-broll.shot-00000000')).toMatchObject({
      kind: 'asset-shot',
      assetId: 'asset-broll',
    });
    expect(index.evidenceIndex.get('asset-broll.caption-04200000')).toMatchObject({
      kind: 'asset-caption',
      text: 'show the handmade product detail',
    });
    expect(index.evidenceIndex.get('asset-broll.audio-beat-04000000')).toMatchObject({
      kind: 'asset-audio',
      audioKind: 'music',
    });
  });

  it('rejects receipts that cannot produce evidence-linked ranges', () => {
    const broken: VideoReferenceAnalyzeReceipt = {
      ...receipt,
      evidence: [],
      evidenceIds: [],
    };

    expect(() =>
      buildSemanticBrollIndex({
        projectId: 'project-semantic',
        receipts: [broken],
        now: new Date('2026-08-22T01:00:00.000Z'),
      }),
    ).toThrow(SemanticIndexError);
  });
});
