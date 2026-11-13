import { describe, expect, it } from 'vitest';
import {
  nodeBoundsFromBox,
  rotatePointAbout,
  type NodePoint,
  type NodeRect,
  type Transform2D,
} from '@joy-media/render-ir';
import {
  boxGeometry,
  handlePoint,
  rotateTransform,
  scaleTransform,
  type DrawnTransform,
} from './monitor-transform-maths.js';
import { anchorFractionAt, anchorPointOf, moveAnchor } from './monitor-transform-anchor.js';
import {
  gestureBlockReasonFor,
  gestureLabel,
  gesturePatches,
  patchesChange,
  startTransformDrag,
  type MonitorTransformHost,
  type TransformPatches,
} from './monitor-transform-drag.js';
import type { MonitorTransformTarget } from './monitor-transform-targets.js';
import { buildMonitorOverlays } from './monitor-overlay-model.js';

/** The anchor point on the Monitor (T-M05b, ADR-0046 sections 5.2 and 5.8). */

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

function geometryOf(drawn: DrawnTransform, origin?: NodePoint, box: NodeRect = BOX) {
  const transform = render(drawn, origin);
  return boxGeometry(nodeBoundsFromBox('node', transform, box), transform);
}

function expectPoint(actual: NodePoint, expected: NodePoint, digits = 6): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
}

const FLAT: DrawnTransform = { x: 100, y: 200, scaleX: 1, scaleY: 1, rotationDeg: 0 };
const TURNED: DrawnTransform = { x: 100, y: 200, scaleX: 1.5, scaleY: 0.75, rotationDeg: 30 };

describe('anchor fractions and points', () => {
  it('turns a box fraction into a canvas point and back, on a turned and scaled box', () => {
    const geometry = geometryOf(TURNED, { x: 0.2, y: 0.7 });
    expectPoint(anchorPointOf(geometry, { x: 0, y: 0 }), geometry.corners[0]);
    expectPoint(anchorPointOf(geometry, { x: 1, y: 1 }), geometry.corners[2]);
    expectPoint(anchorPointOf(geometry, { x: 0.2, y: 0.7 }), geometry.origin);
    for (const fraction of [
      { x: 0.5, y: 0.5 },
      { x: 0, y: 1 },
      { x: -0.25, y: 1.5 },
    ])
      expectPoint(anchorFractionAt(geometry, anchorPointOf(geometry, fraction))!, fraction, 9);
  });

  it('a box with no size has no fraction', () => {
    const empty = geometryOf(FLAT, undefined, { x: 0, y: 0, width: 0, height: 100 });
    expect(anchorFractionAt(empty, { x: 10, y: 10 })).toBeUndefined();
    expect(moveAnchor(empty, { x: 0, y: 0 }, { x: 5, y: 5 })).toBeUndefined();
  });
});

describe('moving the anchor point never moves the picture', () => {
  it('not turned: only the anchor changes', () => {
    const geometry = geometryOf(FLAT);
    // From the centre (200, 250) to the top-left corner (100, 200).
    const moved = moveAnchor(geometry, { x: 200, y: 250 }, { x: 100, y: 200 })!;
    expect(moved.anchor).toEqual({ x: 0, y: 0 });
    expect(moved.transform).toEqual(FLAT);
  });

  it('turned: the position moves so every corner stays where it was', () => {
    for (const from of [undefined, { x: 0.9, y: 0.1 }]) {
      const geometry = geometryOf(TURNED, from);
      const start = geometry.origin;
      for (const now of [geometry.corners[0], { x: start.x + 37, y: start.y - 12 }]) {
        const moved = moveAnchor(geometry, start, now)!;
        const after = geometryOf(moved.transform, moved.anchor);
        // The stored numbers are rounded (cleanNumber), so a few millionths of a pixel.
        after.corners.forEach((corner, index) => expectPoint(corner, geometry.corners[index]!, 4));
        // The anchor fraction is rounded too: well under a thousandth of a pixel.
        expectPoint(after.origin, now, 3);
        expect(moved.transform.rotationDeg).toBe(TURNED.rotationDeg);
        expect(moved.transform.scaleX).toBe(TURNED.scaleX);
      }
    }
  });

  it('after the move the element turns about the new anchor, which stays put', () => {
    const geometry = geometryOf(TURNED);
    const moved = moveAnchor(geometry, geometry.origin, geometry.corners[3])!;
    const anchored = geometryOf(moved.transform, moved.anchor);
    const start = { x: anchored.origin.x + 100, y: anchored.origin.y };
    const turned = rotateTransform(anchored, start, rotatePointAbout(start, anchored.origin, 50), {
      shift: false,
    });
    expect(turned.rotationDeg).toBeCloseTo(TURNED.rotationDeg + 50, 9);
    expectPoint(geometryOf(turned, moved.anchor).origin, anchored.origin);
    expectPoint(geometryOf(turned, moved.anchor).corners[3], geometry.corners[3]);
  });

  it('Alt scales about the anchor point: it stays put, the box grows around it', () => {
    for (const drawn of [FLAT, TURNED]) {
      const origin = { x: 0, y: 1 };
      const geometry = geometryOf(drawn, origin);
      const start = handlePoint(geometry, 'ne');
      const now = { x: start.x + 20, y: start.y - 30 };
      const next = scaleTransform(geometry, 'ne', start, now, { shift: true, alt: true });
      expect(next.scaleX).toBeGreaterThan(drawn.scaleX);
      const after = geometryOf(next, origin);
      expectPoint(after.origin, geometry.origin);
      // The anchor here is the bottom-left corner, so that corner stays too.
      expectPoint(after.corners[3], geometry.corners[3]);
    }
  });
});

function target(
  drawn: DrawnTransform,
  options: {
    readonly origin?: NodePoint;
    readonly anchorBlocked?: MonitorTransformTarget['anchorBlocked'];
    readonly parent?: DrawnTransform;
    readonly local?: DrawnTransform;
    readonly id?: string;
  } = {},
): MonitorTransformTarget {
  const transform = render(drawn, options.origin);
  const id = options.id ?? 'shape';
  return {
    nodeId: id,
    clipId: `clip-${id}`,
    objectId: id,
    geometry: boxGeometry(nodeBoundsFromBox(id, transform, BOX), transform),
    local: options.local ?? drawn,
    anchor: options.origin ?? { x: 0.5, y: 0.5 },
    ...(options.anchorBlocked === undefined ? {} : { anchorBlocked: options.anchorBlocked }),
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    blocked: {},
  };
}

function host() {
  const steps: { label: string; patches: TransformPatches }[] = [];
  const recorder = {
    preview: () => undefined,
    cancel: () => undefined,
    commit: (label: string, patches: TransformPatches) => steps.push({ label, patches }),
  } satisfies MonitorTransformHost;
  return { recorder, steps };
}

describe('the anchor gesture', () => {
  it('writes the anchor (and, when turned, the position), one step on release', () => {
    const flat = target(FLAT);
    const flatPatch = gesturePatches(
      [flat],
      { kind: 'anchor' },
      { x: 200, y: 250 },
      { x: 150, y: 275 },
      {
        shift: false,
        alt: false,
      },
    )!;
    expect(flatPatch.get('shape')).toEqual({ ...FLAT, anchorX: 0.25, anchorY: 0.75 });
    const turned = target(TURNED);
    const { recorder, steps } = host();
    const start = turned.geometry.origin;
    const drag = startTransformDrag([turned], { kind: 'anchor' }, start, recorder);
    if ('blocked' in drag) throw new Error('blocked');
    drag.update({ x: start.x + 10, y: start.y }, { shift: false, alt: false });
    drag.update(turned.geometry.corners[0], { shift: false, alt: false });
    drag.end(true);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.label).toBe(gestureLabel({ kind: 'anchor' }));
    const patch = steps[0]!.patches.get('shape')!;
    expect(patch.anchorX).toBe(0);
    expect(patch.anchorY).toBe(0);
    expect(patch.rotationDeg).toBe(TURNED.rotationDeg);
    expect(patch.scaleX).toBe(TURNED.scaleX);
    // The picture is where it was.
    const after = geometryOf(patch, { x: patch.anchorX!, y: patch.anchorY! });
    after.corners.forEach((corner, index) => expectPoint(corner, turned.geometry.corners[index]!));
  });

  it('a parented element keeps its picture still in its parent space too', () => {
    const parent = { x: 50, y: 60, scaleX: 2, scaleY: 1, rotationDeg: 90 };
    // Drawn: turned by its parent's quarter plus its own 30 degrees.
    const drawn = { x: 300, y: 300, scaleX: 2, scaleY: 1, rotationDeg: 120 };
    const local = { x: 10, y: 20, scaleX: 1, scaleY: 1, rotationDeg: 30 };
    const child = target(drawn, { parent, local });
    const patch = gesturePatches(
      [child],
      { kind: 'anchor' },
      child.geometry.origin,
      child.geometry.corners[1],
      {
        shift: false,
        alt: false,
      },
    )!.get('shape')!;
    expect(patch.anchorX).toBe(1);
    expect(patch.anchorY).toBe(0);
    expect(patch.rotationDeg).toBe(30);
    expect(patch.scaleX).toBe(1);
    // The local move, put back through the parent, is the drawn move that keeps the picture.
    const moved = moveAnchor(child.geometry, child.geometry.origin, child.geometry.corners[1])!;
    const back = rotatePointAbout(
      { x: (patch.x - local.x) * parent.scaleX, y: (patch.y - local.y) * parent.scaleY },
      { x: 0, y: 0 },
      parent.rotationDeg,
    );
    expectPoint(back, { x: moved.transform.x - drawn.x, y: moved.transform.y - drawn.y }, 4);
  });

  it('a drag back to where it started writes nothing', () => {
    const shape = target(TURNED);
    const { recorder, steps } = host();
    const drag = startTransformDrag([shape], { kind: 'anchor' }, shape.geometry.origin, recorder);
    if ('blocked' in drag) throw new Error('blocked');
    drag.update({ x: 0, y: 0 }, { shift: false, alt: false });
    drag.update(shape.geometry.origin, { shift: false, alt: false });
    drag.end(true);
    expect(steps).toHaveLength(0);
    const same = gesturePatches(
      [shape],
      { kind: 'anchor' },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      {
        shift: false,
        alt: false,
      },
    )!;
    expect(patchesChange([shape], same)).toBe(false);
  });

  it('is for one element only, and a blocked anchor says why', () => {
    const pair = [target(FLAT), target(FLAT, { id: 'other' })];
    const { recorder } = host();
    expect(startTransformDrag(pair, { kind: 'anchor' }, { x: 0, y: 0 }, recorder)).toEqual({
      blocked: 'nothing',
    });
    const animated = target(TURNED, { anchorBlocked: 'animated' });
    expect(gestureBlockReasonFor([animated], { kind: 'anchor' })).toBe('animated');
    expect(startTransformDrag([animated], { kind: 'anchor' }, { x: 0, y: 0 }, recorder)).toEqual({
      blocked: 'animated',
    });
  });

  it('the overlay of one element carries its anchor point and why it is greyed', () => {
    const [overlay] = buildMonitorOverlays([target(TURNED, { origin: { x: 0, y: 0 } })], 1);
    expectPoint(overlay!.anchor!.point, overlay!.corners[0]!);
    expect(overlay!.anchor!.blocked).toBeUndefined();
    const [greyed] = buildMonitorOverlays([target(TURNED, { anchorBlocked: 'locked' })], 1);
    expect(greyed!.anchor!.blocked).toBe('locked');
  });
});
