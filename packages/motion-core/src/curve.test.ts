import { describe, expect, it } from 'vitest';
import type { AnimationCurveV1 } from '@joy-media/project-schema';
import {
  copyKeyframes,
  hasKeyframeAt,
  pasteKeyframes,
  removeKeyframe,
  sampleCurve,
  scaleCurveValues,
  setKeyframe,
} from './curve.js';

const curve: AnimationCurveV1 = {
  keyframes: [
    { timeUs: 0, value: 0, interpolation: 'linear' },
    { timeUs: 1_000_000, value: 100, interpolation: 'linear' },
    { timeUs: 2_000_000, value: 50, interpolation: 'hold' },
  ],
};

describe('sampleCurve', () => {
  it('is flat before the first and after the last keyframe', () => {
    expect(sampleCurve(curve, -1)).toBe(0);
    expect(sampleCurve(curve, 5_000_000)).toBe(50);
  });

  it('interpolates within a segment and honors the left keyframe mode', () => {
    expect(sampleCurve(curve, 500_000)).toBeCloseTo(50, 6);
    expect(sampleCurve(curve, 1_500_000)).toBeCloseTo(75, 6); // linear from 100 -> 50
  });

  it('lands exactly on keyframe values', () => {
    expect(sampleCurve(curve, 1_000_000)).toBe(100);
    expect(sampleCurve(curve, 2_000_000)).toBe(50);
  });

  it('throws on an empty curve', () => {
    expect(() => sampleCurve({ keyframes: [] }, 0)).toThrow();
  });

  it('selects the correct segment when the curve has many keys', () => {
    const manyKeys: AnimationCurveV1 = {
      keyframes: Array.from({ length: 101 }, (_, index) => ({
        timeUs: index * 1_000,
        value: index,
        interpolation: 'linear' as const,
      })),
    };
    expect(sampleCurve(manyKeys, 54_500)).toBeCloseTo(54.5, 6);
  });
});

describe('setKeyframe / removeKeyframe', () => {
  it('inserts in sorted order and can seed a channel from nothing', () => {
    const seeded = setKeyframe(undefined, { timeUs: 500_000, value: 9, interpolation: 'linear' });
    expect(seeded.keyframes).toHaveLength(1);
    const inserted = setKeyframe(seeded, { timeUs: 0, value: 1, interpolation: 'linear' });
    expect(inserted.keyframes.map((k) => k.timeUs)).toEqual([0, 500_000]);
  });

  it('replaces a keyframe at the same time rather than duplicating it', () => {
    const replaced = setKeyframe(curve, { timeUs: 1_000_000, value: 42, interpolation: 'hold' });
    expect(replaced.keyframes).toHaveLength(3);
    expect(sampleCurve(replaced, 1_000_000)).toBe(42);
  });

  it('removes a keyframe and drops the curve when the last one goes', () => {
    expect(removeKeyframe(curve, 1_000_000)?.keyframes).toHaveLength(2);
    const single: AnimationCurveV1 = { keyframes: [curve.keyframes[0]!] };
    expect(removeKeyframe(single, 0)).toBeUndefined();
  });

  it('reports keyframe presence at an exact time', () => {
    expect(hasKeyframeAt(curve, 1_000_000)).toBe(true);
    expect(hasKeyframeAt(curve, 1_500_000)).toBe(false);
  });
});

describe('scaleCurveValues', () => {
  it('scales around the default zero pivot', () => {
    const scaled = scaleCurveValues(curve, 2);
    expect(scaled.keyframes.map((k) => k.value)).toEqual([0, 200, 100]);
  });

  it('scales around a supplied pivot', () => {
    const scaled = scaleCurveValues(curve, 0.5, 100);
    // 100 + (value - 100) * 0.5
    expect(scaled.keyframes.map((k) => k.value)).toEqual([50, 100, 75]);
  });

  it('rejects a non-finite factor', () => {
    expect(() => scaleCurveValues(curve, Number.NaN)).toThrow();
  });
});

describe('copy / paste', () => {
  it('copies a time window relative to the first selected keyframe', () => {
    const clip = copyKeyframes(curve, 1_000_000, 2_000_000);
    expect(clip.relative.map((k) => k.timeUs)).toEqual([0, 1_000_000]);
    expect(clip.relative.map((k) => k.value)).toEqual([100, 50]);
  });

  it('pastes at an anchor time onto an existing curve', () => {
    const clip = copyKeyframes(curve, 0, 1_000_000);
    const pasted = pasteKeyframes(curve, clip, 3_000_000);
    expect(hasKeyframeAt(pasted, 3_000_000)).toBe(true);
    expect(hasKeyframeAt(pasted, 4_000_000)).toBe(true);
  });

  it('rejects a paste that would produce a negative time', () => {
    const clip: ReturnType<typeof copyKeyframes> = {
      relative: [{ timeUs: 0, value: 1, interpolation: 'linear' }],
    };
    expect(() => pasteKeyframes(undefined, clip, -10)).toThrow();
  });

  it('rejects pasting an empty clipboard', () => {
    expect(() => pasteKeyframes(undefined, { relative: [] }, 0)).toThrow();
  });
});
