import { describe, expect, it, vi } from 'vitest';

import type { SemanticBrollSearchIndexV1 } from '@joy-media/project-schema';
import {
  createBrollInsertionProposal,
  searchBroll,
  type BrollSearchRequest,
} from './broll-search.js';

const baseIndex: SemanticBrollSearchIndexV1 = {
  schemaVersion: 1,
  projectId: 'project-broll',
  createdAt: '2026-08-22T00:00:00.000Z',
  evidenceIndex: new Map([
    [
      'shot-hero',
      {
        id: 'shot-hero',
        kind: 'asset-shot',
        label: 'Hero product shot',
        summary: 'Close macro pour with warm highlights',
        sourceEntityId: 'asset-used',
        sourceEntityRevision: 1,
        assetId: 'asset-used',
        startUs: 1_000_000,
        durationUs: 2_000_000,
        tags: ['product', 'pour'],
      },
    ],
    [
      'caption-hero',
      {
        id: 'caption-hero',
        kind: 'asset-caption',
        label: 'Hero caption',
        summary: 'Caption says warm launch moment',
        sourceEntityId: 'asset-used',
        sourceEntityRevision: 1,
        assetId: 'asset-used',
        startUs: 1_200_000,
        durationUs: 1_200_000,
        text: 'warm launch moment',
        language: 'en',
      },
    ],
    [
      'shot-unused',
      {
        id: 'shot-unused',
        kind: 'asset-shot',
        label: 'Unused product closeup',
        summary: 'Unused closeup of product texture',
        sourceEntityId: 'asset-unused',
        sourceEntityRevision: 1,
        assetId: 'asset-unused',
        startUs: 6_000_000,
        durationUs: 2_500_000,
        tags: ['product', 'texture'],
      },
    ],
    [
      'audio-unused',
      {
        id: 'audio-unused',
        kind: 'asset-audio',
        label: 'Unused audio swell',
        summary: 'Soft ambient swell under the product shot',
        sourceEntityId: 'asset-unused',
        sourceEntityRevision: 1,
        assetId: 'asset-unused',
        startUs: 6_200_000,
        durationUs: 1_000_000,
        audioKind: 'ambient',
      },
    ],
  ]),
  assets: [
    {
      assetId: 'asset-used',
      displayName: 'Launch hero.mp4',
      assetType: 'video',
      durationUs: 12_000_000,
      usedInTimeline: true,
      tags: ['product'],
      ranges: [
        {
          rangeId: 'range-used',
          assetId: 'asset-used',
          startUs: 1_000_000,
          durationUs: 2_500_000,
          label: 'Hero pour',
          text: 'warm launch product pour',
          evidenceIds: ['shot-hero', 'caption-hero'],
        },
      ],
    },
    {
      assetId: 'asset-unused',
      displayName: 'Texture spare.mp4',
      assetType: 'video',
      durationUs: 10_000_000,
      usedInTimeline: false,
      tags: ['product', 'texture'],
      ranges: [
        {
          rangeId: 'range-unused',
          assetId: 'asset-unused',
          startUs: 6_000_000,
          durationUs: 2_500_000,
          label: 'Texture closeup',
          text: 'unused product texture with ambient swell',
          evidenceIds: ['shot-unused', 'audio-unused'],
        },
      ],
    },
  ],
};

describe('searchBroll', () => {
  it('returns deterministic evidence-linked time ranges and ranks unused assets first', () => {
    const first = searchBroll(baseIndex, { query: 'product', maxResults: 5 });
    const second = searchBroll(baseIndex, { query: 'product', maxResults: 5 });

    expect(second).toEqual(first);
    expect(first.results.map((result) => result.assetId)).toEqual(['asset-unused', 'asset-used']);
    expect(first.results[0]).toMatchObject({
      assetId: 'asset-unused',
      range: { startUs: 6_000_000, durationUs: 2_500_000 },
      evidenceIds: ['shot-unused', 'audio-unused'],
      usedInTimeline: false,
    });
    expect(first.results[0]?.explanations.join(' ')).toContain('unused');
  });

  it('applies deterministic filters before optional reranking', () => {
    const results = searchBroll(baseIndex, {
      query: 'product',
      timeRange: { startUs: 5_500_000, endUs: 9_000_000 },
      unusedOnly: true,
    });

    expect(results.results).toHaveLength(1);
    expect(results.results[0]?.assetId).toBe('asset-unused');
  });

  it('requires explicit privacy approval before reranking can run', () => {
    const reranker = vi.fn();
    const request: BrollSearchRequest = {
      query: 'product',
      rerank: { enabled: true, privacyApproved: false },
    };

    const results = searchBroll(baseIndex, request, { reranker });

    expect(reranker).not.toHaveBeenCalled();
    expect(results.privacy.dataLeavesDevice).toBe(false);
    expect(results.results[0]?.assetId).toBe('asset-unused');
  });

  it('allows approved reranking while preserving base evidence and explanations', () => {
    const results = searchBroll(
      baseIndex,
      {
        query: 'product',
        rerank: { enabled: true, privacyApproved: true, providerId: 'private-reranker' },
      },
      {
        reranker: ({ candidates }) =>
          candidates.map((candidate) => ({
            resultId: candidate.resultId,
            score: candidate.assetId === 'asset-used' ? 10 : 1,
            reason: `reranked ${candidate.assetId}`,
          })),
      },
    );

    expect(results.results.map((result) => result.assetId)).toEqual(['asset-used', 'asset-unused']);
    expect(results.results[0]?.evidenceIds).toEqual(['shot-hero', 'caption-hero']);
    expect(results.results[0]?.explanations.some((entry) => entry.includes('Base score'))).toBe(
      true,
    );
    expect(results.privacy).toMatchObject({
      dataLeavesDevice: true,
      providerId: 'private-reranker',
    });
  });

  it('rejects ranges that cite missing evidence', () => {
    const broken: SemanticBrollSearchIndexV1 = {
      ...baseIndex,
      assets: [
        {
          ...baseIndex.assets[0]!,
          ranges: [
            {
              ...baseIndex.assets[0]!.ranges[0]!,
              evidenceIds: ['missing-evidence'],
            },
          ],
        },
      ],
    };

    expect(() => searchBroll(broken, { query: 'product' })).toThrow(/missing evidence/i);
  });
});

describe('createBrollInsertionProposal', () => {
  it('creates a dry-run pending-approval insertion plan without dispatching commands', () => {
    const dispatch = vi.fn();
    const result = searchBroll(baseIndex, { query: 'texture' }).results[0]!;

    const plan = createBrollInsertionProposal(result, {
      compositionId: 'comp-1',
      trackId: 'track-broll',
      insertAtUs: 9_000_000,
      clipId: 'clip-broll-1',
      dispatch,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(plan.status).toBe('pending-approval');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      mode: 'command',
      tool: 'insertClip',
      requiresConfirmation: true,
    });
    expect(JSON.stringify(plan.steps[0]?.arguments)).toContain('asset-unused');
  });
});
