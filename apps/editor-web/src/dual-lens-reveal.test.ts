import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { buildDualLensProjection } from './dual-lens-model.js';
import {
  formatProvenanceRibbon,
  graphNodeIdsForClips,
  primaryNodeIdForClip,
  provenanceRibbon,
  timelineClipIdsForNode,
} from './dual-lens-reveal.js';

const GENERATED_INTRO = {
  ...INITIAL_EDITOR_PROJECT,
  assets: {
    ...INITIAL_EDITOR_PROJECT.assets,
    'asset-intro': {
      id: 'asset-intro',
      kind: 'video' as const,
      displayName: 'Generated intro',
      generationProvenance: {
        providerId: 'local-worker',
        modelId: 'flux-dev',
        modelVersion: '2026-07',
        prompt: 'Soft purple product reveal',
        seed: 42,
        inputAssetHashes: [],
        parameters: {},
        generatedAssetId: 'asset-intro',
        createdAt: '2026-07-26T00:00:00.000Z',
      },
    },
  },
};

function projection(creative = INITIAL_EDITOR_PROJECT, playheadUs = 5_000_000) {
  return buildDualLensProjection(buildReferenceSpikeProject(), creative, playheadUs, []);
}

describe('Dual Lens reveal bridge', () => {
  describe('timeline selection to graph', () => {
    it('resolves a selected clip to its own node rather than every node mentioning it', () => {
      expect(primaryNodeIdForClip(projection(), 'intro')).toBe('clip:intro');
    });

    it('lights up every node bound to the selection, including its source asset', () => {
      const nodeIds = graphNodeIdsForClips(projection(), ['intro']);

      expect(nodeIds).toEqual(expect.arrayContaining(['clip:intro', 'asset:asset-intro']));
      expect(nodeIds).not.toContain('clip:product');
    });

    it('returns nothing for an empty selection', () => {
      expect(graphNodeIdsForClips(projection(), [])).toEqual([]);
    });

    it('ignores clip ids that are not in the projection', () => {
      expect(graphNodeIdsForClips(projection(), ['does-not-exist'])).toEqual([]);
      expect(primaryNodeIdForClip(projection(), 'does-not-exist')).toBeUndefined();
    });
  });

  describe('graph selection to timeline', () => {
    it('resolves a clip node back to its clip', () => {
      expect(timelineClipIdsForNode(projection(), 'clip:product')).toEqual(['product']);
    });

    it('resolves a shared asset node to every clip that uses it', () => {
      // Each fixture clip has its own asset, so binding accumulation is proved
      // by pointing two clips at one asset instead.
      const timeline = buildReferenceSpikeProject();
      const composition = timeline.compositions[timeline.rootCompositionId]!;
      const shared = {
        ...timeline,
        compositions: {
          [timeline.rootCompositionId]: {
            ...composition,
            tracks: composition.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.kind === 'video' ? { ...clip, assetId: 'asset-shared' } : clip,
              ),
            })),
          },
        },
      };
      const shared_projection = buildDualLensProjection(
        shared,
        INITIAL_EDITOR_PROJECT,
        5_000_000,
        [],
      );

      expect(timelineClipIdsForNode(shared_projection, 'asset:asset-shared')).toEqual(
        expect.arrayContaining(['intro', 'product', 'outro', 'b-roll-a', 'b-roll-b']),
      );
    });

    it('resolves unplaced data nodes to no clip, so revealing them cannot select the wrong item', () => {
      expect(timelineClipIdsForNode(projection(), 'output:program')).toEqual([]);
      expect(timelineClipIdsForNode(projection(), 'data:captions:captions-fa')).toEqual([]);
    });
  });

  describe('provenance ribbon', () => {
    it('reads from source through the layer it drives to Program Output', () => {
      const steps = provenanceRibbon(projection(), 'intro');

      expect(steps.map((step) => step.nodeId)).toEqual([
        'asset:asset-intro',
        'clip:intro',
        'visual:intro-title',
        'output:program',
      ]);
      expect(formatProvenanceRibbon(steps)).toBe(
        'Asset-intro → Intro → JOY → Program Output',
      );
    });

    it('places a generative provider before the asset it produced, not beside it', () => {
      // Provider and asset share a display column; ordering by column alone
      // would claim the asset came first.
      const steps = provenanceRibbon(projection(GENERATED_INTRO), 'intro');

      expect(steps.map((step) => step.nodeId)).toEqual([
        'provider:local-worker:flux-dev',
        'asset:asset-intro',
        'clip:intro',
        'visual:intro-title',
        'output:program',
      ]);
      expect(formatProvenanceRibbon(steps)).toBe(
        'Flux-dev → Generated Intro → Intro → JOY → Program Output',
      );
    });

    it('is empty for a clip with no node', () => {
      expect(provenanceRibbon(projection(), 'does-not-exist')).toEqual([]);
    });

    it('does not pull in siblings that merely share the output', () => {
      const nodeIds = provenanceRibbon(projection(), 'intro').map((step) => step.nodeId);

      expect(nodeIds).not.toContain('clip:product');
      expect(nodeIds).not.toContain('clip:b-roll-a');
    });
  });
});
