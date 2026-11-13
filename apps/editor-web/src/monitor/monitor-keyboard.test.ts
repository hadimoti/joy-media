import { describe, expect, it } from 'vitest';
import { nodeBoundsFromBox, type Transform2D } from '@joy-media/render-ir';
import { MIN_SCALE, boxGeometry, type LocalTransform } from './monitor-transform-maths.js';
import type { MonitorTransformTarget } from './monitor-transform-targets.js';
import {
  keyboardChangePatches,
  keyboardRotateDegrees,
  keyboardScaleFactor,
  nextElementClipId,
} from './monitor-keyboard.js';

/** T-M12: the keyboard-only transforms and element cycling, as pure functions. */

const BOX = { x: 0, y: 0, width: 100, height: 100 };
const LOCAL: LocalTransform = { x: 100, y: 200, scaleX: 1, scaleY: 1, rotationDeg: 0 };

function target(
  objectId: string | undefined,
  local: LocalTransform = LOCAL,
  ancestorObjectIds?: readonly string[],
): MonitorTransformTarget {
  const transform: Transform2D = { translateX: 100, translateY: 200, scaleX: 1, scaleY: 1 };
  return {
    nodeId: objectId ?? 'clip-only',
    clipId: `clip-${objectId ?? 'only'}`,
    objectId,
    geometry: boxGeometry(nodeBoundsFromBox(objectId ?? 'n', transform, BOX), transform),
    local,
    ancestorObjectIds,
    blocked: {},
  };
}

describe('Alt+arrow scale factors', () => {
  it('grows by 1 percent on Up and Right, shrinks on Down and Left', () => {
    expect(keyboardScaleFactor('ArrowUp', false)).toBeCloseTo(1.01);
    expect(keyboardScaleFactor('ArrowRight', false)).toBeCloseTo(1.01);
    expect(keyboardScaleFactor('ArrowDown', false)).toBeCloseTo(0.99);
    expect(keyboardScaleFactor('ArrowLeft', false)).toBeCloseTo(0.99);
  });

  it('uses 10 percent with Shift and ignores other keys', () => {
    expect(keyboardScaleFactor('ArrowUp', true)).toBeCloseTo(1.1);
    expect(keyboardScaleFactor('ArrowLeft', true)).toBeCloseTo(0.9);
    expect(keyboardScaleFactor('a', false)).toBeUndefined();
  });
});

describe('[ ] rotate keys', () => {
  it('turns 1 degree on [ and ], and 15 on { and }', () => {
    expect(keyboardRotateDegrees(']')).toBe(1);
    expect(keyboardRotateDegrees('[')).toBe(-1);
    expect(keyboardRotateDegrees('}')).toBe(15);
    expect(keyboardRotateDegrees('{')).toBe(-15);
    expect(keyboardRotateDegrees('x')).toBeUndefined();
  });
});

describe('Tab cycles through elements', () => {
  const ids = ['a', 'b', 'c'];

  it('moves forward from the selected element and wraps at the end', () => {
    expect(nextElementClipId(ids, ['a'], false)).toBe('b');
    expect(nextElementClipId(ids, ['c'], false)).toBe('a');
  });

  it('moves backward and wraps at the start', () => {
    expect(nextElementClipId(ids, ['a'], true)).toBe('c');
    expect(nextElementClipId(ids, ['b'], true)).toBe('a');
  });

  it('takes the first element with nothing selected, the last going backward', () => {
    expect(nextElementClipId(ids, [], false)).toBe('a');
    expect(nextElementClipId(ids, [], true)).toBe('c');
  });

  it('returns undefined when there are no elements', () => {
    expect(nextElementClipId([], [], false)).toBeUndefined();
  });
});

describe('keyboard scale and rotate patches', () => {
  it('scales the size about the element and keeps its position', () => {
    const patches = keyboardChangePatches([target('shape')], { kind: 'scale', factor: 2 });
    expect(patches?.get('shape')).toEqual({ ...LOCAL, scaleX: 2, scaleY: 2 });
  });

  it('never scales below the smallest allowed size', () => {
    const patches = keyboardChangePatches([target('shape')], { kind: 'scale', factor: 0.0001 });
    expect(patches?.get('shape')?.scaleX).toBe(MIN_SCALE);
    expect(patches?.get('shape')?.scaleY).toBe(MIN_SCALE);
  });

  it('turns the element and wraps the angle to the usual range', () => {
    const turned = { ...LOCAL, rotationDeg: 179 };
    const patches = keyboardChangePatches([target('shape', turned)], {
      kind: 'rotate',
      degrees: 2,
    });
    expect(patches?.get('shape')?.rotationDeg).toBe(-179);
  });

  it('writes only the topmost selected ancestor, so a child is not moved twice', () => {
    const child = target('child', LOCAL, ['parent']);
    const parent = target('parent');
    const patches = keyboardChangePatches([parent, child], { kind: 'rotate', degrees: 15 });
    expect([...(patches?.keys() ?? [])]).toEqual(['parent']);
  });

  it('skips a selected clip that has no visual object', () => {
    const patches = keyboardChangePatches([target(undefined)], { kind: 'rotate', degrees: 1 });
    expect(patches?.size).toBe(0);
  });
});
