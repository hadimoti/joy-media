import type {
  AnimationCurveV1,
  AnimationValueV2,
  CurveSnapshotKeyV2,
} from '@joy-media/project-schema';
import { describe, expect, it } from 'vitest';
import {
  sampleAnimationValue,
  sampleChannels,
  sampleCurveSnapshots,
  sampleDiscreteKeys,
  sampleWrappedCurve,
} from './property-sampling.js';

const linear = (from: number, to: number): AnimationCurveV1 => ({
  keyframes: [
    { timeUs: 0, value: from, interpolation: 'linear' },
    { timeUs: 1_000_000, value: to, interpolation: 'linear' },
  ],
});

describe('WP34 compound and discrete property samplers', () => {
  it('samples scalar, vector, and linear-color values at boundaries and midpoints', () => {
    expect(sampleAnimationValue({ kind: 'scalar', curve: linear(0, 10) }, 500_000)).toBe(5);
    expect(sampleChannels({ x: linear(0, 10), y: linear(10, 0) }, 500_000)).toEqual({ x: 5, y: 5 });
    expect(
      sampleAnimationValue(
        { kind: 'color', curve: { r: linear(0, 1), g: linear(1, 0), b: linear(0.25, 0.75) } },
        500_000,
      ),
    ).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
  });

  it('takes the shortest path across hue and angle wraparound', () => {
    const curve = linear(350, 10);
    expect(sampleWrappedCurve(curve, 0)).toBe(350);
    expect(sampleWrappedCurve(curve, 500_000)).toBe(0);
    expect(sampleAnimationValue({ kind: 'hue', curve }, 750_000)).toBe(5);
    expect(sampleAnimationValue({ kind: 'angle', curve }, 1_000_000)).toBe(10);
  });

  it('holds boolean and string values until the next discrete key', () => {
    expect(
      sampleDiscreteKeys(
        [
          { timeUs: 0, value: false },
          { timeUs: 1_000_000, value: true },
        ],
        999_999,
      ),
    ).toBe(false);
    expect(
      sampleDiscreteKeys(
        [
          { timeUs: 0, value: 'none' },
          { timeUs: 1_000_000, value: 'film' },
        ],
        1_000_000,
      ),
    ).toBe('film');
  });

  it('holds or linearly blends compatible curve snapshot tables', () => {
    const snapshots: readonly CurveSnapshotKeyV2[] = [
      { timeUs: 0, interpolation: 'linear', channels: { rgb: [0, 1], red: [0.2, 0.8] } },
      { timeUs: 1_000_000, interpolation: 'hold', channels: { rgb: [1, 0], red: [0.4, 0.6] } },
      {
        timeUs: 2_000_000,
        interpolation: 'linear',
        channels: { rgb: [0.5, 0.5], red: [0.3, 0.7] },
      },
    ];
    const blended = sampleCurveSnapshots(snapshots, 500_000);
    expect(blended.rgb).toEqual([0.5, 0.5]);
    expect(blended.red).toEqual([expect.closeTo(0.3, 12), expect.closeTo(0.7, 12)]);
    expect(sampleCurveSnapshots(snapshots, 1_500_000)).toEqual({ rgb: [1, 0], red: [0.4, 0.6] });
  });

  it('rejects duplicate times, malformed handles, and incompatible snapshot tables deterministically', () => {
    expect(() =>
      sampleWrappedCurve(
        {
          keyframes: [
            { timeUs: 0, value: 0, interpolation: 'linear' },
            { timeUs: 0, value: 1, interpolation: 'linear' },
          ],
        },
        0,
      ),
    ).toThrow(/strictly increasing/);
    expect(() =>
      sampleAnimationValue(
        {
          kind: 'scalar',
          curve: {
            keyframes: [
              {
                timeUs: 0,
                value: 0,
                interpolation: 'bezier',
                bezier: { x1: -1, y1: 0, x2: 1, y2: 1 },
              },
            ],
          },
        },
        0,
      ),
    ).toThrow(/handle x coordinates/);
    expect(() =>
      sampleCurveSnapshots(
        [
          { timeUs: 0, interpolation: 'linear', channels: { rgb: [0] } },
          { timeUs: 2, interpolation: 'linear', channels: { red: [1] } },
        ],
        1,
      ),
    ).toThrow(/channels must match/);
  });
});
