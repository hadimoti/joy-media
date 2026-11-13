import { describe, expect, it } from 'vitest';
import {
  nodeBoundsFromBox,
  rotatePointAbout,
  type NodePoint,
  type NodeRect,
  type Transform2D,
} from '@joy-media/render-ir';
import {
  MIN_SCALE,
  MONITOR_SCALE_HANDLES,
  boxGeometry,
  handlePoint,
  type DrawnTransform,
  type TransformBoxGeometry,
} from './monitor-transform-maths.js';
import {
  groupGeometry,
  groupScaleOf,
  groupTurnOf,
  rotateMemberAbout,
  scaleMemberAbout,
} from './monitor-transform-group.js';
import {
  gestureBlockReasonFor,
  gesturePatches,
  startTransformDrag,
  type MonitorTransformHost,
} from './monitor-transform-drag.js';
import type { MonitorTransformTarget } from './monitor-transform-targets.js';
import { buildMonitorGroupOverlay, buildMonitorOverlays } from './monitor-overlay-model.js';

/** Group scale and rotate (T-M05b, ADR-0046 section 5.7). */

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
function geometryOf(drawn: DrawnTransform, origin?: NodePoint, box: NodeRect = BOX) {
  const transform = render(drawn, origin);
  return boxGeometry(nodeBoundsFromBox('node', transform, box), transform);
}

function expectPoint(actual: NodePoint, expected: NodePoint, digits = 6): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
}

const A: DrawnTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 };
const B: DrawnTransform = { x: 300, y: 50, scaleX: 0.5, scaleY: 1, rotationDeg: 0 };
const TURNED: DrawnTransform = { x: 120, y: 260, scaleX: 1.5, scaleY: 0.8, rotationDeg: 35 };
const QUARTER: DrawnTransform = { x: 400, y: 300, scaleX: 1, scaleY: 0.5, rotationDeg: 90 };

describe('the group box', () => {
  it('is the straight box around every element, turned ones included', () => {
    const a = geometryOf(A);
    const b = geometryOf(B);
    const group = groupGeometry([a, b])!;
    expect(group.corners).toEqual([
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: 150 },
      { x: 0, y: 150 },
    ]);
    expect(group.center).toEqual({ x: 200, y: 75 });
    expect(group.origin).toEqual(group.center);
    expect(group.transform.rotationDeg).toBe(0);
    const turned = geometryOf(TURNED);
    const withTurned = groupGeometry([a, turned])!;
    const xs = turned.corners.map((corner) => corner.x);
    const ys = turned.corners.map((corner) => corner.y);
    expect(withTurned.corners[2]).toEqual({ x: Math.max(200, ...xs), y: Math.max(100, ...ys) });
    expect(groupGeometry([])).toBeUndefined();
  });
});

/** Every corner of a member after the gesture, drawn as the renderer would. */
function cornersAfter(geometry: TransformBoxGeometry, next: DrawnTransform, origin?: NodePoint) {
  return geometryOf(next, origin).corners;
}

describe('group rotation turns every element about the group centre', () => {
  const members = [geometryOf(A), geometryOf(B), geometryOf(TURNED), geometryOf(QUARTER)];
  const group = groupGeometry(members)!;

  it('each element turns as one rigid piece: every corner goes round the group centre', () => {
    for (const degrees of [90, -45, 17.5, 180]) {
      for (const member of members) {
        const next = rotateMemberAbout(member, group.center, degrees);
        expect(next.rotationDeg).toBeCloseTo(member.transform.rotationDeg + degrees, 9);
        expect(next.scaleX).toBe(member.transform.scaleX);
        expect(next.scaleY).toBe(member.transform.scaleY);
        cornersAfter(member, next).forEach((corner, index) =>
          expectPoint(corner, rotatePointAbout(member.corners[index]!, group.center, degrees)),
        );
      }
    }
  });

  it('an element with a moved anchor point turns about the group centre too', () => {
    const origin = { x: 0, y: 1 };
    const member = geometryOf(TURNED, origin);
    const next = rotateMemberAbout(member, group.center, 60);
    cornersAfter(member, next, origin).forEach((corner, index) =>
      expectPoint(corner, rotatePointAbout(member.corners[index]!, group.center, 60)),
    );
  });

  it('the turn is the angle swept about the centre; Shift snaps the turn to 15 degrees', () => {
    const start = { x: group.center.x + 100, y: group.center.y };
    const swept = rotatePointAbout(start, group.center, 37);
    expect(groupTurnOf(group, start, swept, { shift: false })).toBeCloseTo(37, 9);
    expect(groupTurnOf(group, start, swept, { shift: true })).toBe(30);
    expect(groupTurnOf(group, group.center, swept, { shift: false })).toBe(0);
    expect(rotateMemberAbout(members[0]!, group.center, 0)).toBe(members[0]!.transform);
  });
});

describe('group scale', () => {
  const a = geometryOf(A);
  const b = geometryOf(B);
  const group = groupGeometry([a, b])!;

  it('scales every element about the opposite handle of the group box', () => {
    // Drag the bottom-right corner from (400, 150) to (800, 225): twice as wide, 1.5 tall.
    const scale = groupScaleOf(
      group,
      'se',
      { x: 400, y: 150 },
      { x: 800, y: 225 },
      {
        shift: false,
        alt: false,
      },
    );
    expect(scale.fixed).toEqual({ x: 0, y: 0 });
    expect(scale.kx).toBeCloseTo(2, 9);
    expect(scale.ky).toBeCloseTo(1.5, 9);
    for (const member of [a, b]) {
      const next = scaleMemberAbout(member, scale);
      expect(next.scaleX).toBeCloseTo(member.transform.scaleX * 2, 9);
      expect(next.scaleY).toBeCloseTo(member.transform.scaleY * 1.5, 9);
      cornersAfter(member, next).forEach((corner, index) =>
        expectPoint(corner, {
          x: 2 * member.corners[index]!.x,
          y: 1.5 * member.corners[index]!.y,
        }),
      );
    }
  });

  it('Alt scales about the group centre; Shift keeps the proportions', () => {
    const scale = groupScaleOf(
      group,
      'e',
      { x: 400, y: 75 },
      { x: 500, y: 75 },
      {
        shift: true,
        alt: true,
      },
    );
    expect(scale.fixed).toEqual(group.center);
    expect(scale.kx).toBeCloseTo(1.5, 9);
    expect(scale.ky).toBeCloseTo(1.5, 9);
    const next = scaleMemberAbout(b, scale);
    cornersAfter(b, next).forEach((corner, index) =>
      expectPoint(corner, {
        x: group.center.x + 1.5 * (b.corners[index]!.x - group.center.x),
        y: group.center.y + 1.5 * (b.corners[index]!.y - group.center.y),
      }),
    );
  });

  it('a turned element scales exactly when the proportions are kept, about its anchor too', () => {
    for (const origin of [undefined, { x: 0.1, y: 0.9 }]) {
      const member = geometryOf(TURNED, origin);
      const scale = { fixed: { x: 50, y: 40 }, kx: 0.6, ky: 0.6 };
      const next = scaleMemberAbout(member, scale);
      expect(next.rotationDeg).toBe(TURNED.rotationDeg);
      cornersAfter(member, next, origin).forEach((corner, index) =>
        expectPoint(corner, {
          x: 50 + 0.6 * (member.corners[index]!.x - 50),
          y: 40 + 0.6 * (member.corners[index]!.y - 40),
        }),
      );
    }
  });

  it('an uneven stretch on a quarter-turned element swaps its axes; its anchor follows the group', () => {
    const member = geometryOf(QUARTER);
    const scale = { fixed: { x: 0, y: 0 }, kx: 2, ky: 3 };
    const next = scaleMemberAbout(member, scale);
    // Turned a quarter, the element's own width runs down the frame.
    expect(next.scaleX).toBeCloseTo(QUARTER.scaleX * 3, 9);
    expect(next.scaleY).toBeCloseTo(QUARTER.scaleY * 2, 9);
    expectPoint(geometryOf(next).origin, { x: 2 * member.origin.x, y: 3 * member.origin.y });
    // Then the corners land exactly where the stretch puts them.
    cornersAfter(member, next).forEach((corner, index) =>
      expectPoint(corner, { x: 2 * member.corners[index]!.x, y: 3 * member.corners[index]!.y }),
    );
  });

  it('never flips: past the opposite side the group stops at 1 % and no element goes under its floor', () => {
    for (const handle of MONITOR_SCALE_HANDLES) {
      const start = handlePoint(group, handle);
      const scale = groupScaleOf(
        group,
        handle,
        start,
        { x: -5000, y: -5000 },
        {
          shift: false,
          alt: false,
        },
      );
      expect(scale.kx).toBeGreaterThan(0);
      expect(scale.ky).toBeGreaterThan(0);
      for (const member of [a, b, geometryOf(TURNED)]) {
        const next = scaleMemberAbout(member, scale);
        for (const value of Object.values(next)) expect(Number.isFinite(value)).toBe(true);
        expect(next.scaleX).toBeGreaterThanOrEqual(
          Math.min(MIN_SCALE, member.transform.scaleX) - 1e-12,
        );
        expect(next.scaleY).toBeGreaterThanOrEqual(
          Math.min(MIN_SCALE, member.transform.scaleY) - 1e-12,
        );
      }
    }
  });
});

function target(
  id: string,
  drawn: DrawnTransform,
  blocked: MonitorTransformTarget['blocked'] = {},
  parent?: DrawnTransform,
  local: DrawnTransform = drawn,
): MonitorTransformTarget {
  const transform = render(drawn);
  return {
    nodeId: id,
    clipId: `clip-${id}`,
    objectId: id,
    geometry: boxGeometry(nodeBoundsFromBox(id, transform, BOX), transform),
    local,
    ...(parent === undefined ? {} : { parent }),
    blocked,
  };
}

function host() {
  const steps: { label: string; size: number }[] = [];
  const recorder = {
    preview: () => undefined,
    cancel: () => undefined,
    commit: (label: string, patches: ReadonlyMap<string, unknown>) =>
      steps.push({ label, size: patches.size }),
  } satisfies MonitorTransformHost;
  return { recorder, steps };
}

describe('group gestures on the selected targets', () => {
  const pair = [target('a', A), target('b', B)];

  it('need two or more elements; one element keeps its own handles', () => {
    expect(
      gesturePatches(
        [pair[0]!],
        { kind: 'group-rotate' },
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        {
          shift: false,
          alt: false,
        },
      ),
    ).toBeUndefined();
    expect(buildMonitorGroupOverlay([pair[0]!], 1)).toBeUndefined();
    const group = buildMonitorGroupOverlay(pair, 1)!;
    expect(group.group).toBe(true);
    expect(group.handles.map((handle) => handle.id)).toEqual([
      'nw',
      'n',
      'ne',
      'e',
      'se',
      's',
      'sw',
      'w',
      'rotate',
    ]);
    expect(group.corners[2]).toEqual({ x: 400, y: 150 });
    // The element boxes stay outlines only, without an anchor point.
    for (const overlay of buildMonitorOverlays(pair, 1)) {
      expect(overlay.handles).toHaveLength(0);
      expect(overlay.anchor).toBeUndefined();
    }
  });

  it('a group rotate writes position and rotation of every element, one step on release', () => {
    const group = groupGeometry(pair.map((item) => item.geometry))!;
    const start = { x: group.center.x + 100, y: group.center.y };
    const now = rotatePointAbout(start, group.center, 90);
    const patches = gesturePatches(pair, { kind: 'group-rotate' }, start, now, {
      shift: false,
      alt: false,
    })!;
    expect(patches.get('a')!.rotationDeg).toBeCloseTo(90, 9);
    expect(patches.get('b')!.rotationDeg).toBeCloseTo(90, 9);
    // A's centre (100, 50) goes round (200, 75) by a quarter turn to (225, -25).
    const aAfter = geometryOf({ ...A, ...patches.get('a')! });
    expectPoint(aAfter.center, { x: 225, y: -25 });
    const { recorder, steps } = host();
    const drag = startTransformDrag(pair, { kind: 'group-rotate' }, start, recorder);
    if ('blocked' in drag) throw new Error('blocked');
    for (let step = 1; step <= 9; step += 1)
      drag.update(rotatePointAbout(start, group.center, step * 10), { shift: false, alt: false });
    drag.end(true);
    expect(steps).toEqual([{ label: 'Rotate on the Monitor', size: 2 }]);
  });

  it('a group scale writes position and scale of every element, one step on release', () => {
    const { recorder, steps } = host();
    const drag = startTransformDrag(
      pair,
      { kind: 'group-scale', handle: 'se' },
      { x: 400, y: 150 },
      recorder,
    );
    if ('blocked' in drag) throw new Error('blocked');
    drag.update({ x: 500, y: 200 }, { shift: false, alt: false });
    drag.update({ x: 800, y: 225 }, { shift: false, alt: false });
    drag.end(true);
    expect(steps).toEqual([{ label: 'Scale on the Monitor', size: 2 }]);
    const patches = gesturePatches(
      pair,
      { kind: 'group-scale', handle: 'se' },
      { x: 400, y: 150 },
      { x: 800, y: 225 },
      { shift: false, alt: false },
    )!;
    expect(patches.get('b')).toEqual({ x: 600, y: 75, scaleX: 1, scaleY: 1.5, rotationDeg: 0 });
  });

  it('a parented element gets its values in its parent space', () => {
    // The parent is turned a quarter and twice as wide (as in the move test).
    const parent = { x: 50, y: 60, scaleX: 2, scaleY: 1, rotationDeg: 90 };
    const child = target('child', { ...A, x: 300, y: 300, rotationDeg: 90 }, {}, parent, {
      x: 10,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
    });
    const patches = gesturePatches(
      [pair[0]!, child],
      { kind: 'group-rotate' },
      { x: 1000, y: 0 },
      { x: 1000, y: 0 },
      { shift: false, alt: false },
    )!;
    expect(patches.get('child')).toEqual(child.local);
    const group = groupGeometry([pair[0]!.geometry, child.geometry])!;
    const start = { x: group.center.x + 50, y: group.center.y };
    const turned = gesturePatches(
      [pair[0]!, child],
      { kind: 'group-rotate' },
      start,
      rotatePointAbout(start, group.center, 30),
      { shift: false, alt: false },
    )!;
    // Rotation is local: the parent adds its own, so the child's own value turns by 30.
    expect(turned.get('child')!.rotationDeg).toBeCloseTo(30, 9);
    expect(turned.get('child')!.scaleX).toBe(1);
  });

  it('a value from an expression blocks the group gesture that writes it; keyframes do not', () => {
    const expression = [target('a', A, { scale: 'expression' }), target('b', B)];
    expect(gestureBlockReasonFor(expression, { kind: 'group-scale', handle: 'se' })).toBe(
      'expression',
    );
    expect(gestureBlockReasonFor(expression, { kind: 'group-rotate' })).toBeUndefined();
    const moving = [target('a', A, { move: 'expression', scale: 'expression' }), target('b', B)];
    // Turning a group moves its elements, so an expression on the position blocks it.
    expect(gestureBlockReasonFor(moving, { kind: 'group-rotate' })).toBe('expression');
    const overlay = buildMonitorGroupOverlay(moving, 1)!;
    expect(overlay.handles.find((handle) => handle.id === 'rotate')!.blocked).toBe('expression');
    const { recorder } = host();
    expect(startTransformDrag(moving, { kind: 'group-rotate' }, { x: 0, y: 0 }, recorder)).toEqual({
      blocked: 'expression',
    });
  });
});
