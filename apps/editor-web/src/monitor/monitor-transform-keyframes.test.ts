import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import {
  DUAL_LENS_FLAG_KEY,
  validateJoyProjectV1,
  type AnimationCurveV1,
  type JoyProjectV1,
  type VisualObjectV1,
} from '@joy-media/project-schema';
import { nodeBoundsFromBox, type Transform2D } from '@joy-media/render-ir';
import { resolveObjectTransform } from '@joy-media/motion-core';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { EditorSession } from '../editor-session.js';
import {
  applyTransformPatch,
  gestureKeyframe,
  keyframeTime,
  localValuesAt,
  type TransformPatch,
} from './monitor-transform-keyframes.js';
import { withTransformPatches } from './monitor-transform-preview.js';
import { boxGeometry } from './monitor-transform-maths.js';
import {
  startTransformDrag,
  type MonitorTransformHost,
  type TransformPatches,
} from './monitor-transform-drag.js';
import type { MonitorTransformTarget } from './monitor-transform-targets.js';

/** A keyframe on release when the stopwatch is on (T-M05b, ADR-0046 section 5.6). */

const HALF = 500_000;
const crop = { left: 0, top: 0, right: 0, bottom: 0 };

const X_CURVE: AnimationCurveV1 = {
  keyframes: [
    { timeUs: 0, value: 100, interpolation: 'linear' },
    { timeUs: 1_000_000, value: 300, interpolation: 'hold' },
  ],
};

function shape(animations?: VisualObjectV1['animations']): VisualObjectV1 {
  return {
    id: 'shape',
    kind: 'shape',
    transform: { x: 10, y: 20, scaleX: 1, scaleY: 1, rotationDeg: 0, opacity: 1, crop },
    ...(animations === undefined ? {} : { animations }),
  } as VisualObjectV1;
}

function patch(over: Partial<TransformPatch> = {}): TransformPatch {
  return { x: 10, y: 20, scaleX: 1, scaleY: 1, rotationDeg: 0, ...over };
}

describe('writing a gesture into an object', () => {
  it('without a stopwatch: static values, no curve is ever created', () => {
    const next = applyTransformPatch(shape(), patch({ x: 40, rotationDeg: 15 }), HALF);
    expect(next.transform).toEqual({ ...shape().transform, x: 40, rotationDeg: 15 });
    expect(next.animations).toBeUndefined();
  });

  it('with the stopwatch on: a new keyframe at the playhead, the static value untouched', () => {
    const object = shape({ x: X_CURVE });
    expect(localValuesAt(object, HALF).x).toBe(200);
    const next = applyTransformPatch(object, patch({ x: 250 }), HALF);
    expect(next.transform.x).toBe(10);
    expect(next.animations!.x!.keyframes).toEqual([
      { timeUs: 0, value: 100, interpolation: 'linear' },
      // The new key takes the interpolation of the key before it.
      { timeUs: HALF, value: 250, interpolation: 'linear' },
      { timeUs: 1_000_000, value: 300, interpolation: 'hold' },
    ]);
    expect(resolveObjectTransform(next, HALF).x).toBe(250);
    // Only the channel that changed is touched.
    expect(next.animations).not.toHaveProperty('y');
  });

  it('a key already at the playhead gets the new value and keeps its interpolation', () => {
    const bezier = { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.9 };
    const curve: AnimationCurveV1 = {
      keyframes: [
        { timeUs: 0, value: 1, interpolation: 'linear' },
        { timeUs: HALF, value: 1.5, interpolation: 'bezier', bezier },
        { timeUs: 1_000_000, value: 2, interpolation: 'linear' },
      ],
    };
    const object = shape({ scaleX: curve });
    const next = applyTransformPatch(object, patch({ scaleX: 1.8 }), HALF);
    expect(next.animations!.scaleX!.keyframes).toHaveLength(3);
    expect(next.animations!.scaleX!.keyframes[1]).toEqual({
      timeUs: HALF,
      value: 1.8,
      interpolation: 'bezier',
      bezier,
    });
    expect(next.transform.scaleX).toBe(1);
  });

  it('before the first key a new key copies the first key; the time is whole microseconds', () => {
    const curve: AnimationCurveV1 = {
      keyframes: [{ timeUs: 400_000, value: 0, interpolation: 'hold' }],
    };
    expect(gestureKeyframe(curve, 100_000, 45)).toEqual({
      timeUs: 100_000,
      value: 45,
      interpolation: 'hold',
    });
    expect(keyframeTime(123.6)).toBe(124);
    expect(keyframeTime(-50)).toBe(0);
    const next = applyTransformPatch(
      shape({ rotationDeg: curve }),
      patch({ rotationDeg: 45 }),
      99.6,
    );
    expect(next.animations!.rotationDeg!.keyframes.map((key) => key.timeUs)).toEqual([
      100, 400_000,
    ]);
  });

  it('an unchanged keyframed value adds no key; a key is never removed', () => {
    const object = shape({ x: X_CURVE });
    const same = applyTransformPatch(object, patch({ x: 200 }), HALF);
    expect(same.animations!.x).toBe(X_CURVE);
    const moved = applyTransformPatch(object, patch({ x: 0 }), 1_000_000);
    expect(moved.animations!.x!.keyframes).toHaveLength(2);
    expect(moved.animations!.x!.keyframes[1]).toEqual({
      timeUs: 1_000_000,
      value: 0,
      interpolation: 'hold',
    });
  });

  it('without a playhead every value is static (the drawn values while typing)', () => {
    const next = applyTransformPatch(shape({ x: X_CURVE }), patch({ x: 250 }));
    expect(next.transform.x).toBe(250);
    expect(next.animations!.x).toBe(X_CURVE);
  });

  it('the anchor is written, and dropped again when it is back at the centre', () => {
    const anchored = applyTransformPatch(shape(), patch({ anchorX: 0, anchorY: 0.25 }), HALF);
    expect(anchored.transform.anchorX).toBe(0);
    expect(anchored.transform.anchorY).toBe(0.25);
    const centred = applyTransformPatch(anchored, patch({ anchorX: 0.5, anchorY: 0.5 }), HALF);
    expect('anchorX' in centred.transform).toBe(false);
    expect('anchorY' in centred.transform).toBe(false);
    const kept = applyTransformPatch(anchored, patch({ x: 1 }), HALF);
    expect(kept.transform.anchorX).toBe(0);
  });
});

function storage(seed: Readonly<Record<string, string>> = {}) {
  const values = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function targetFor(object: VisualObjectV1, timeUs: number): MonitorTransformTarget {
  const local = localValuesAt(object, timeUs);
  const transform: Transform2D = {
    translateX: local.x,
    translateY: local.y,
    scaleX: local.scaleX,
    scaleY: local.scaleY,
  };
  return {
    nodeId: object.id,
    clipId: `clip-${object.id}`,
    objectId: object.id,
    geometry: boxGeometry(
      nodeBoundsFromBox(object.id, transform, { x: 0, y: 0, width: 100, height: 100 }),
      transform,
    ),
    local,
    blocked: {},
  };
}

describe('a drag on a keyframed value is one undo step that writes one keyframe', () => {
  it('the release keys x and y at the playhead; one undo takes the whole drag back', () => {
    const editor = new EditorSession(
      storage({ [DUAL_LENS_FLAG_KEY]: 'on' }),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const objectId = 'outro-shape';
    const original = editor.visualProject.visualObjects[objectId]!;
    // Setup (its own step): the stopwatch on Position X, keys at 0 s and 1 s.
    const keyed: JoyProjectV1 = {
      ...editor.visualProject,
      visualObjects: {
        ...editor.visualProject.visualObjects,
        [objectId]: {
          ...original,
          animations: {
            x: {
              keyframes: [
                { timeUs: 0, value: original.transform.x, interpolation: 'linear' },
                { timeUs: 1_000_000, value: original.transform.x + 200, interpolation: 'linear' },
              ],
            },
          },
        },
      },
    };
    editor.dispatchCompound('Keyframe x', { document: keyed });
    const before = editor.visualProject;
    const object = before.visualObjects[objectId]!;
    const target = targetFor(object, HALF);
    expect(target.local.x).toBe(original.transform.x + 100);

    let commits = 0;
    const host = {
      preview: () => undefined,
      cancel: () => undefined,
      // As the Monitor does: one compound step with the playhead's keyframes.
      commit: (label: string, patches: TransformPatches) => {
        commits += 1;
        editor.dispatchCompound(label, {
          document: withTransformPatches(editor.visualProject, patches, HALF),
        });
      },
    } satisfies MonitorTransformHost;
    const drag = startTransformDrag([target], { kind: 'move' }, { x: 0, y: 0 }, host);
    if ('blocked' in drag) throw new Error(`blocked: ${drag.blocked}`);
    for (let step = 1; step <= 10; step += 1)
      drag.update({ x: step * 3, y: step }, { shift: false, alt: false });
    drag.end(true);
    expect(commits).toBe(1);

    const after = editor.visualProject;
    expect(validateJoyProjectV1(after)).toEqual([]);
    const moved = after.visualObjects[objectId]!;
    // x has a stopwatch: a key at the playhead; y has none: a static value.
    expect(moved.animations!.x!.keyframes.map((key) => [key.timeUs, key.value])).toEqual([
      [0, original.transform.x],
      [HALF, original.transform.x + 130],
      [1_000_000, original.transform.x + 200],
    ]);
    expect(moved.transform.x).toBe(original.transform.x);
    expect(moved.transform.y).toBe(original.transform.y + 10);
    expect(moved.animations).not.toHaveProperty('y');

    editor.undo();
    expect(editor.visualProject.visualObjects[objectId]).toEqual(object);
    expect(editor.visualProject.visualObjects[objectId]!.animations!.x!.keyframes).toHaveLength(2);
  });
});
