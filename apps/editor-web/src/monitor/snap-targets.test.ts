import { describe, expect, it } from 'vitest';
import {
  SNAP_DISTANCE_SCREEN_PX,
  collectSnapTargets,
  snapMove,
  snapScale,
  type SnapBox,
} from './snap-targets.js';

const FRAME = { width: 1000, height: 500 };

describe('Monitor snap targets', () => {
  it('collects the frame, 90% and 93% safe margins, and saved user guides', () => {
    const targets = collectSnapTargets(
      FRAME,
      [],
      [
        { axis: 'x', position: 123 },
        { axis: 'y', position: 234 },
      ],
    );

    expect(
      targets.map((target) => ({ ...target, position: Number(target.position.toFixed(1)) })),
    ).toEqual(
      expect.arrayContaining([
        { axis: 'x', position: 0, kind: 'frame-edge' },
        { axis: 'x', position: 500, kind: 'frame-centre' },
        { axis: 'x', position: 1000, kind: 'frame-edge' },
        { axis: 'y', position: 250, kind: 'frame-centre' },
        { axis: 'x', position: 50, kind: 'title-safe' },
        { axis: 'x', position: 950, kind: 'title-safe' },
        { axis: 'y', position: 17.5, kind: 'action-safe' },
        { axis: 'y', position: 482.5, kind: 'action-safe' },
        { axis: 'x', position: 123, kind: 'user-guide' },
        { axis: 'y', position: 234, kind: 'user-guide' },
      ]),
    );
  });

  it('collects the edges and centres of other element boxes', () => {
    const targets = collectSnapTargets(FRAME, [{ x: 100, y: 40, width: 80, height: 60 }]);

    expect(targets).toEqual(
      expect.arrayContaining([
        { axis: 'x', position: 100, kind: 'element-edge' },
        { axis: 'x', position: 140, kind: 'element-centre' },
        { axis: 'x', position: 180, kind: 'element-edge' },
        { axis: 'y', position: 40, kind: 'element-edge' },
        { axis: 'y', position: 70, kind: 'element-centre' },
        { axis: 'y', position: 100, kind: 'element-edge' },
      ]),
    );
  });

  it('chooses the nearest target independently on both axes', () => {
    const box: SnapBox = { x: 95, y: 195, width: 10, height: 10 };
    const targets = [
      { axis: 'x' as const, position: 105.1, kind: 'element-edge' as const },
      { axis: 'x' as const, position: 101, kind: 'frame-centre' as const },
      { axis: 'y' as const, position: 200, kind: 'user-guide' as const },
    ];

    const result = snapMove(box, targets, 1);

    expect(result.box).toEqual({ x: 95.1, y: 195, width: 10, height: 10 });
    expect(result.guides).toEqual([
      { axis: 'x', position: 105.1, kind: 'element-edge' },
      { axis: 'y', position: 200, kind: 'user-guide' },
    ]);
  });

  it.each([
    {
      label: 'left canvas edge',
      box: { x: 5, y: 200, width: 20, height: 20 },
      otherBoxes: [],
      guides: [],
      axis: 'x',
      position: 0,
      kind: 'frame-edge',
      expected: { x: 0, y: 200, width: 20, height: 20 },
    },
    {
      label: 'right canvas edge',
      box: { x: 974, y: 200, width: 20, height: 20 },
      otherBoxes: [],
      guides: [],
      axis: 'x',
      position: 1000,
      kind: 'frame-edge',
      expected: { x: 980, y: 200, width: 20, height: 20 },
    },
    {
      label: 'title-safe margin',
      box: { x: 56, y: 200, width: 20, height: 20 },
      otherBoxes: [],
      guides: [],
      axis: 'x',
      position: 50,
      kind: 'title-safe',
      expected: { x: 50, y: 200, width: 20, height: 20 },
    },
    {
      label: 'action-safe margin',
      box: { x: 100, y: 11.5, width: 20, height: 2 },
      otherBoxes: [],
      guides: [],
      axis: 'y',
      position: 17.5,
      kind: 'action-safe',
      expected: { x: 100, y: 15.5, width: 20, height: 2 },
    },
    {
      label: 'user guide',
      box: { x: 127, y: 200, width: 20, height: 20 },
      otherBoxes: [],
      guides: [{ axis: 'x' as const, position: 123 }],
      axis: 'x',
      position: 123,
      kind: 'user-guide',
      expected: { x: 123, y: 200, width: 20, height: 20 },
    },
    {
      label: 'other element edge',
      box: { x: 104, y: 200, width: 20, height: 20 },
      otherBoxes: [{ x: 100, y: 40, width: 80, height: 60 }],
      guides: [],
      axis: 'x',
      position: 100,
      kind: 'element-edge',
      expected: { x: 100, y: 200, width: 20, height: 20 },
    },
    {
      label: 'other element centre',
      box: { x: 129, y: 200, width: 20, height: 20 },
      otherBoxes: [{ x: 100, y: 40, width: 80, height: 60 }],
      guides: [],
      axis: 'x',
      position: 140,
      kind: 'element-centre',
      expected: { x: 130, y: 200, width: 20, height: 20 },
    },
  ])(
    'snaps to the $label at the exact target position',
    ({ box, otherBoxes, guides, axis, position, kind, expected }) => {
      const targets = collectSnapTargets(FRAME, otherBoxes, guides);
      const result = snapMove(box, targets, 1);

      expect(result.box.x).toBeCloseTo(expected.x, 10);
      expect(result.box.y).toBeCloseTo(expected.y, 10);
      expect(result.box.width).toBe(expected.width);
      expect(result.box.height).toBe(expected.height);
      const guide = result.guides.find((candidate) => candidate.axis === axis);
      expect(guide?.kind).toBe(kind);
      expect(guide?.position).toBeCloseTo(position, 10);
    },
  );

  it('moves the dragged scale edge to a target while holding its opposite edge', () => {
    const initial: SnapBox = { x: 10, y: 10, width: 90, height: 40 };
    const candidate: SnapBox = { x: 10, y: 10, width: 94, height: 40 };
    const target = { axis: 'x' as const, position: 106, kind: 'element-edge' as const };

    const result = snapScale(candidate, initial, 'e', [target], 1);

    expect(result.box).toEqual({ x: 10, y: 10, width: 96, height: 40 });
    expect(result.guides).toEqual([target]);
  });

  it('bypasses snapping while Ctrl is held', () => {
    const box: SnapBox = { x: 94, y: 94, width: 10, height: 10 };
    const target = { axis: 'x' as const, position: 100, kind: 'frame-edge' as const };

    expect(snapMove(box, [target], 1, true)).toEqual({ box, guides: [] });
    expect(snapScale({ ...box, width: 13 }, box, 'e', [target], 1, true)).toEqual({
      box: { ...box, width: 13 },
      guides: [],
    });
  });

  it.each([
    { zoom: 0.5, delta: 11, shouldSnap: true },
    { zoom: 0.5, delta: 13, shouldSnap: false },
    { zoom: 2, delta: 2.5, shouldSnap: true },
    { zoom: 2, delta: 3.5, shouldSnap: false },
  ])('uses a 6 screen-pixel threshold at zoom $zoom', ({ zoom, delta, shouldSnap }) => {
    const box: SnapBox = { x: 0, y: 0, width: 20, height: 20 };
    const result = snapMove(
      box,
      [{ axis: 'x', position: box.x + box.width + delta, kind: 'frame-edge' }],
      zoom,
    );

    expect(result.guides.length > 0).toBe(shouldSnap);
    expect(SNAP_DISTANCE_SCREEN_PX).toBe(6);
  });

  it('does not change the box when no target is in range', () => {
    const box: SnapBox = { x: 10, y: 20, width: 30, height: 40 };

    expect(snapMove(box, [{ axis: 'x', position: 100, kind: 'frame-edge' }], 1)).toEqual({
      box,
      guides: [],
    });
  });
});
