import { describe, expect, it } from 'vitest';
import type { VisualObjectTransformV1, VisualObjectV1 } from '@joy-media/project-schema';
import { composeTransforms, parentChain, resolveWorldTransform } from './parenting.js';

const t = (over: Partial<VisualObjectTransformV1> = {}): VisualObjectTransformV1 => ({
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  opacity: 1,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
  ...over,
});

const obj = (
  id: string,
  transform: VisualObjectTransformV1,
  parentId?: string,
): VisualObjectV1 => ({
  id,
  kind: 'null',
  transform,
  ...(parentId === undefined ? {} : { parentId }),
});

describe('composeTransforms', () => {
  it('adds parent translation to the child position', () => {
    const world = composeTransforms(t({ x: 100, y: 50 }), t({ x: 10, y: 20 }));
    expect(world).toMatchObject({ x: 110, y: 70 });
  });

  it('multiplies scale and scales the child offset by the parent scale', () => {
    const world = composeTransforms(t({ scaleX: 2, scaleY: 3 }), t({ x: 10, y: 10, scaleX: 1.5 }));
    expect(world.x).toBeCloseTo(20, 6);
    expect(world.y).toBeCloseTo(30, 6);
    expect(world.scaleX).toBeCloseTo(3, 6);
    expect(world.scaleY).toBeCloseTo(3, 6);
  });

  it('rotates the child offset by the parent rotation and sums the angles', () => {
    const world = composeTransforms(t({ rotationDeg: 90 }), t({ x: 10, y: 0, rotationDeg: 5 }));
    expect(world.x).toBeCloseTo(0, 6);
    expect(world.y).toBeCloseTo(10, 6);
    expect(world.rotationDeg).toBe(95);
  });

  it('multiplies opacity down the chain and keeps the child crop', () => {
    const world = composeTransforms(
      t({ opacity: 0.5 }),
      t({ opacity: 0.5, crop: { left: 3, top: 0, right: 0, bottom: 0 } }),
    );
    expect(world.opacity).toBe(0.25);
    expect(world.crop.left).toBe(3);
  });
});

describe('resolveWorldTransform', () => {
  const identity = (object: VisualObjectV1): VisualObjectTransformV1 => object.transform;

  it('returns the local transform for a root object', () => {
    const objects = { root: obj('root', t({ x: 5 })) };
    expect(resolveWorldTransform('root', objects, 0, identity).x).toBe(5);
  });

  it('inherits a null controller parent through the chain', () => {
    const objects = {
      controller: obj('controller', t({ x: 100 })),
      child: obj('child', t({ x: 10 }), 'controller'),
    };
    expect(resolveWorldTransform('child', objects, 0, identity).x).toBe(110);
  });

  it('composes a two-level grandparent chain', () => {
    const objects = {
      grandparent: obj('grandparent', t({ x: 1000 })),
      parent: obj('parent', t({ x: 100 }), 'grandparent'),
      child: obj('child', t({ x: 10 }), 'parent'),
    };
    expect(resolveWorldTransform('child', objects, 0, identity).x).toBe(1110);
  });

  it('breaks a cycle instead of looping forever', () => {
    const objects = {
      a: obj('a', t({ x: 1 }), 'b'),
      b: obj('b', t({ x: 2 }), 'a'),
    };
    // Chain from 'a' stops when it revisits, so evaluation terminates.
    expect(parentChain('a', objects).length).toBeLessThanOrEqual(2);
    expect(() => resolveWorldTransform('a', objects, 0, identity)).not.toThrow();
  });
});
