import { describe, expect, it } from 'vitest';
import { effectInstancesForTimelineClip, effectsByObjectIdAt } from './adjustment-render.js';
import { withEffectLayerTarget } from './timeline-element-kind.js';
import { buildTimelineElementsShowcase } from './timeline-elements-showcase.js';

describe('targeted adjustment rendering', () => {
  it('applies controllers only while their independent timeline layers are active', () => {
    const { timeline, visual } = buildTimelineElementsShowcase();

    expect(effectInstancesForTimelineClip(visual, timeline, 'showcase-product', 2_000_000)).toEqual(
      [],
    );
    expect(
      effectInstancesForTimelineClip(visual, timeline, 'showcase-product', 7_000_000).map(
        (effect) => effect.id,
      ),
    ).toEqual(
      expect.arrayContaining([
        'showcase-glow',
        'showcase-adjust-contrast',
        'showcase-adjust-vibrance',
      ]),
    );
    expect(
      effectInstancesForTimelineClip(visual, timeline, 'showcase-product', 13_000_000).map(
        (effect) => effect.id,
      ),
    ).toContain('showcase-filter-hue');
    expect(
      effectInstancesForTimelineClip(visual, timeline, 'showcase-product', 19_000_000),
    ).toEqual([]);
  });

  it('can retarget Adjust from video to a picture/overlay object', () => {
    const { timeline, visual } = buildTimelineElementsShowcase();
    const retargeted = withEffectLayerTarget(
      visual,
      'showcase-adjust-controller',
      'showcase-overlay',
    );
    const routed = effectsByObjectIdAt(retargeted, timeline, 7_000_000);

    expect(routed['showcase-overlay-object']?.map((effect) => effect.id)).toEqual([
      'showcase-adjust-contrast',
      'showcase-adjust-vibrance',
    ]);
  });
});
