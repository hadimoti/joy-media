import { describe, expect, it } from 'vitest';
import { nextTimelineMarkerId } from './timeline-marker-id.js';

describe('nextTimelineMarkerId', () => {
  it('uses the stable time-based id when it is unused', () => {
    expect(nextTimelineMarkerId([], 0)).toBe('marker-0');
  });

  it('chooses the first deterministic free suffix after collisions', () => {
    const markers = [{ id: 'marker-0' }, { id: 'marker-0-1' }, { id: 'marker-0-3' }];

    expect(nextTimelineMarkerId(markers, 0)).toBe('marker-0-2');
    expect(nextTimelineMarkerId([...markers, { id: 'marker-0-2' }], 0)).toBe('marker-0-4');
  });

  it('does not treat a marker at another time as a collision', () => {
    expect(nextTimelineMarkerId([{ id: 'marker-1000000' }], 0)).toBe('marker-0');
  });
});
