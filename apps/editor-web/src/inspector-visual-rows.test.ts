import { describe, expect, it } from 'vitest';
import {
  linkedScalePair,
  MIN_VISUAL_SCALE,
  opacityFromPercent,
  opacityToPercent,
} from './inspector-visual-rows.js';

describe('opacity percent conversion (T-D08)', () => {
  it('shows the stored 0 to 1 value as a percentage with at most one decimal', () => {
    expect(opacityToPercent(1)).toBe(100);
    expect(opacityToPercent(0)).toBe(0);
    expect(opacityToPercent(0.5)).toBe(50);
    expect(opacityToPercent(0.333)).toBe(33.3);
  });

  it('stores a typed percentage as 0 to 1, clamped and without float tails', () => {
    expect(opacityFromPercent(33)).toBe(0.33);
    expect(opacityFromPercent(100)).toBe(1);
    expect(opacityFromPercent(0)).toBe(0);
    expect(opacityFromPercent(250)).toBe(1);
    expect(opacityFromPercent(-5)).toBe(0);
    expect(opacityFromPercent(12.5)).toBe(0.125);
  });

  it('has no stored value for a non-finite percentage', () => {
    expect(opacityFromPercent(Number.NaN)).toBeUndefined();
    expect(opacityFromPercent(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('round-trips every whole percentage exactly', () => {
    for (let percent = 0; percent <= 100; percent += 1) {
      expect(opacityToPercent(opacityFromPercent(percent)!)).toBe(percent);
    }
  });
});

describe('linked scale (T-D08)', () => {
  it('scales the other axis by the same ratio when X changes', () => {
    expect(linkedScalePair({ scaleX: 1, scaleY: 0.5 }, 'scaleX', 2)).toEqual({
      scaleX: 2,
      scaleY: 1,
    });
  });

  it('scales the other axis by the same ratio when Y changes', () => {
    expect(linkedScalePair({ scaleX: 2, scaleY: 1 }, 'scaleY', 0.5)).toEqual({
      scaleX: 1,
      scaleY: 0.5,
    });
  });

  it('keeps equal scales equal', () => {
    expect(linkedScalePair({ scaleX: 1, scaleY: 1 }, 'scaleX', 1.5)).toEqual({
      scaleX: 1.5,
      scaleY: 1.5,
    });
  });

  it('keeps the proportion across repeated edits', () => {
    const start = { scaleX: 2, scaleY: 1 };
    const first = linkedScalePair(start, 'scaleX', 3)!;
    expect(first.scaleY / first.scaleX).toBeCloseTo(start.scaleY / start.scaleX, 4);
  });

  it('rejects a requested scale that is not a usable value', () => {
    expect(linkedScalePair({ scaleX: 1, scaleY: 1 }, 'scaleX', 0)).toBeUndefined();
    expect(linkedScalePair({ scaleX: 1, scaleY: 1 }, 'scaleX', -1)).toBeUndefined();
    expect(linkedScalePair({ scaleX: 1, scaleY: 1 }, 'scaleX', Number.NaN)).toBeUndefined();
  });

  it('rejects a pair when the partner would fall below the minimum scale', () => {
    // The requested 0.4 is valid, but scaleY 0.002 * (0.4 / 1) = 0.0008 is below the minimum.
    expect(linkedScalePair({ scaleX: 1, scaleY: 0.002 }, 'scaleX', 0.4)).toBeUndefined();
    // Exactly at the minimum is still a usable pair.
    expect(linkedScalePair({ scaleX: 1, scaleY: 0.002 }, 'scaleX', 0.5)).toEqual({
      scaleX: 0.5,
      scaleY: MIN_VISUAL_SCALE,
    });
  });

  it('rejects a pair when the current edited scale is not positive', () => {
    expect(linkedScalePair({ scaleX: 0, scaleY: 1 }, 'scaleX', 2)).toBeUndefined();
  });
});
