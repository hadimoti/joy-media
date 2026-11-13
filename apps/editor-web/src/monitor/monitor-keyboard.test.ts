import { describe, expect, it, vi } from 'vitest';
import { createScopedKeyTable } from '../keyboard-shortcuts.js';
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
const TRANSFORM: Transform2D = { translateX: 100, translateY: 200, scaleX: 1, scaleY: 1 };
const LOCAL: LocalTransform = { x: 100, y: 200, scaleX: 1, scaleY: 1, rotationDeg: 0 };

/** A target whose box is drawn with `transform` and whose document values are `local`. */
function targetWith(
  transform: Transform2D,
  local: LocalTransform,
  objectId: string | undefined = 'shape',
  ancestorObjectIds?: readonly string[],
): MonitorTransformTarget {
  return {
    nodeId: objectId ?? 'clip-only',
    clipId: `clip-${objectId ?? 'only'}`,
    ...(objectId === undefined ? {} : { objectId }),
    geometry: boxGeometry(nodeBoundsFromBox(objectId ?? 'n', transform, BOX), transform),
    local,
    ...(ancestorObjectIds === undefined ? {} : { ancestorObjectIds }),
    blocked: {},
  };
}

/** The box centre that the renderer draws for a set of values (the same maths as the box). */
function centreOf(values: LocalTransform): { x: number; y: number } {
  const transform: Transform2D = {
    translateX: values.x,
    translateY: values.y,
    scaleX: values.scaleX,
    scaleY: values.scaleY,
    rotationDeg: values.rotationDeg,
  };
  return nodeBoundsFromBox('shape', transform, BOX).center;
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

describe('bracket rotate keys (matched by physical key)', () => {
  it('turns 1 degree on BracketLeft and BracketRight, and 15 with Shift', () => {
    expect(keyboardRotateDegrees('BracketRight', false)).toBe(1);
    expect(keyboardRotateDegrees('BracketLeft', false)).toBe(-1);
    expect(keyboardRotateDegrees('BracketRight', true)).toBe(15);
    expect(keyboardRotateDegrees('BracketLeft', true)).toBe(-15);
    expect(keyboardRotateDegrees('KeyX', false)).toBeUndefined();
  });
});

describe('Tab steps through elements without wrapping', () => {
  const ids = ['a', 'b', 'c'];

  it('moves forward and backward from the selected element', () => {
    expect(nextElementClipId(ids, ['a'], false)).toBe('b');
    expect(nextElementClipId(ids, ['b'], true)).toBe('a');
  });

  it('returns undefined at the last element going forward, so focus can leave', () => {
    expect(nextElementClipId(ids, ['c'], false)).toBeUndefined();
  });

  it('returns undefined at the first element going backward, so focus can leave', () => {
    expect(nextElementClipId(ids, ['a'], true)).toBeUndefined();
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
  it('scales about the centre: the box centre does not move (axis-aligned)', () => {
    const before = targetWith(TRANSFORM, LOCAL);
    const patches = keyboardChangePatches([before], { kind: 'scale', factor: 2 });
    const next = patches?.get('shape');
    expect(next?.scaleX).toBeCloseTo(2);
    expect(next?.scaleY).toBeCloseTo(2);
    // The origin moved (the element grew from its centre), the centre did not.
    expect(next?.x).not.toBeCloseTo(LOCAL.x);
    const centre = centreOf({ ...LOCAL });
    const after = centreOf(next as LocalTransform);
    expect(after.x).toBeCloseTo(centre.x, 6);
    expect(after.y).toBeCloseTo(centre.y, 6);
  });

  it('keeps the centre fixed for a turned element too', () => {
    const turned: Transform2D = { ...TRANSFORM, rotationDeg: 30 };
    const local: LocalTransform = { ...LOCAL, rotationDeg: 30 };
    const patches = keyboardChangePatches([targetWith(turned, local)], {
      kind: 'scale',
      factor: 0.5,
    });
    const next = patches?.get('shape') as LocalTransform;
    const centre = centreOf(local);
    const after = centreOf(next);
    expect(after.x).toBeCloseTo(centre.x, 6);
    expect(after.y).toBeCloseTo(centre.y, 6);
  });

  it('never scales below the smallest allowed size', () => {
    const patches = keyboardChangePatches([targetWith(TRANSFORM, LOCAL)], {
      kind: 'scale',
      factor: 0.0001,
    });
    expect(patches?.get('shape')?.scaleX).toBeCloseTo(MIN_SCALE, 9);
    expect(patches?.get('shape')?.scaleY).toBeCloseTo(MIN_SCALE, 9);
  });

  it('does not raise a scale that is already below the smallest size when shrinking', () => {
    const tiny: Transform2D = { ...TRANSFORM, scaleX: 0.005, scaleY: 0.005 };
    const local: LocalTransform = { ...LOCAL, scaleX: 0.005, scaleY: 0.005 };
    const patches = keyboardChangePatches([targetWith(tiny, local)], {
      kind: 'scale',
      factor: 0.5,
    });
    expect(patches?.get('shape')?.scaleX).toBeCloseTo(0.005, 9);
    expect(patches?.get('shape')?.scaleY).toBeCloseTo(0.005, 9);
  });

  it('turns the element and wraps the angle to the usual range', () => {
    const turned: LocalTransform = { ...LOCAL, rotationDeg: 179 };
    const patches = keyboardChangePatches([targetWith(TRANSFORM, turned)], {
      kind: 'rotate',
      degrees: 2,
    });
    expect(patches?.get('shape')?.rotationDeg).toBe(-179);
  });

  it('writes only the topmost selected ancestor, so a child is not moved twice', () => {
    const child = targetWith(TRANSFORM, LOCAL, 'child', ['parent']);
    const parent = targetWith(TRANSFORM, LOCAL, 'parent');
    const patches = keyboardChangePatches([parent, child], { kind: 'rotate', degrees: 15 });
    expect([...(patches?.keys() ?? [])]).toEqual(['parent']);
  });

  it('skips a selected clip that has no visual object', () => {
    const orphan: { objectId?: string } & MonitorTransformTarget = targetWith(TRANSFORM, LOCAL);
    delete orphan.objectId;
    const patches = keyboardChangePatches([orphan], { kind: 'rotate', degrees: 1 });
    expect(patches?.size).toBe(0);
  });
});

describe('Monitor keys do not fire while typing (T-M12)', () => {
  // The guard reads only the target's tag name, so plain objects stand in for the elements.
  const key = (code: string, tagName: string) => ({
    key: code === 'BracketRight' ? ']' : '[',
    code,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: { tagName } as unknown as EventTarget,
  });

  it('a bracket typed into a text field is left to the field, and fires in the picture', () => {
    const table = createScopedKeyTable();
    const run = vi.fn();
    table.setScope('monitor', () => true);
    table.register({
      scope: 'monitor',
      match: (event) => keyboardRotateDegrees(event.code ?? '', event.shiftKey) !== undefined,
      run,
    });

    expect(table.dispatch(key('BracketRight', 'INPUT'))).toBe(false);
    expect(run).not.toHaveBeenCalled();

    expect(table.dispatch(key('BracketRight', 'DIV'))).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
