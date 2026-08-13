import { describe, expect, it } from 'vitest';
import type { AnimationCurveV1 } from '@joy-media/project-schema';
import { graphHandleDragCurve, graphKeyDragCurve } from './GraphEditor.js';

const CURVE: AnimationCurveV1 = {
  keyframes: [
    { timeUs: 0, value: 0, interpolation: 'linear' },
    { timeUs: 100_000, value: 10, interpolation: 'linear' },
    { timeUs: 200_000, value: 20, interpolation: 'linear' },
  ],
};

describe('GraphEditor drag curve helpers', () => {
  it('moves a key from its gesture-start snapshot and normalizes duplicate times', () => {
    const moved = graphKeyDragCurve(CURVE, 1, {
      timeUs: 200_000,
      value: 42,
      interpolation: 'linear',
    });

    expect(moved.keyframes).toEqual([
      { timeUs: 0, value: 0, interpolation: 'linear' },
      { timeUs: 200_000, value: 42, interpolation: 'linear' },
    ]);
    expect(CURVE.keyframes[1]).toEqual({ timeUs: 100_000, value: 10, interpolation: 'linear' });
  });

  it('changes only the dragged bezier handle and preserves the other handle', () => {
    const curve: AnimationCurveV1 = {
      keyframes: [
        {
          timeUs: 0,
          value: 0,
          interpolation: 'bezier',
          bezier: { x1: 0.2, y1: 0.3, x2: 0.8, y2: 0.7 },
        },
      ],
    };

    const next = graphHandleDragCurve(curve, 0, 'out', 0.9, 0.1);
    expect(next?.keyframes[0]?.bezier).toEqual({ x1: 0.2, y1: 0.3, x2: 0.9, y2: 0.1 });
    expect(graphHandleDragCurve(curve, 1, 'out', 0.5, 0.5)).toBeUndefined();
  });
});
