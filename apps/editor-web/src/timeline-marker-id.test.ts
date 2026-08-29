import { describe, expect, it } from 'vitest';
import { nextTimelineMarkerId, nextTimelineMarkerLabel } from './timeline-marker-id.js';

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

  it('allocates the next label above existing generated labels', () => {
    expect(
      nextTimelineMarkerLabel([
        { label: 'Marker 1' },
        { label: 'Marker 3' },
        { label: 'Chapter intro' },
      ]),
    ).toBe('Marker 4');
  });

  it('preserves a caller-supplied custom label', () => {
    expect(nextTimelineMarkerLabel([{ label: 'Marker 1' }], 'Hero beat')).toBe('Hero beat');
  });

  it('resolves a generated requested label against the current project', () => {
    expect(
      nextTimelineMarkerLabel([{ label: 'Marker 1' }, { label: 'Marker 2' }], 'Marker 2'),
    ).toBe('Marker 3');
  });
});
