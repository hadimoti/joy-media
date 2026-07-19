import { describe, expect, it } from 'vitest';
import type { VisualObjectTransformV1, VisualObjectV1 } from '@joy-media/project-schema';
import { isAnimated, resolveAnimatedTransform, resolveObjectTransform } from './transform.js';

const staticTransform: VisualObjectTransformV1 = {
  x: 10,
  y: 20,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  opacity: 1,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

describe('resolveAnimatedTransform', () => {
  it('returns the static transform when nothing is animated', () => {
    expect(resolveAnimatedTransform(staticTransform, undefined, 500_000)).toBe(staticTransform);
    expect(resolveAnimatedTransform(staticTransform, {}, 500_000)).toBe(staticTransform);
  });

  it('samples only the animated channels', () => {
    const resolved = resolveAnimatedTransform(
      staticTransform,
      {
        x: {
          keyframes: [
            { timeUs: 0, value: 0, interpolation: 'linear' },
            { timeUs: 1_000_000, value: 100, interpolation: 'linear' },
          ],
        },
      },
      500_000,
    );
    expect(resolved.x).toBeCloseTo(50, 6);
    expect(resolved.y).toBe(20); // untouched static channel
  });

  it('clamps opacity and scale to their durable invariants', () => {
    const resolved = resolveAnimatedTransform(
      staticTransform,
      {
        opacity: { keyframes: [{ timeUs: 0, value: 5, interpolation: 'hold' }] },
        scaleX: { keyframes: [{ timeUs: 0, value: -3, interpolation: 'hold' }] },
      },
      0,
    );
    expect(resolved.opacity).toBe(1);
    expect(resolved.scaleX).toBe(0.001);
  });
});

describe('isAnimated / resolveObjectTransform', () => {
  const object: VisualObjectV1 = {
    id: 'obj-1',
    kind: 'text',
    transform: staticTransform,
    animations: {
      rotationDeg: {
        keyframes: [
          { timeUs: 0, value: 0, interpolation: 'linear' },
          { timeUs: 1_000_000, value: 90, interpolation: 'linear' },
        ],
      },
    },
  };

  it('detects an animated object', () => {
    expect(isAnimated(object)).toBe(true);
    expect(isAnimated({ ...object, animations: {} })).toBe(false);
    expect(isAnimated({ id: 'o', kind: 'shape', transform: staticTransform })).toBe(false);
  });

  it('resolves the object transform at a time', () => {
    expect(resolveObjectTransform(object, 500_000).rotationDeg).toBeCloseTo(45, 6);
  });
});
