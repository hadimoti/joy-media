import { describe, expect, it } from 'vitest';
import {
  applyVisualObjectCommand,
  setVisualProperty,
  VISUAL_INSPECTOR,
  sharedValue,
} from './index.js';
describe('visual property schemas', () => {
  it('covers transform, opacity, and crop without per-object forms', () => {
    expect(VISUAL_INSPECTOR.map((field) => field.key)).toEqual([
      'x',
      'y',
      'scaleX',
      'scaleY',
      'rotationDeg',
      'opacity',
      'crop',
    ]);
    expect(sharedValue([1, 1])).toBe(1);
    expect(sharedValue([1, 2])).toBeUndefined();
  });
  it('updates only selected visual objects with bounded values', () => {
    const object = {
      id: 'a',
      kind: 'shape',
      shape: 'rectangle',
      transform: {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotationDeg: 0,
        opacity: 1,
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
    } as const;
    expect(setVisualProperty([object], ['a'], 'opacity', 0.5)[0]!.transform.opacity).toBe(0.5);
    expect(() => setVisualProperty([object], ['a'], 'opacity', 2)).toThrow(/opacity/);
  });
  it('creates semantic inverses for durable object property changes', () => {
    const object = {
      id: 'a',
      kind: 'text',
      text: 'JOY',
      transform: {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotationDeg: 0,
        opacity: 1,
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
    } as const;
    const applied = applyVisualObjectCommand([object], {
      type: 'object.setTransformProperty',
      payload: { objectId: 'a', key: 'rotationDeg', value: 45 },
    });
    expect(applied.objects[0]!.transform.rotationDeg).toBe(45);
    expect(applyVisualObjectCommand(applied.objects, applied.inverse).objects).toEqual([object]);
  });
});
