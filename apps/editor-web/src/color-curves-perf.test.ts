import { describe, expect, it } from 'vitest';
import { ColorCurveSpline, sampleColorCurve } from '@joy-media/renderer-pixi';
import {
  curvePath,
  curveLineSpline,
  curveValueAt,
  editableCurve,
  moveCurvePoint,
  sameCurve,
  type CurvePoints,
} from './color-curves-math.js';

/*
 * T-K03 review fix: the graph line is sampled from a spline prepared once
 * per curve, without allocating per sample, and draws exactly what it drew
 * before.
 */

/** The old `curvePath`: every sample went through `sampleColorCurve` on its own. */
function oldCurvePath(points: CurvePoints, size: number, samples = 256): string {
  const curve = editableCurve(points);
  const parts: string[] = [];
  for (let index = 0; index < samples; index += 1) {
    const x = index / (samples - 1);
    const y = curveValueAt(curve, x);
    parts.push(`${index === 0 ? 'M' : 'L'}${(x * size).toFixed(2)} ${((1 - y) * size).toFixed(2)}`);
  }
  return parts.join(' ');
}

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

function randomCurve(next: () => number): CurvePoints {
  const count = 2 + Math.floor(next() * 15);
  return Array.from({ length: count }, () => ({ x: next() * 1.2 - 0.1, y: next() * 1.2 - 0.1 }));
}

describe('curve line (review fix)', () => {
  it('draws exactly the old path on random curves', () => {
    const next = random(1113);
    for (let curve = 0; curve < 400; curve += 1) {
      const points = randomCurve(next);
      expect(curvePath(points, 256)).toBe(oldCurvePath(points, 256));
      expect(curvePath(points, 100, 33)).toBe(oldCurvePath(points, 100, 33));
    }
  });

  it('samples every level exactly as the colour engine does', () => {
    const next = random(5);
    const spline = new ColorCurveSpline();
    for (let curve = 0; curve < 200; curve += 1) {
      const points = editableCurve(randomCurve(next));
      spline.prepare(points);
      for (let level = 0; level < 256; level += 1)
        expect(spline.valueAt(level / 255)).toBe(sampleColorCurve(points, level / 255));
    }
  });

  it('prepares the spline once per line and allocates no new buffers while dragging', () => {
    const buffers = curveLineSpline as unknown as Record<'xs' | 'ys' | 'tangents', Float64Array>;
    const before = [buffers.xs, buffers.ys, buffers.tangents];
    const allocations = curveLineSpline.allocations;
    const prepares = curveLineSpline.prepares;
    let points: CurvePoints = [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.3 },
      { x: 0.5, y: 0.5 },
      { x: 0.75, y: 0.7 },
      { x: 1, y: 1 },
    ];
    // 120 pointer moves of a drag, each one redrawing the 256-sample line.
    for (let move = 0; move < 120; move += 1) {
      points = moveCurvePoint(points, 2, 0.5, (move % 50) / 50);
      curvePath(points, 256);
    }
    expect(curveLineSpline.prepares - prepares).toBe(120);
    expect(curveLineSpline.allocations).toBe(allocations);
    expect(buffers.xs).toBe(before[0]);
    expect(buffers.ys).toBe(before[1]);
    expect(buffers.tangents).toBe(before[2]);
  });

  it('tells a move that changed nothing', () => {
    const points: CurvePoints = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.6 },
      { x: 1, y: 1 },
    ];
    expect(sameCurve(points, moveCurvePoint(points, 1, 0.5, 0.6))).toBe(true);
    expect(sameCurve(points, moveCurvePoint(points, 1, 0.5, 0.61))).toBe(false);
    expect(sameCurve(points, points.slice(0, 2))).toBe(false);
  });
});
