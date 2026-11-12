import { describe, expect, it } from 'vitest';
import {
  nodeBoundsFromBox,
  rotatePointAbout,
  validateRenderFrameIR,
  type NodePoint,
  type NodeRect,
  type RenderFrameIR,
  type Transform2D,
} from '@joy-media/render-ir';
import { composeTransforms } from '@joy-media/motion-core';
import {
  migrateV0ToV1,
  validateJoyProjectV1,
  type JoyProjectV1,
  type VisualObjectV1,
} from '@joy-media/project-schema';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import {
  MIN_SCALE,
  MONITOR_SCALE_HANDLES,
  applyWorldChange,
  boxGeometry,
  cleanNumber,
  drawnTransformOf,
  elementLocalPoint,
  handleAxes,
  handlePoint,
  isCornerHandle,
  moveTransform,
  nudgeDelta,
  oppositeHandle,
  parentSpaceInvertible,
  rotateHandlePoint,
  rotateTransform,
  scaleTransform,
  snapAngle,
  worldDeltaToParentSpace,
  type DrawnTransform,
  type MonitorScaleHandle,
} from './monitor-transform-maths.js';

const BOX: NodeRect = { x: 0, y: 0, width: 200, height: 100 };

function render(drawn: DrawnTransform, origin?: NodePoint): Transform2D {
  return {
    translateX: drawn.x,
    translateY: drawn.y,
    scaleX: drawn.scaleX,
    scaleY: drawn.scaleY,
    ...(drawn.rotationDeg === 0 ? {} : { rotationDeg: drawn.rotationDeg }),
    ...(origin === undefined ? {} : { origin }),
  };
}

/** The box exactly as the renderer reports it for these values. */
function geometryOf(drawn: DrawnTransform, box: NodeRect = BOX, origin?: NodePoint) {
  const transform = render(drawn, origin);
  return boxGeometry(nodeBoundsFromBox('node', transform, box), transform);
}

function expectPoint(actual: NodePoint, expected: NodePoint, digits = 6): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
}

function axisDirection(handle: MonitorScaleHandle, rotationDeg: number): NodePoint {
  const axes = handleAxes(handle);
  const local = axes.x ? { x: 1, y: 0 } : { x: 0, y: 1 };
  return rotatePointAbout(local, { x: 0, y: 0 }, rotationDeg);
}

const BASE: DrawnTransform = { x: 100, y: 200, scaleX: 1, scaleY: 1, rotationDeg: 0 };
const CASES: readonly (readonly [string, DrawnTransform])[] = [
  ['plain', BASE],
  ['scaled', { ...BASE, scaleX: 2, scaleY: 0.5 }],
  ['rotated 30', { ...BASE, rotationDeg: 30 }],
  ['rotated -135 and scaled', { ...BASE, scaleX: 1.5, scaleY: 0.75, rotationDeg: -135 }],
  ['upside down (rotated 180)', { ...BASE, rotationDeg: 180 }],
  ['scaled and rotated 60', { ...BASE, scaleX: 0.8, scaleY: 1.2, rotationDeg: 60 }],
];
const DELTA: NodePoint = { x: 37, y: -23 };

describe('the handles', () => {
  it('sit on the corners and the edge midpoints, and each has an opposite', () => {
    const geometry = geometryOf(BASE);
    expectPoint(handlePoint(geometry, 'nw'), { x: 100, y: 200 });
    expectPoint(handlePoint(geometry, 'n'), { x: 200, y: 200 });
    expectPoint(handlePoint(geometry, 'se'), { x: 300, y: 300 });
    expectPoint(handlePoint(geometry, 'w'), { x: 100, y: 250 });
    for (const handle of MONITOR_SCALE_HANDLES)
      expect(oppositeHandle(oppositeHandle(handle))).toBe(handle);
    expect(MONITOR_SCALE_HANDLES.filter(isCornerHandle)).toEqual(['nw', 'ne', 'se', 'sw']);
  });

  it('the rotate handle sits beyond the top edge, also when turned', () => {
    expectPoint(rotateHandlePoint(geometryOf(BASE), 24), { x: 200, y: 176 });
    const turned = geometryOf({ ...BASE, rotationDeg: 90 });
    // Turned a quarter clockwise: the top edge now faces right.
    const point = rotateHandlePoint(turned, 24);
    expect(point.x).toBeGreaterThan(handlePoint(turned, 'n').x);
    // Turned upside down: the element's own top edge is drawn at the bottom.
    const upsideDown = geometryOf({ ...BASE, rotationDeg: 180 });
    expect(rotateHandlePoint(upsideDown, 24).y).toBeGreaterThan(handlePoint(upsideDown, 'n').y);
    const empty = geometryOf(BASE, { x: 0, y: 0, width: 0, height: 0 });
    expect(Number.isFinite(rotateHandlePoint(empty, 24).x)).toBe(true);
  });
});

describe('move', () => {
  it('moves by the pointer movement and nothing else', () => {
    expect(moveTransform(BASE, { x: 5, y: -7 })).toEqual({ ...BASE, x: 105, y: 193 });
    expect(moveTransform(BASE, { x: Number.NaN, y: 1 })).toBe(BASE);
  });

  it('arrow keys nudge 1 pixel, Shift 10', () => {
    expect(nudgeDelta('ArrowLeft', false)).toEqual({ x: -1, y: 0 });
    expect(nudgeDelta('ArrowRight', true)).toEqual({ x: 10, y: 0 });
    expect(nudgeDelta('ArrowUp', false)).toEqual({ x: 0, y: -1 });
    expect(nudgeDelta('ArrowDown', true)).toEqual({ x: 0, y: 10 });
    expect(nudgeDelta('a', false)).toBeUndefined();
  });
});

describe('scale: every handle, with rotation and scale', () => {
  for (const [label, drawn] of CASES) {
    for (const handle of MONITOR_SCALE_HANDLES) {
      it(`${label}, ${handle}: the opposite handle stays, the handle follows its axes`, () => {
        const geometry = geometryOf(drawn);
        const start = handlePoint(geometry, handle);
        const now = { x: start.x + DELTA.x, y: start.y + DELTA.y };
        const next = scaleTransform(geometry, handle, start, now, { shift: false, alt: false });
        expect(next.rotationDeg).toBe(drawn.rotationDeg);
        const after = geometryOf(next);
        expectPoint(
          handlePoint(after, oppositeHandle(handle)),
          handlePoint(geometry, oppositeHandle(handle)),
        );
        if (isCornerHandle(handle)) {
          expectPoint(handlePoint(after, handle), now);
        } else {
          const direction = axisDirection(handle, drawn.rotationDeg);
          const along = DELTA.x * direction.x + DELTA.y * direction.y;
          expectPoint(handlePoint(after, handle), {
            x: start.x + along * direction.x,
            y: start.y + along * direction.y,
          });
          // An edge handle changes one scale only.
          if (handleAxes(handle).x) expect(next.scaleY).toBeCloseTo(drawn.scaleY, 9);
          else expect(next.scaleX).toBeCloseTo(drawn.scaleX, 9);
        }
      });

      it(`${label}, ${handle} with Alt: the centre stays`, () => {
        const geometry = geometryOf(drawn);
        const start = handlePoint(geometry, handle);
        const now = { x: start.x + DELTA.x, y: start.y + DELTA.y };
        const next = scaleTransform(geometry, handle, start, now, { shift: false, alt: true });
        expectPoint(geometryOf(next).center, geometry.center);
      });

      it(`${label}, ${handle} with Shift: the proportions stay`, () => {
        const geometry = geometryOf(drawn);
        const start = handlePoint(geometry, handle);
        const now = { x: start.x + DELTA.x, y: start.y + DELTA.y };
        const next = scaleTransform(geometry, handle, start, now, { shift: true, alt: false });
        expect(next.scaleX / next.scaleY).toBeCloseTo(drawn.scaleX / drawn.scaleY, 9);
        expectPoint(
          handlePoint(geometryOf(next), oppositeHandle(handle)),
          handlePoint(geometry, oppositeHandle(handle)),
        );
      });
    }
  }

  it('Shift+Alt keeps the proportions and the centre', () => {
    const geometry = geometryOf({ ...BASE, rotationDeg: 20, scaleX: 2 });
    const start = handlePoint(geometry, 'se');
    const next = scaleTransform(
      geometry,
      'se',
      start,
      { x: start.x + 40, y: start.y + 5 },
      { shift: true, alt: true },
    );
    expect(next.scaleX / next.scaleY).toBeCloseTo(2, 9);
    expectPoint(geometryOf(next).center, geometry.center);
  });

  it('no flip in v1.1.1: dragging across the opposite side stops the box at the minimum scale', () => {
    const geometry = geometryOf(BASE);
    const next = scaleTransform(
      geometry,
      'e',
      handlePoint(geometry, 'e'),
      { x: 0, y: 250 },
      { shift: false, alt: false },
    );
    expect(next.scaleX).toBeCloseTo(MIN_SCALE, 9);
    expect(next.scaleY).toBe(1);
    const after = geometryOf(next);
    expectPoint(handlePoint(after, 'w'), { x: 100, y: 250 });
    // The box stops, two pixels wide, on the fixed side: it does not turn inside out.
    expectPoint(handlePoint(after, 'e'), { x: 100 + 200 * MIN_SCALE, y: 250 });
  });

  it('every handle dragged far past the fixed point stops at the minimum, and the fixed point stays', () => {
    for (const [label, drawn] of CASES) {
      const geometry = geometryOf(drawn);
      for (const handle of MONITOR_SCALE_HANDLES) {
        for (const modifiers of [
          { shift: false, alt: false },
          { shift: true, alt: false },
          { shift: false, alt: true },
          { shift: true, alt: true },
        ]) {
          const start = handlePoint(geometry, handle);
          const fixed = modifiers.alt
            ? geometry.center
            : handlePoint(geometry, oppositeHandle(handle));
          // Three box-lengths across: well past the fixed point.
          const now = {
            x: start.x + 3 * (fixed.x - start.x),
            y: start.y + 3 * (fixed.y - start.y),
          };
          const next = scaleTransform(geometry, handle, start, now, modifiers);
          expect(next.scaleX, `${label} ${handle}`).toBeGreaterThanOrEqual(MIN_SCALE - 1e-12);
          expect(next.scaleY, `${label} ${handle}`).toBeGreaterThanOrEqual(MIN_SCALE - 1e-12);
          const smallest = Math.min(
            handleAxes(handle).x || modifiers.shift ? next.scaleX : Infinity,
            handleAxes(handle).y || modifiers.shift ? next.scaleY : Infinity,
          );
          expect(smallest).toBeCloseTo(MIN_SCALE, 9);
          if (modifiers.shift)
            expect(next.scaleX / next.scaleY).toBeCloseTo(drawn.scaleX / drawn.scaleY, 9);
          const after = geometryOf(next);
          expectPoint(
            modifiers.alt ? after.center : handlePoint(after, oppositeHandle(handle)),
            fixed,
          );
        }
      }
    }
  });

  it('a scale already below the minimum cannot shrink further, nor jumps up', () => {
    const tiny = { ...BASE, scaleX: 0.005 };
    const geometry = geometryOf(tiny);
    const start = handlePoint(geometry, 'e');
    const inwards = scaleTransform(
      geometry,
      'e',
      start,
      { x: 0, y: start.y },
      {
        shift: false,
        alt: false,
      },
    );
    expect(inwards.scaleX).toBeCloseTo(0.005, 12);
    const outwards = scaleTransform(
      geometry,
      'e',
      start,
      { x: start.x + 9, y: start.y },
      {
        shift: false,
        alt: false,
      },
    );
    expect(outwards.scaleX).toBeCloseTo(0.005 * 10, 9);
  });

  it('the result passes the project validator and the render-frame validator', () => {
    const crop = { left: 0, top: 0, right: 0, bottom: 0 };
    const holderLocal = { x: 50, y: 60, scaleX: 2, scaleY: 0.5, rotationDeg: 90 };
    const childLocal = { x: 30, y: -10, scaleX: 1.5, scaleY: 2, rotationDeg: 10 };
    const parentWorld = composeTransforms(
      { ...holderLocal, opacity: 1, crop },
      { x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0, opacity: 1, crop },
    );
    const parent = {
      x: parentWorld.x,
      y: parentWorld.y,
      scaleX: parentWorld.scaleX,
      scaleY: parentWorld.scaleY,
      rotationDeg: parentWorld.rotationDeg,
    };
    const world = composeTransforms(
      { ...holderLocal, opacity: 1, crop },
      { ...childLocal, opacity: 1, crop },
    );
    const drawn: DrawnTransform = {
      x: world.x,
      y: world.y,
      scaleX: world.scaleX,
      scaleY: world.scaleY,
      rotationDeg: world.rotationDeg,
    };
    const base = migrateV0ToV1(emptySpikeProject()).project;
    const projectWith = (local: DrawnTransform): JoyProjectV1 => ({
      ...base,
      visualObjects: {
        holder: { id: 'holder', kind: 'null', transform: { ...holderLocal, opacity: 1, crop } },
        child: {
          id: 'child',
          kind: 'shape',
          parentId: 'holder',
          transform: { ...local, opacity: 1, crop },
        },
      } as unknown as Record<string, VisualObjectV1>,
    });
    const frameWith = (value: DrawnTransform): RenderFrameIR => ({
      version: 1,
      compositionId: 'root',
      timeUs: 0,
      viewport: { width: 1080, height: 1920, dpr: 1 },
      background: { r: 0, g: 0, b: 0, a: 1 },
      nodes: [
        {
          id: 'child',
          kind: 'sprite',
          zIndex: 0,
          opacity: 1,
          transform: render(value),
          width: BOX.width,
          height: BOX.height,
          color: { r: 1, g: 1, b: 1, a: 1 },
        },
      ],
    });
    expect(validateJoyProjectV1(projectWith(childLocal))).toEqual([]);
    // The validators have teeth: a flipped (negative) scale is refused by both.
    expect(validateJoyProjectV1(projectWith({ ...childLocal, scaleX: -1.5 }))).not.toEqual([]);
    expect(() => validateRenderFrameIR(frameWith({ ...drawn, scaleX: -drawn.scaleX }))).toThrow();

    const geometry = geometryOf(drawn);
    for (const handle of MONITOR_SCALE_HANDLES) {
      for (const modifiers of [
        { shift: false, alt: false },
        { shift: true, alt: true },
      ]) {
        const start = handlePoint(geometry, handle);
        const fixed = modifiers.alt
          ? geometry.center
          : handlePoint(geometry, oppositeHandle(handle));
        const now = { x: start.x + 3 * (fixed.x - start.x), y: start.y + 3 * (fixed.y - start.y) };
        const next = scaleTransform(geometry, handle, start, now, modifiers);
        expect(() => validateRenderFrameIR(frameWith(next))).not.toThrow();
        const local = applyWorldChange(childLocal, drawn, next, parent)!;
        expect(local).toBeDefined();
        expect(validateJoyProjectV1(projectWith(local)), handle).toEqual([]);
      }
    }
  });

  it('a custom origin and an offset box (text) still keep the fixed point', () => {
    const origin = { x: 0.2, y: 0.9 };
    const box = { x: -60, y: 10, width: 120, height: 40 };
    const drawn = { ...BASE, scaleX: 1.3, rotationDeg: 50 };
    const geometry = geometryOf(drawn, box, origin);
    const start = handlePoint(geometry, 'ne');
    const now = { x: start.x + 12, y: start.y + 30 };
    const next = scaleTransform(geometry, 'ne', start, now, { shift: false, alt: false });
    const after = geometryOf(next, box, origin);
    expectPoint(handlePoint(after, 'sw'), handlePoint(geometry, 'sw'));
    expectPoint(handlePoint(after, 'ne'), now);
  });

  it('zero size: an axis with no size cannot be dragged and nothing becomes NaN', () => {
    for (const [drawn, box] of [
      [{ ...BASE, scaleX: 0 }, BOX],
      [{ ...BASE, scaleX: 0, scaleY: 0 }, BOX],
      [BASE, { x: 0, y: 0, width: 0, height: 100 }],
      [BASE, { x: 0, y: 0, width: 0, height: 0 }],
    ] as const) {
      const geometry = geometryOf(drawn, box);
      for (const handle of MONITOR_SCALE_HANDLES) {
        for (const modifiers of [
          { shift: false, alt: false },
          { shift: true, alt: false },
          { shift: false, alt: true },
        ]) {
          const start = handlePoint(geometry, handle);
          const next = scaleTransform(
            geometry,
            handle,
            start,
            { x: start.x + 30, y: start.y + 30 },
            modifiers,
          );
          for (const value of Object.values(next)) expect(Number.isFinite(value)).toBe(true);
          // A zero scale stays zero; an empty box keeps its scale unless Shift
          // keeps the proportions with the other axis.
          if (drawn.scaleX === 0) expect(next.scaleX).toBe(0);
          if (box.width === 0 && !modifiers.shift) expect(next.scaleX).toBe(drawn.scaleX);
        }
      }
    }
  });

  it('a pointer that does not move changes nothing', () => {
    const geometry = geometryOf(CASES[3]![1]);
    for (const handle of MONITOR_SCALE_HANDLES) {
      const start = handlePoint(geometry, handle);
      const next = scaleTransform(geometry, handle, start, start, { shift: true, alt: true });
      expect(next.scaleX).toBeCloseTo(geometry.transform.scaleX, 9);
      expect(next.scaleY).toBeCloseTo(geometry.transform.scaleY, 9);
      expect(next.x).toBeCloseTo(geometry.transform.x, 9);
      expect(next.y).toBeCloseTo(geometry.transform.y, 9);
    }
  });
});

describe('rotate', () => {
  it('turns by the angle the pointer swept, about the origin, which stays put', () => {
    for (const [, drawn] of CASES) {
      const geometry = geometryOf(drawn);
      const { origin } = geometry;
      const start = { x: origin.x, y: origin.y - 100 };
      const now = { x: origin.x + 100, y: origin.y };
      const next = rotateTransform(geometry, start, now, { shift: false });
      expect(next.rotationDeg).toBeCloseTo(drawn.rotationDeg + 90, 9);
      expect(next.x).toBe(drawn.x);
      expect(next.y).toBe(drawn.y);
      expectPoint(geometryOf(next).origin, origin);
    }
  });

  it('Shift snaps the rotation to 15 degree steps', () => {
    const geometry = geometryOf({ ...BASE, rotationDeg: 3 });
    const { origin } = geometry;
    const start = { x: origin.x + 100, y: origin.y };
    const turned37 = rotatePointAbout(start, origin, 37);
    expect(rotateTransform(geometry, start, turned37, { shift: true }).rotationDeg).toBe(45);
    expect(rotateTransform(geometry, start, turned37, { shift: false }).rotationDeg).toBeCloseTo(
      40,
      9,
    );
    expect(snapAngle(7)).toBe(0);
    expect(snapAngle(-8)).toBe(-15);
    expect(snapAngle(52.4)).toBe(45);
  });

  it('a pointer on the origin, or a zero-size box, changes nothing', () => {
    const geometry = geometryOf(BASE);
    expect(rotateTransform(geometry, geometry.origin, { x: 0, y: 0 }, { shift: true })).toBe(
      geometry.transform,
    );
    const empty = geometryOf({ ...BASE, scaleX: 0, scaleY: 0 });
    const next = rotateTransform(
      empty,
      { x: empty.origin.x + 10, y: empty.origin.y },
      { x: empty.origin.x, y: empty.origin.y + 10 },
      { shift: false },
    );
    expect(next.rotationDeg).toBeCloseTo(90, 9);
  });

  it('crossing the back of the circle does not jump by 360', () => {
    const geometry = geometryOf({ ...BASE, rotationDeg: 170 });
    const { origin } = geometry;
    const start = { x: origin.x - 100, y: origin.y - 1 };
    const now = { x: origin.x - 100, y: origin.y + 1 };
    const next = rotateTransform(geometry, start, now, { shift: false });
    expect(Math.abs(next.rotationDeg - 170)).toBeLessThan(2);
  });
});

describe('local point', () => {
  it('elementLocalPoint is the inverse of how the renderer places the box', () => {
    const transform = render({ ...BASE, scaleX: 2, rotationDeg: 33 });
    const bounds = nodeBoundsFromBox('node', transform, BOX);
    expectPoint(elementLocalPoint(transform, BOX, bounds.corners[2]), { x: 200, y: 100 });
    expectPoint(elementLocalPoint(transform, BOX, bounds.center), { x: 100, y: 50 });
  });
});

describe("the parent's space (B4)", () => {
  const parent = { x: 50, y: 60, scaleX: 2, scaleY: 0.5, rotationDeg: 90 };

  it('turns a world movement back into the parent space', () => {
    const local = worldDeltaToParentSpace({ x: 10, y: 0 }, parent)!;
    // Parent turned a quarter clockwise: world +x is the parent's -y.
    expect(local.x).toBeCloseTo(0, 9);
    expect(local.y).toBeCloseTo(-20, 9);
    expect(worldDeltaToParentSpace({ x: 3, y: 4 }, undefined)).toEqual({ x: 3, y: 4 });
    expect(worldDeltaToParentSpace({ x: 3, y: 4 }, { ...parent, scaleX: 0 })).toBeUndefined();
    expect(parentSpaceInvertible({ ...parent, scaleY: 0 })).toBe(false);
    expect(parentSpaceInvertible(parent)).toBe(true);
  });

  it('a move, scale and rotate written as local values draws where the box was dragged', () => {
    const local = { x: 30, y: -10, scaleX: 1.5, scaleY: 2, rotationDeg: 10 };
    const crop = { left: 0, top: 0, right: 0, bottom: 0 };
    const world = (value: typeof local) =>
      composeTransforms({ ...parent, opacity: 1, crop }, { ...value, opacity: 1, crop });
    const before = world(local);
    const drawnBefore = {
      x: before.x,
      y: before.y,
      scaleX: before.scaleX,
      scaleY: before.scaleY,
      rotationDeg: before.rotationDeg,
    };
    const targets: DrawnTransform[] = [
      moveTransform(drawnBefore, { x: 17, y: -9 }),
      { ...drawnBefore, scaleX: drawnBefore.scaleX * 1.25, x: drawnBefore.x + 4 },
      { ...drawnBefore, rotationDeg: drawnBefore.rotationDeg + 33 },
    ];
    for (const target of targets) {
      const next = applyWorldChange(local, drawnBefore, target, parent)!;
      const after = world(next);
      expect(after.x).toBeCloseTo(target.x, 5);
      expect(after.y).toBeCloseTo(target.y, 5);
      expect(after.scaleX).toBeCloseTo(target.scaleX, 5);
      expect(after.scaleY).toBeCloseTo(target.scaleY, 5);
      expect(after.rotationDeg).toBeCloseTo(target.rotationDeg, 5);
    }
  });

  it('values the gesture did not touch are written back exactly', () => {
    const local = { x: 0.1 + 0.2, y: 7, scaleX: 1 / 3, scaleY: 2, rotationDeg: 12.345678912 };
    const drawn = drawnTransformOf(render({ ...local }));
    const rotated = { ...drawn, rotationDeg: drawn.rotationDeg + 5 };
    const next = applyWorldChange(local, drawn, rotated, undefined)!;
    expect(next.x).toBe(local.x);
    expect(next.scaleX).toBe(local.scaleX);
    expect(next.rotationDeg).toBe(cleanNumber(local.rotationDeg + 5));
    expect(applyWorldChange(local, drawn, { ...drawn, x: 9 }, { ...parent, scaleX: 0 })).toBe(
      undefined,
    );
  });

  it('a zero scale stays zero (the ratio cannot be taken)', () => {
    const local = { x: 0, y: 0, scaleX: 0, scaleY: 1, rotationDeg: 0 };
    const next = applyWorldChange(local, local, { ...local, scaleX: 0 }, undefined)!;
    expect(next.scaleX).toBe(0);
  });
});
