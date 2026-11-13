import { describe, expect, it } from 'vitest';
import { ColorCurveSpline } from './color-curve-spline.js';
import { buildColorCurveLut, sampleColorCurve } from './color-grade-math.js';

/*
 * T-K03 review fix: the spline is prepared once and sampled without
 * allocation. These tests hold it to the old code, kept here word for word,
 * on random curves: the output must be exactly the same.
 */

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** The old `sampleColorCurve`, before the review fix. */
function oldSampleColorCurve(points: readonly { x: number; y: number }[], input: number): number {
  if (points.length < 2) return clamp01(input);
  const sorted = points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: clamp01(point.x), y: clamp01(point.y) }))
    .sort((left, right) => left.x - right.x)
    .filter((point, index, values) => index === 0 || point.x > values[index - 1]!.x);
  if (sorted.length < 2) return clamp01(input);
  const x = clamp01(input);
  if (x <= sorted[0]!.x) return sorted[0]!.y;
  const lastIndex = sorted.length - 1;
  if (x >= sorted[lastIndex]!.x) return sorted[lastIndex]!.y;
  const slopes = sorted.slice(0, -1).map((point, index) => {
    const next = sorted[index + 1]!;
    return (next.y - point.y) / (next.x - point.x);
  });
  const tangents = sorted.map((_, index) => {
    if (index === 0) return slopes[0]!;
    if (index === lastIndex) return slopes[lastIndex - 1]!;
    const before = slopes[index - 1]!;
    const after = slopes[index]!;
    if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) return 0;
    const h0 = sorted[index]!.x - sorted[index - 1]!.x;
    const h1 = sorted[index + 1]!.x - sorted[index]!.x;
    const w1 = 2 * h1 + h0;
    const w2 = h1 + 2 * h0;
    return (w1 + w2) / (w1 / before + w2 / after);
  });
  for (let index = 0; index < lastIndex; index += 1) {
    const left = sorted[index]!;
    const right = sorted[index + 1]!;
    if (x > right.x) continue;
    const width = right.x - left.x;
    const t = (x - left.x) / width;
    const t2 = t * t;
    const t3 = t2 * t;
    return clamp01(
      (2 * t3 - 3 * t2 + 1) * left.y +
        (t3 - 2 * t2 + t) * width * tangents[index]! +
        (-2 * t3 + 3 * t2) * right.y +
        (t3 - t2) * width * tangents[index + 1]!,
    );
  }
  return sorted[lastIndex]!.y;
}

/** The old `buildColorCurveLut`. */
function oldBuildColorCurveLut(points: readonly { x: number; y: number }[]): Uint8Array {
  return Uint8Array.from({ length: 256 }, (_, index) =>
    Math.round(oldSampleColorCurve(points, index / 255) * 255),
  );
}

/** A small seeded random generator, so a failure can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random curves of every kind the engine may be handed, tidy or not. */
function randomCurve(next: () => number): { x: number; y: number }[] {
  const count = Math.floor(next() * 18);
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const kind = next();
    if (kind < 0.04) points.push({ x: Number.NaN, y: next() });
    else if (kind < 0.07) points.push({ x: next(), y: Number.POSITIVE_INFINITY });
    else if (kind < 0.15) points.push({ x: next() * 1.4 - 0.2, y: next() * 1.4 - 0.2 });
    else if (kind < 0.22 && points.length > 0)
      points.push({ x: points[points.length - 1]!.x, y: next() });
    else if (kind < 0.27) points.push({ x: Math.round(next() * 4) / 4, y: next() });
    else points.push({ x: next(), y: next() });
  }
  return points;
}

describe('ColorCurveSpline', () => {
  it('gives exactly the old output on random curves', () => {
    const next = random(20261113);
    const spline = new ColorCurveSpline();
    for (let curve = 0; curve < 2000; curve += 1) {
      const points = randomCurve(next);
      spline.prepare(points);
      for (let sample = 0; sample < 64; sample += 1) {
        const input =
          sample < 4 ? [0, 1, -0.5, 1.5][sample]! : sample < 8 ? (sample - 4) / 3 : next();
        const expected = oldSampleColorCurve(points, input);
        expect(Object.is(spline.valueAt(input), expected)).toBe(true);
        expect(Object.is(sampleColorCurve(points, input), expected)).toBe(true);
      }
    }
  });

  it('builds exactly the old 256-entry tables', () => {
    const next = random(7);
    for (let curve = 0; curve < 500; curve += 1) {
      const points = randomCurve(next);
      expect(Array.from(buildColorCurveLut(points))).toEqual(
        Array.from(oldBuildColorCurveLut(points)),
      );
    }
  });

  it('keeps the old answers for the edge cases', () => {
    const cases: { x: number; y: number }[][] = [
      [],
      [{ x: 0.5, y: 0.2 }],
      [
        { x: 0.5, y: 0.2 },
        { x: 0.5, y: 0.9 },
      ],
      [
        { x: 1, y: 1 },
        { x: 0, y: 0 },
        { x: 0.5, y: 0.8 },
      ],
      [
        { x: 0.2, y: 0.3 },
        { x: 0.2, y: 0.6 },
        { x: 0.8, y: 0.7 },
        { x: 0.8, y: 0.1 },
      ],
      [
        { x: Number.NaN, y: 0 },
        { x: 0.3, y: 0.3 },
      ],
    ];
    const spline = new ColorCurveSpline();
    for (const points of cases)
      for (const input of [Number.NaN, -1, 0, 0.1, 0.2, 0.25, 0.5, 0.8, 0.99, 1, 2]) {
        const expected = oldSampleColorCurve(points, input);
        expect(Object.is(spline.prepare(points).valueAt(input), expected)).toBe(true);
      }
  });

  it('samples without allocating: one set of buffers for every curve that fits', () => {
    const next = random(42);
    const spline = new ColorCurveSpline();
    const buffers = spline as unknown as Record<'xs' | 'ys' | 'slopes' | 'tangents', Float64Array>;
    const before = [buffers.xs, buffers.ys, buffers.slopes, buffers.tangents];
    for (let curve = 0; curve < 300; curve += 1) {
      const points = randomCurve(next).slice(0, 16);
      spline.prepare(points);
      for (let sample = 0; sample < 256; sample += 1) spline.valueAt(sample / 255);
    }
    expect(spline.allocations).toBe(1);
    expect(spline.prepares).toBe(300);
    for (let index = 0; index < 4; index += 1)
      expect([buffers.xs, buffers.ys, buffers.slopes, buffers.tangents][index]).toBe(before[index]);
  });

  it('grows its buffers once for a longer curve, then keeps them', () => {
    const spline = new ColorCurveSpline(4);
    const long = Array.from({ length: 40 }, (_, index) => ({ x: index / 39, y: index / 39 }));
    spline.prepare(long);
    spline.prepare(long);
    expect(spline.allocations).toBe(2);
    expect(spline.valueAt(0.5)).toBe(oldSampleColorCurve(long, 0.5));
  });
});
