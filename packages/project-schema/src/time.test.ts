import { describe, expect, it } from 'vitest';
import {
  clipTimeRange,
  compareRationals,
  frameIndexAtUs,
  frameStartUs,
  intersectRanges,
  normalizeRational,
  rangeContainsUs,
  rangeEndUs,
  rational,
  rationalsEqual,
  snapUsToFrame,
  timeRange,
} from './time.js';

const RATES = [
  rational(24, 1),
  rational(25, 1),
  rational(30, 1),
  rational(60, 1),
  rational(24000, 1001),
  rational(30000, 1001),
  rational(60000, 1001),
  rational(120000, 1001),
];

describe('rational', () => {
  it('rejects non-positive and non-integer components', () => {
    expect(() => rational(0, 1)).toThrow(RangeError);
    expect(() => rational(30, 0)).toThrow(RangeError);
    expect(() => rational(-30, 1)).toThrow(RangeError);
    expect(() => rational(29.97, 1)).toThrow(RangeError);
  });

  it('normalizes to lowest terms', () => {
    expect(normalizeRational(rational(60000, 2002))).toEqual({ num: 30000, den: 1001 });
    expect(normalizeRational(rational(30, 1))).toEqual({ num: 30, den: 1 });
  });

  it('compares exactly without normalization', () => {
    expect(rationalsEqual(rational(30000, 1001), rational(60000, 2002))).toBe(true);
    expect(rationalsEqual(rational(30000, 1001), rational(30, 1))).toBe(false);
    expect(compareRationals(rational(30000, 1001), rational(30, 1))).toBe(-1);
    expect(compareRationals(rational(30, 1), rational(30000, 1001))).toBe(1);
    expect(compareRationals(rational(24, 1), rational(48, 2))).toBe(0);
  });
});

describe('frame mapping', () => {
  it('frame 0 starts at 0 for every rate', () => {
    for (const rate of RATES) {
      expect(frameStartUs(0, rate)).toBe(0);
    }
  });

  it('produces exact known NTSC frame starts', () => {
    const ntsc = rational(30000, 1001);
    // frame i starts at ceil(i * 1001000000 / 30000) µs
    expect(frameStartUs(1, ntsc)).toBe(33367);
    expect(frameStartUs(2, ntsc)).toBe(66734);
    expect(frameStartUs(30, ntsc)).toBe(1001000);
    expect(frameStartUs(30000, ntsc)).toBe(1001000000);
  });

  it('round-trips frameIndexAtUs(frameStartUs(i)) === i across rates and frames', () => {
    for (const rate of RATES) {
      for (let i = 0; i < 5000; i++) {
        expect(frameIndexAtUs(frameStartUs(i, rate), rate)).toBe(i);
      }
      // large frame indices stay exact (BigInt internals)
      for (const i of [1_000_000, 123_456_789, 2_000_000_000]) {
        expect(frameIndexAtUs(frameStartUs(i, rate), rate)).toBe(i);
      }
    }
  });

  it('the microsecond before a frame start belongs to the previous frame', () => {
    for (const rate of RATES) {
      for (let i = 1; i < 2000; i++) {
        expect(frameIndexAtUs(frameStartUs(i, rate) - 1, rate)).toBe(i - 1);
      }
    }
  });

  it('frame starts are strictly increasing', () => {
    for (const rate of RATES) {
      let previous = -1;
      for (let i = 0; i < 2000; i++) {
        const start = frameStartUs(i, rate);
        expect(start).toBeGreaterThan(previous);
        previous = start;
      }
    }
  });

  it('snapUsToFrame is idempotent and never moves time forward', () => {
    const ntsc = rational(30000, 1001);
    for (const t of [0, 1, 33366, 33367, 500_000, 999_999, 1_001_000]) {
      const snapped = snapUsToFrame(t, ntsc);
      expect(snapped).toBeLessThanOrEqual(t);
      expect(snapUsToFrame(snapped, ntsc)).toBe(snapped);
      expect(frameIndexAtUs(snapped, ntsc)).toBe(frameIndexAtUs(t, ntsc));
    }
  });

  it('all conversions return safe integers, never floats', () => {
    for (const rate of RATES) {
      for (const i of [0, 1, 7, 999, 123_456]) {
        expect(Number.isSafeInteger(frameStartUs(i, rate))).toBe(true);
        expect(Number.isSafeInteger(frameIndexAtUs(frameStartUs(i, rate), rate))).toBe(true);
      }
    }
  });

  it('rejects negative and non-integer inputs', () => {
    const rate = rational(30, 1);
    expect(() => frameStartUs(-1, rate)).toThrow(RangeError);
    expect(() => frameStartUs(1.5, rate)).toThrow(RangeError);
    expect(() => frameIndexAtUs(-1, rate)).toThrow(RangeError);
    expect(() => frameIndexAtUs(0.5, rate)).toThrow(RangeError);
  });
});

describe('time ranges', () => {
  it('markers may have zero duration; clips may not (§10.5 v1.1)', () => {
    expect(timeRange(0, 0)).toEqual({ startUs: 0, durationUs: 0 });
    expect(() => clipTimeRange(0, 0)).toThrow(RangeError);
    expect(clipTimeRange(0, 1)).toEqual({ startUs: 0, durationUs: 1 });
  });

  it('rejects negative starts and durations', () => {
    expect(() => timeRange(-1, 10)).toThrow(RangeError);
    expect(() => timeRange(0, -1)).toThrow(RangeError);
  });

  it('containment is end-exclusive', () => {
    const range = clipTimeRange(1000, 500);
    expect(rangeContainsUs(range, 999)).toBe(false);
    expect(rangeContainsUs(range, 1000)).toBe(true);
    expect(rangeContainsUs(range, 1499)).toBe(true);
    expect(rangeContainsUs(range, 1500)).toBe(false);
    expect(rangeEndUs(range)).toBe(1500);
  });

  it('intersects overlapping ranges and rejects touching ones', () => {
    expect(intersectRanges(timeRange(0, 100), timeRange(50, 100))).toEqual({
      startUs: 50,
      durationUs: 50,
    });
    // end-exclusive: [0,100) and [100,200) share no microsecond
    expect(intersectRanges(timeRange(0, 100), timeRange(100, 100))).toBeNull();
    expect(intersectRanges(timeRange(0, 10), timeRange(50, 10))).toBeNull();
  });
});
