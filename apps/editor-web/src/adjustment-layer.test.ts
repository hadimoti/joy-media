import { describe, expect, it } from 'vitest';
import { applyTransaction } from '@joy-media/commands';
import { buildAdjustmentLayerInsertion, buildTreatmentLayerInsertion } from './adjustment-layer.js';
import { resolveObjectIdForSelection } from './sticker-bindings.js';
import { readEffectLayerTargetMap, readTimelineElementKindMap } from './timeline-element-kind.js';
import { buildTimelineElementsShowcase } from './timeline-elements-showcase.js';

describe('buildAdjustmentLayerInsertion', () => {
  it('creates one independent Adjust track with a targeted effect controller', () => {
    const { timeline, visual } = buildTimelineElementsShowcase();
    const insertion = buildAdjustmentLayerInsertion({
      timeline,
      project: visual,
      targetClipId: 'showcase-intro',
      token: 'test',
    });
    const nextTimeline = applyTransaction(timeline, insertion.timeline).project;
    const adjustTrack = nextTimeline.compositions.root!.tracks.find(
      (track) => track.id === 'Adjust-test',
    );

    expect(adjustTrack?.clips).toEqual([
      expect.objectContaining({
        id: 'adjust-test',
        startUs: 0,
        durationUs: 6_000_000,
        assetId: 'joy-adjustment-layer',
      }),
    ]);
    expect(readTimelineElementKindMap(insertion.project)['adjust-test']).toBe('adjust');
    expect(resolveObjectIdForSelection(insertion.project, ['adjust-test'])).toBe(
      'adjust-controller-test',
    );
    expect(readEffectLayerTargetMap(insertion.project)['adjust-controller-test']).toBe(
      'showcase-intro',
    );
    expect(
      insertion.project.visualObjects['adjust-controller-test']?.effects?.map(
        (effect) => effect.effectId,
      ),
    ).toEqual(['brightness-contrast', 'hue-saturation', 'vibrance']);
  });

  it('rejects a Text clip as a parent', () => {
    const { timeline, visual } = buildTimelineElementsShowcase();
    expect(() =>
      buildAdjustmentLayerInsertion({
        timeline,
        project: visual,
        targetClipId: 'showcase-text',
        token: 'invalid',
      }),
    ).toThrow('video or picture');
  });

  it.each([
    ['effect', 'Effects-test', 'effect-test', 'joy-effect-layer'],
    ['filter', 'Filters-test', 'filter-test', 'joy-filter-layer'],
  ] as const)('creates a real %s controller layer', (kind, trackId, clipId, assetId) => {
    const { timeline, visual } = buildTimelineElementsShowcase();
    const insertion = buildTreatmentLayerInsertion({
      timeline,
      project: visual,
      targetClipId: 'showcase-product',
      token: 'test',
      kind,
    });
    const next = applyTransaction(timeline, insertion.timeline).project;
    expect(next.compositions.root!.tracks.find((track) => track.id === trackId)?.clips[0]).toEqual(
      expect.objectContaining({ id: clipId, assetId }),
    );
    expect(readTimelineElementKindMap(insertion.project)[clipId]).toBe(kind);
    expect(readEffectLayerTargetMap(insertion.project)[`${kind}-controller-test`]).toBe(
      'showcase-product',
    );
  });
});
