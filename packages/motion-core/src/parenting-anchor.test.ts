import { describe, expect, it } from 'vitest';
import type { VisualObjectTransformV1, VisualObjectV1 } from '@joy-media/project-schema';
import { composeTransforms, resolveWorldTransform } from './parenting.js';

/** T-M05b: a child's anchor point survives parenting; no anchor stays no anchor. */

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

describe('composeTransforms and the anchor point (T-M05b)', () => {
  it("keeps the child's own anchor, never the parent's", () => {
    const world = composeTransforms(
      t({ x: 100, rotationDeg: 90, anchorX: 0.9, anchorY: 0.9 }),
      t({ x: 10, anchorX: 0, anchorY: 0.25 }),
    );
    expect(world.anchorX).toBe(0);
    expect(world.anchorY).toBe(0.25);
  });

  it('adds no anchor key when the child has none (old projects compose as before)', () => {
    const world = composeTransforms(t({ x: 100, anchorX: 0 }), t({ x: 10 }));
    expect('anchorX' in world).toBe(false);
    expect('anchorY' in world).toBe(false);
  });

  it('the world transform of a parented object carries its anchor', () => {
    const objects: Record<string, VisualObjectV1> = {
      parent: { id: 'parent', kind: 'null', transform: t({ x: 5, scaleX: 2 }) },
      child: {
        id: 'child',
        kind: 'shape',
        parentId: 'parent',
        transform: t({ x: 1, anchorX: 1, anchorY: 0 }),
      },
    } as Record<string, VisualObjectV1>;
    const world = resolveWorldTransform('child', objects, 0);
    expect(world.x).toBe(7);
    expect(world.anchorX).toBe(1);
    expect(world.anchorY).toBe(0);
  });
});
