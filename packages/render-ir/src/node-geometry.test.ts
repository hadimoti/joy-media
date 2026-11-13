import { describe, expect, it } from 'vitest';
import type { Transform2D } from './model.js';
import { flattenRenderNodes, validateRenderFrameIR } from './model.js';
import type { RenderFrameIR } from './model.js';
import {
  DEFAULT_NODE_ORIGIN,
  frameToLocalPoint,
  localToFramePoint,
  nodeBoundsContain,
  nodeBoundsFromBox,
  nodePivot,
  rotatePointAbout,
} from './node-geometry.js';
import { textPlateBounds } from './text-layout.js';

const plain: Transform2D = { translateX: 10, translateY: 20, scaleX: 2, scaleY: 3 };
const box = { x: 0, y: 0, width: 100, height: 50 };

function expectPoint(actual: { x: number; y: number }, x: number, y: number): void {
  expect(actual.x).toBeCloseTo(x, 9);
  expect(actual.y).toBeCloseTo(y, 9);
}

describe('rotatePointAbout', () => {
  it('turns a point 90 degrees clockwise on screen (y down) about the origin', () => {
    expectPoint(rotatePointAbout({ x: 10, y: 0 }, { x: 0, y: 0 }, 90), 0, 10);
    expectPoint(rotatePointAbout({ x: 0, y: 10 }, { x: 0, y: 0 }, 90), -10, 0);
  });

  it('rotates about any centre, and 0 degrees returns the same point', () => {
    expectPoint(rotatePointAbout({ x: 15, y: 5 }, { x: 5, y: 5 }, 180), -5, 5);
    expectPoint(rotatePointAbout({ x: 6, y: 5 }, { x: 5, y: 5 }, -90), 5, 4);
    const point = { x: 3.25, y: -7.5 };
    expect(rotatePointAbout(point, { x: 1, y: 1 }, 0)).toBe(point);
  });

  it('keeps the distance to the centre', () => {
    const centre = { x: 40, y: -12 };
    const turned = rotatePointAbout({ x: 70, y: 28 }, centre, 37);
    expect(Math.hypot(turned.x - centre.x, turned.y - centre.y)).toBeCloseTo(50, 9);
  });
});

describe('local and frame points', () => {
  it('with no rotation is exactly translate + scale * point, whatever the origin', () => {
    for (const origin of [undefined, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.25, y: 3 }]) {
      const transform = origin === undefined ? plain : { ...plain, origin };
      expect(localToFramePoint(transform, box, { x: 7, y: 9 })).toEqual({ x: 24, y: 47 });
      expect(frameToLocalPoint(transform, box, { x: 24, y: 47 })).toEqual({ x: 7, y: 9 });
    }
    expect(localToFramePoint({ ...plain, rotationDeg: 0 }, box, { x: 7, y: 9 })).toEqual({
      x: 24,
      y: 47,
    });
  });

  it('defaults the origin to the centre of the box', () => {
    expect(DEFAULT_NODE_ORIGIN).toEqual({ x: 0.5, y: 0.5 });
    expect(nodePivot(plain, box)).toEqual({ x: 50, y: 25 });
    expect(nodePivot(plain, { x: -40, y: 0, width: 80, height: 10 })).toEqual({ x: 0, y: 5 });
    expect(nodePivot({ ...plain, origin: { x: 0, y: 1 } }, box)).toEqual({ x: 0, y: 50 });
  });

  it('rotates about the origin: the origin stays where it was', () => {
    const rotated = { ...plain, rotationDeg: 33 };
    const pivotFrame = localToFramePoint(plain, box, nodePivot(plain, box));
    expectPoint(localToFramePoint(rotated, box, { x: 50, y: 25 }), pivotFrame.x, pivotFrame.y);
    const corner = { ...plain, rotationDeg: 90, origin: { x: 0, y: 0 } };
    // Top-left origin: the box's top-right corner swings below the origin.
    expectPoint(localToFramePoint(corner, box, { x: 100, y: 0 }), 10, 220);
  });

  it('frameToLocalPoint is the exact inverse when rotated', () => {
    const transform: Transform2D = {
      translateX: -12,
      translateY: 40,
      scaleX: 0.75,
      scaleY: 1.5,
      rotationDeg: -127,
      origin: { x: 0.2, y: 0.9 },
    };
    for (const point of [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      { x: 33.3, y: -8 },
    ]) {
      const back = frameToLocalPoint(transform, box, localToFramePoint(transform, box, point));
      expectPoint(back, point.x, point.y);
    }
  });
});

describe('nodeBoundsFromBox', () => {
  it('shape (100x100 sprite) without rotation: box, centre and aabb are the scaled rectangle', () => {
    const bounds = nodeBoundsFromBox(
      'shape-1',
      { translateX: 30, translateY: 40, scaleX: 2, scaleY: 0.5 },
      { x: 0, y: 0, width: 100, height: 100 },
    );
    expect(bounds.corners).toEqual([
      { x: 30, y: 40 },
      { x: 230, y: 40 },
      { x: 230, y: 90 },
      { x: 30, y: 90 },
    ]);
    expect(bounds.center).toEqual({ x: 130, y: 65 });
    expect(bounds.aabb).toEqual({ x: 30, y: 40, width: 200, height: 50 });
    expect(bounds.width).toBe(200);
    expect(bounds.height).toBe(50);
    expect(bounds.rotationDeg).toBe(0);
  });

  it('reports the cropped local box after scale and rotation', () => {
    const transform = {
      translateX: 10,
      translateY: 20,
      scaleX: 2,
      scaleY: 1.5,
      rotationDeg: 90,
      crop: { left: 0.25, top: 0.125, right: 0.1, bottom: 0.25 },
    } as Transform2D;
    const bounds = nodeBoundsFromBox('cropped', transform, { x: 0, y: 0, width: 100, height: 80 });

    expect(bounds.width).toBe(130);
    expect(bounds.height).toBe(75);
    expect(bounds.center).toEqual({ x: 125, y: 72.5 });
    expectPoint(bounds.corners[0], 162.5, 7.5);
    expectPoint(bounds.corners[1], 162.5, 137.5);
    expectPoint(bounds.corners[2], 87.5, 137.5);
    expectPoint(bounds.corners[3], 87.5, 7.5);
    expect(bounds.aabb.x).toBeCloseTo(87.5, 9);
    expect(bounds.aabb.y).toBeCloseTo(7.5, 9);
    expect(bounds.aabb.width).toBeCloseTo(75, 9);
    expect(bounds.aabb.height).toBeCloseTo(130, 9);
  });

  it('centred text: the box starts left of translate by half the text width', () => {
    const textBox = textPlateBounds(120, 30, 'center');
    const bounds = nodeBoundsFromBox(
      'title',
      { translateX: 540, translateY: 100, scaleX: 1, scaleY: 1 },
      textBox,
    );
    expect(bounds.aabb).toEqual({ x: 480, y: 100, width: 120, height: 30 });
    expect(bounds.center).toEqual({ x: 540, y: 115 });
  });

  it('a shape rotated 90 degrees about its centre swaps width and height in the aabb', () => {
    const bounds = nodeBoundsFromBox(
      'shape',
      { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotationDeg: 90 },
      { x: 0, y: 0, width: 200, height: 100 },
    );
    expectPoint(bounds.center, 100, 50);
    expectPoint(bounds.origin, 100, 50);
    expect(bounds.aabb.x).toBeCloseTo(50, 9);
    expect(bounds.aabb.y).toBeCloseTo(-50, 9);
    expect(bounds.aabb.width).toBeCloseTo(100, 9);
    expect(bounds.aabb.height).toBeCloseTo(200, 9);
    // The box keeps its own size; only the aabb grows.
    expect(bounds.width).toBe(200);
    expect(bounds.height).toBe(100);
    expectPoint(bounds.corners[0], 150, -50);
  });

  it('rotated text at 45 degrees: the aabb is the diagonal of the box', () => {
    const textBox = textPlateBounds(100, 100, 'left');
    const bounds = nodeBoundsFromBox(
      'text',
      { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotationDeg: 45 },
      textBox,
    );
    expect(bounds.aabb.width).toBeCloseTo(100 * Math.SQRT2, 9);
    expect(bounds.aabb.height).toBeCloseTo(100 * Math.SQRT2, 9);
    expectPoint(bounds.center, 50, 50);
  });

  it('containment follows the rotated box, not the aabb', () => {
    const transform: Transform2D = {
      translateX: 0,
      translateY: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 45,
    };
    const square = { x: 0, y: 0, width: 100, height: 100 };
    expect(nodeBoundsContain(transform, square, { x: 50, y: 50 })).toBe(true);
    // Inside the aabb corner but outside the turned square.
    expect(nodeBoundsContain(transform, square, { x: -15, y: -15 })).toBe(false);
    expect(nodeBoundsContain(transform, square, { x: 50, y: -15 })).toBe(true);
  });
});

describe('IR validation and flattening with rotation', () => {
  const base: RenderFrameIR = {
    version: 1,
    compositionId: 'root',
    timeUs: 0,
    viewport: { width: 4, height: 4, dpr: 1 },
    background: { r: 0, g: 0, b: 0, a: 255 },
    nodes: [],
  };
  const sprite = {
    kind: 'sprite' as const,
    id: 's',
    zIndex: 0,
    opacity: 1,
    width: 1,
    height: 1,
    color: { r: 1, g: 2, b: 3, a: 255 },
  };

  it('accepts rotation and origin, and refuses values that are not finite', () => {
    const ok = {
      ...sprite,
      transform: { ...plain, rotationDeg: 12.5, origin: { x: 0, y: 2 } },
    };
    expect(() => validateRenderFrameIR({ ...base, nodes: [ok] })).not.toThrow();
    expect(() =>
      validateRenderFrameIR({
        ...base,
        nodes: [{ ...sprite, transform: { ...plain, rotationDeg: Number.NaN } }],
      }),
    ).toThrow(/rotationDeg/);
    expect(() =>
      validateRenderFrameIR({
        ...base,
        nodes: [{ ...sprite, transform: { ...plain, origin: { x: Infinity, y: 0 } } }],
      }),
    ).toThrow(/origin/);
  });

  it('refuses a rotated group and keeps a child rotation through an unrotated group', () => {
    const child = { ...sprite, transform: { ...plain, rotationDeg: 30, origin: { x: 0, y: 0 } } };
    const group = {
      kind: 'group' as const,
      id: 'g',
      zIndex: 0,
      opacity: 1,
      transform: { translateX: 1, translateY: 1, scaleX: 1, scaleY: 1 },
      children: [child],
    };
    expect(() => validateRenderFrameIR({ ...base, nodes: [group] })).not.toThrow();
    expect(flattenRenderNodes([group])[0]!.transform).toEqual({
      translateX: 11,
      translateY: 21,
      scaleX: 2,
      scaleY: 3,
      rotationDeg: 30,
      origin: { x: 0, y: 0 },
    });
    expect(() =>
      validateRenderFrameIR({
        ...base,
        nodes: [{ ...group, transform: { ...group.transform, rotationDeg: 5 } }],
      }),
    ).toThrow(/cannot be rotated/);
  });

  it('a flattened node without rotation carries no rotation keys (old frames unchanged)', () => {
    const flat = flattenRenderNodes([{ ...sprite, transform: plain }]);
    expect(Object.keys(flat[0]!.transform).sort()).toEqual([
      'scaleX',
      'scaleY',
      'translateX',
      'translateY',
    ]);
  });
});
