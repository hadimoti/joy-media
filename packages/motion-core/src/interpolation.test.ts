import { describe, expect, it } from 'vitest';
import type { KeyframeV1 } from '@joy-media/project-schema';
import { cubicBezierEase, EASED_HANDLES, interpolateSegment } from './interpolation.js';

const left = (over: Partial<KeyframeV1> = {}): KeyframeV1 => ({
  timeUs: 0,
  value: 0,
  interpolation: 'linear',
  ...over,
});
const right = (over: Partial<KeyframeV1> = {}): KeyframeV1 => ({
  timeUs: 1_000_000,
  value: 100,
  interpolation: 'linear',
  ...over,
});

describe('cubicBezierEase', () => {
  it('pins the endpoints', () => {
    expect(cubicBezierEase(EASED_HANDLES, 0)).toBe(0);
    expect(cubicBezierEase(EASED_HANDLES, 1)).toBe(1);
  });

  it('is symmetric at the midpoint for a symmetric ease', () => {
    expect(cubicBezierEase(EASED_HANDLES, 0.5)).toBeCloseTo(0.5, 5);
  });

  it('a linear-handle bezier reproduces the identity', () => {
    const linear = { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 };
    for (const t of [0.1, 0.25, 0.4, 0.75, 0.9])
      expect(cubicBezierEase(linear, t)).toBeCloseTo(t, 4);
  });

  it('ease-in-out sits below the diagonal early and above it late', () => {
    expect(cubicBezierEase(EASED_HANDLES, 0.25)).toBeLessThan(0.25);
    expect(cubicBezierEase(EASED_HANDLES, 0.75)).toBeGreaterThan(0.75);
  });
});

describe('interpolateSegment', () => {
  it('holds the left value across the whole segment for hold mode', () => {
    const segment = [left({ interpolation: 'hold' }), right()] as const;
    expect(interpolateSegment(segment[0], segment[1], 250_000)).toBe(0);
    expect(interpolateSegment(segment[0], segment[1], 999_999)).toBe(0);
    // The right edge belongs to the next keyframe's value.
    expect(interpolateSegment(segment[0], segment[1], 1_000_000)).toBe(0);
  });

  it('linearly interpolates by time fraction', () => {
    expect(interpolateSegment(left(), right(), 250_000)).toBeCloseTo(25, 6);
    expect(interpolateSegment(left(), right(), 500_000)).toBeCloseTo(50, 6);
  });

  it('eased interpolation still reaches both endpoints', () => {
    const l = left({ interpolation: 'eased' });
    expect(interpolateSegment(l, right(), 0)).toBe(0);
    expect(interpolateSegment(l, right(), 1_000_000)).toBe(100);
    expect(interpolateSegment(l, right(), 250_000)).toBeLessThan(25);
  });

  it('clamps outside the segment', () => {
    expect(interpolateSegment(left(), right(), -5)).toBe(0);
    expect(interpolateSegment(left(), right(), 2_000_000)).toBe(100);
  });
});
