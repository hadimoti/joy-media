import { describe, expect, it } from 'vitest';
import type { SpatialKeyframe } from './spatial.js';
import { sampleSpatialPath } from './spatial.js';

const straight: readonly SpatialKeyframe[] = [
  { timeUs: 0, point: { x: 0, y: 0 }, interpolation: 'linear' },
  { timeUs: 1_000_000, point: { x: 100, y: 0 }, interpolation: 'linear' },
];

describe('sampleSpatialPath', () => {
  it('is flat outside the path range', () => {
    expect(sampleSpatialPath(straight, -1)).toEqual({ x: 0, y: 0 });
    expect(sampleSpatialPath(straight, 9_000_000)).toEqual({ x: 100, y: 0 });
  });

  it('interpolates linearly when there are no tangents', () => {
    expect(sampleSpatialPath(straight, 500_000)).toEqual({ x: 50, y: 0 });
  });

  it('bows off the straight line when a tangent is present', () => {
    const arced: readonly SpatialKeyframe[] = [
      {
        timeUs: 0,
        point: { x: 0, y: 0 },
        interpolation: 'linear',
        outTangent: { x: 50, y: 100 },
      },
      {
        timeUs: 1_000_000,
        point: { x: 100, y: 0 },
        interpolation: 'linear',
        inTangent: { x: -50, y: 100 },
      },
    ];
    const mid = sampleSpatialPath(arced, 500_000);
    expect(mid.x).toBeCloseTo(50, 6);
    // The control handles pull the midpoint upward off the y = 0 line.
    expect(mid.y).toBeGreaterThan(50);
  });

  it('holds the point across the segment for hold mode', () => {
    const held: readonly SpatialKeyframe[] = [
      { timeUs: 0, point: { x: 10, y: 20 }, interpolation: 'hold' },
      { timeUs: 1_000_000, point: { x: 99, y: 99 }, interpolation: 'linear' },
    ];
    expect(sampleSpatialPath(held, 500_000)).toEqual({ x: 10, y: 20 });
  });

  it('throws on an empty path', () => {
    expect(() => sampleSpatialPath([], 0)).toThrow();
  });
});
