import { describe, expect, it } from 'vitest';
import { resolveObjectIdForSelection } from './sticker-bindings.js';
import {
  activeEffectLayerObjects,
  readEffectLayerTargetMap,
  readTimelineElementKindMap,
  timelineElementKindForClip,
} from './timeline-element-kind.js';
import {
  buildTimelineElementsShowcase,
  TIMELINE_ELEMENTS_SHOWCASE,
} from './timeline-elements-showcase.js';

describe('Timeline Elements Showcase', () => {
  it('contains every authored layer kind, CC, and Motion without Stickers', () => {
    const { timeline, visual } = buildTimelineElementsShowcase();
    const kinds = readTimelineElementKindMap(visual);
    const clips = timeline.compositions.root!.tracks.flatMap((track) => track.clips);
    const represented = new Set(clips.map((clip) => timelineElementKindForClip(clip, kinds)));

    expect(timeline.id).toBe(TIMELINE_ELEMENTS_SHOWCASE.id);
    expect(represented).toEqual(
      new Set([
        'video',
        'overlay',
        'text',
        'caption',
        'motion',
        'effect',
        'filter',
        'adjust',
        'audio',
      ]),
    );
    expect([...represented]).not.toContain('sticker');
    expect(timeline.compositions.root!.tracks.map((track) => track.id)).toEqual([
      'Video 1',
      'Video 2',
      'Overlay',
      'Text',
      'Captions',
      'Motion',
      'Effects',
      'Filters',
      'Adjust',
      'Audio',
    ]);
    expect(visual.transitions).toEqual([
      expect.objectContaining({
        id: 'showcase-transition',
        leftClipId: 'showcase-intro',
        rightClipId: 'showcase-product',
      }),
    ]);
    expect(visual.captionDocuments['showcase-captions-en']?.segments).toHaveLength(2);
  });

  it('stores Adjust as an independent controller targeted at the parent video', () => {
    const { timeline, visual } = buildTimelineElementsShowcase();
    const targets = readEffectLayerTargetMap(visual);
    expect(resolveObjectIdForSelection(visual, ['showcase-adjust'])).toBe(
      'showcase-adjust-controller',
    );
    expect(targets['showcase-adjust-controller']).toBe('showcase-product');
    expect(
      activeEffectLayerObjects(visual, timeline, 'showcase-product', 7_000_000).map(
        (object) => object.id,
      ),
    ).toEqual(expect.arrayContaining(['showcase-effect-controller', 'showcase-adjust-controller']));
    expect(activeEffectLayerObjects(visual, timeline, 'showcase-product', 2_000_000)).toEqual([]);
  });
});
