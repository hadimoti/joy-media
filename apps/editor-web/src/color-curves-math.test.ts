import { describe, expect, it } from 'vitest';
import { sampleColorCurve } from '@joy-media/renderer-pixi';
import {
  addCurvePoint,
  CURVE_LEVEL,
  CURVE_MAX_POINTS,
  curvePath,
  curveReadout,
  curveValueAt,
  editableCurve,
  hitCurvePoint,
  IDENTITY_CURVE,
  isDraggedOut,
  isIdentityCurve,
  isOnCurveLine,
  moveCurvePoint,
  nextCurvePointIndex,
  nudgeCurvePoint,
  removeCurvePoint,
  type CurvePoints,
} from './color-curves-math.js';

const S_CURVE: CurvePoints = [
  { x: 0, y: 0 },
  { x: 0.25, y: 0.15 },
  { x: 0.75, y: 0.88 },
  { x: 1, y: 1 },
];

describe('curve points', () => {
  it('adds a point on the line, in input order', () => {
    const added = addCurvePoint(IDENTITY_CURVE, 0.5);
    expect(added).toBeDefined();
    expect(added!.index).toBe(1);
    expect(added!.points).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ]);
    const second = addCurvePoint(added!.points, 0.2, 0.4);
    expect(second!.index).toBe(1);
    expect(second!.points.map((point) => point.x)).toEqual([0, 0.2, 0.5, 1]);
  });

  it('puts the new point exactly on the drawn line', () => {
    const added = addCurvePoint(S_CURVE, 0.5)!;
    expect(added.points[added.index]!.y).toBeCloseTo(sampleColorCurve(S_CURVE, 0.5), 12);
  });

  it('refuses a point on top of another, on an edge, or past the limit', () => {
    expect(addCurvePoint(S_CURVE, 0.25)).toBeUndefined();
    expect(addCurvePoint(S_CURVE, 0.25 + CURVE_LEVEL / 2)).toBeUndefined();
    expect(addCurvePoint(S_CURVE, 0)).toBeUndefined();
    expect(addCurvePoint(S_CURVE, 1)).toBeUndefined();
    let curve: CurvePoints = IDENTITY_CURVE;
    for (let index = 1; index < CURVE_MAX_POINTS - 1; index += 1)
      curve = addCurvePoint(curve, index / CURVE_MAX_POINTS)!.points;
    expect(curve).toHaveLength(CURVE_MAX_POINTS);
    expect(addCurvePoint(curve, 0.99)).toBeUndefined();
  });

  it('moves a middle point and keeps it between its neighbours', () => {
    const moved = moveCurvePoint(S_CURVE, 1, 0.3, 0.1);
    expect(moved[1]).toEqual({ x: 0.3, y: 0.1 });
    // It cannot pass the next point, nor the one before.
    const pushed = moveCurvePoint(S_CURVE, 1, 0.9, 0.5);
    expect(pushed[1]!.x).toBeCloseTo(0.75 - CURVE_LEVEL, 12);
    expect(pushed[1]!.x).toBeLessThan(pushed[2]!.x);
    const pulled = moveCurvePoint(S_CURVE, 2, 0.1, 0.5);
    expect(pulled[2]!.x).toBeCloseTo(0.25 + CURVE_LEVEL, 12);
    // The output stays inside the square.
    expect(moveCurvePoint(S_CURVE, 1, 0.3, 4)[1]!.y).toBe(1);
    expect(moveCurvePoint(S_CURVE, 1, 0.3, -4)[1]!.y).toBe(0);
  });

  it('slides the end points along the left and right edges only', () => {
    const left = moveCurvePoint(S_CURVE, 0, 0.4, 0.2);
    expect(left[0]).toEqual({ x: 0, y: 0.2 });
    const right = moveCurvePoint(S_CURVE, 3, 0.4, 0.7);
    expect(right[3]).toEqual({ x: 1, y: 0.7 });
  });

  it('keeps the order after any sequence of moves', () => {
    let curve = S_CURVE;
    const moves = [
      [1, 0.9, 0.2],
      [2, 0, 0.9],
      [1, -1, 0.5],
      [2, 2, 0.4],
    ] as const;
    for (const [index, x, y] of moves) {
      curve = moveCurvePoint(curve, index, x, y);
      for (let i = 1; i < curve.length; i += 1)
        expect(curve[i]!.x - curve[i - 1]!.x).toBeGreaterThanOrEqual(CURVE_LEVEL - 1e-12);
    }
  });

  it('removes a middle point but never an end point', () => {
    expect(removeCurvePoint(S_CURVE, 1).map((point) => point.x)).toEqual([0, 0.75, 1]);
    expect(removeCurvePoint(S_CURVE, 0)).toEqual(S_CURVE);
    expect(removeCurvePoint(S_CURVE, 3)).toEqual(S_CURVE);
  });

  it('removes a middle point dragged out of the graph, never an end point', () => {
    expect(isDraggedOut(S_CURVE, 1, 0.5, 1.5)).toBe(true);
    expect(isDraggedOut(S_CURVE, 1, -0.5, 0.5)).toBe(true);
    expect(isDraggedOut(S_CURVE, 1, 0.5, 1.05)).toBe(false);
    expect(isDraggedOut(S_CURVE, 0, 0.5, 1.5)).toBe(false);
  });

  it('cleans a stored curve: sorted, inside the square, ends on the edges', () => {
    expect(editableCurve(undefined)).toEqual(IDENTITY_CURVE);
    expect(editableCurve([{ x: 0.5, y: 0.5 }])).toEqual(IDENTITY_CURVE);
    expect(
      editableCurve([
        { x: 1, y: 1 },
        { x: 0.5, y: 2 },
        { x: 0, y: 0 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 1 },
      { x: 1, y: 1 },
    ]);
    expect(
      editableCurve([
        { x: 0.1, y: 0.2 },
        { x: 0.9, y: 0.8 },
      ]),
    ).toEqual([
      { x: 0, y: 0.2 },
      { x: 0.1, y: 0.2 },
      { x: 0.9, y: 0.8 },
      { x: 1, y: 0.8 },
    ]);
  });
});

describe('the drawn line', () => {
  it('is the colour engine spline', () => {
    for (let level = 0; level <= 255; level += 15)
      expect(curveValueAt(S_CURVE, level / 255)).toBe(sampleColorCurve(S_CURVE, level / 255));
  });

  it('never goes backwards: between two points it stays between their outputs', () => {
    const curves: CurvePoints[] = [
      S_CURVE,
      [
        { x: 0, y: 0 },
        { x: 0.1, y: 0.6 },
        { x: 0.2, y: 0.62 },
        { x: 0.8, y: 0.65 },
        { x: 1, y: 1 },
      ],
      [
        { x: 0, y: 1 },
        { x: 0.5, y: 0.2 },
        { x: 0.55, y: 0.8 },
        { x: 1, y: 0 },
      ],
    ];
    for (const curve of curves) {
      for (let index = 0; index < curve.length - 1; index += 1) {
        const left = curve[index]!;
        const right = curve[index + 1]!;
        const low = Math.min(left.y, right.y);
        const high = Math.max(left.y, right.y);
        let previous = curveValueAt(curve, left.x);
        for (let step = 1; step <= 64; step += 1) {
          const x = left.x + ((right.x - left.x) * step) / 64;
          const y = curveValueAt(curve, x);
          expect(y).toBeGreaterThanOrEqual(low - 1e-9);
          expect(y).toBeLessThanOrEqual(high + 1e-9);
          // Monotone inside the segment, in the direction of the segment.
          if (right.y >= left.y) expect(y).toBeGreaterThanOrEqual(previous - 1e-9);
          else expect(y).toBeLessThanOrEqual(previous + 1e-9);
          previous = y;
        }
      }
    }
  });

  it('draws one path segment per level in the graph box (y up)', () => {
    const path = curvePath(IDENTITY_CURVE, 256);
    expect(path.startsWith('M0.00 256.00')).toBe(true);
    expect(path.endsWith('L256.00 0.00')).toBe(true);
    expect(path.split(' L')).toHaveLength(256);
  });

  it('finds a point and the line under the pointer', () => {
    expect(hitCurvePoint(S_CURVE, 0.26, 0.16, 0.03)).toBe(1);
    expect(hitCurvePoint(S_CURVE, 0.5, 0.9, 0.03)).toBeUndefined();
    expect(isOnCurveLine(IDENTITY_CURVE, 0.5, 0.51, 0.03)).toBe(true);
    expect(isOnCurveLine(IDENTITY_CURVE, 0.5, 0.7, 0.03)).toBe(false);
  });

  it('knows the straight line', () => {
    expect(isIdentityCurve(IDENTITY_CURVE)).toBe(true);
    expect(isIdentityCurve(addCurvePoint(IDENTITY_CURVE, 0.5)!.points)).toBe(true);
    expect(isIdentityCurve(S_CURVE)).toBe(false);
  });

  it('reads input and output as 8-bit levels', () => {
    expect(curveReadout({ x: 128 / 255, y: 150 / 255 })).toBe('In 128, Out 150');
    expect(curveReadout({ x: 0, y: 1 })).toBe('In 0, Out 255');
  });
});

describe('keyboard', () => {
  it('nudges one level, ten with Shift', () => {
    const up = nudgeCurvePoint(S_CURVE, 1, 'ArrowUp');
    expect(up[1]!.y).toBeCloseTo(0.15 + CURVE_LEVEL, 12);
    const down = nudgeCurvePoint(S_CURVE, 1, 'ArrowDown', true);
    expect(down[1]!.y).toBeCloseTo(0.15 - 10 * CURVE_LEVEL, 12);
    const right = nudgeCurvePoint(S_CURVE, 1, 'ArrowRight', true);
    expect(right[1]!.x).toBeCloseTo(0.25 + 10 * CURVE_LEVEL, 12);
    const left = nudgeCurvePoint(S_CURVE, 1, 'ArrowLeft');
    expect(left[1]!.x).toBeCloseTo(0.25 - CURVE_LEVEL, 12);
  });

  it('keeps the same limits as a drag', () => {
    expect(nudgeCurvePoint(S_CURVE, 0, 'ArrowRight')[0]!.x).toBe(0);
    expect(nudgeCurvePoint(S_CURVE, 3, 'ArrowUp')[3]!.y).toBe(1);
    expect(nudgeCurvePoint(S_CURVE, 0, 'ArrowDown')[0]!.y).toBe(0);
  });

  it('moves between points with Tab and Shift+Tab, and stops past the ends', () => {
    expect(nextCurvePointIndex(S_CURVE, 0)).toBe(1);
    expect(nextCurvePointIndex(S_CURVE, 2, true)).toBe(1);
    expect(nextCurvePointIndex(S_CURVE, 3)).toBeUndefined();
    expect(nextCurvePointIndex(S_CURVE, 0, true)).toBeUndefined();
  });
});
