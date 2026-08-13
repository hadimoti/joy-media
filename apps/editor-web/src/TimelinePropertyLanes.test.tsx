import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { VisualObjectV1 } from '@joy-media/project-schema';
import {
  buildLegacyTransformPropertyLanes,
  TimelinePropertyLanes,
  visiblePropertyKeys,
} from './TimelinePropertyLanes.js';

const OBJECT: VisualObjectV1 = {
  id: 'title',
  kind: 'text',
  text: 'JOY',
  transform: {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  },
  animations: {
    x: {
      keyframes: [
        { timeUs: 0, value: 0, interpolation: 'linear' },
        { timeUs: 1_000_000, value: 100, interpolation: 'linear' },
      ],
    },
  },
};

describe('TimelinePropertyLanes', () => {
  it('renders animated selected-object lanes with frame-key controls', () => {
    const markup = renderToStaticMarkup(
      <TimelinePropertyLanes
        object={OBJECT}
        playheadUs={0}
        frameUs={33_333}
        pixelsPerSecond={100}
        laneWidthPx={1000}
        scrollLeft={0}
        viewportWidthPx={500}
        showAnimatedOnly
        onShowAnimatedOnlyChange={() => undefined}
        onSeek={() => undefined}
        onDispatch={() => undefined}
      />,
    );
    expect(
      buildLegacyTransformPropertyLanes(OBJECT).find((lane) => lane.property === 'x')?.keys,
    ).toHaveLength(2);
    expect(markup).toContain('Show animated');
    expect(markup).toContain('data-property-lane="x"');
    expect(markup).toContain('Previous Position X keyframe');
    expect(markup).toContain('Remove Position X keyframe');
    expect(markup).toContain('Next Position X keyframe');
  });

  it('virtualizes large key sets to the visible time window plus overscan', () => {
    const keys = Array.from({ length: 10_000 }, (_, index) => ({
      timeUs: index * 100_000,
      value: index,
    }));
    const visible = visiblePropertyKeys(keys, 10_000_000, 12_000_000, 1_000_000);
    expect(visible.length).toBeLessThan(50);
    expect(visible[0]?.timeUs).toBe(9_000_000);
    expect(visible.at(-1)?.timeUs).toBe(13_000_000);
  });
});
