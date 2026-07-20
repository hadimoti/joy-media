import { describe, expect, it } from 'vitest';
import type { VisualObjectV1 } from '@joy-media/project-schema';
import {
  evaluateAnimatedTransform,
  evaluateCameraExpressionTransform,
  evaluateCameraTransform,
  evaluateExpressionTransform,
  evaluateStaticProperty,
  queryActiveIntervals,
} from './properties.js';

describe('active intervals and static properties', () => {
  it('uses end-exclusive intervals and stable timeline order', () => {
    expect(
      queryActiveIntervals(
        [
          { id: 'later', startUs: 0, durationUs: 1_000, order: 2 },
          { id: 'first', startUs: 0, durationUs: 1_000, order: 1 },
          { id: 'ended', startUs: 0, durationUs: 1_000, order: 0 },
        ],
        1_000,
      ),
    ).toEqual([]);
    expect(
      queryActiveIntervals(
        [
          { id: 'later', startUs: 0, durationUs: 1_000, order: 2 },
          { id: 'first', startUs: 0, durationUs: 1_000, order: 1 },
        ],
        999,
      ).map((entity) => entity.id),
    ).toEqual(['first', 'later']);
  });

  it('evaluates static properties without renderer state', () => {
    expect(evaluateStaticProperty({ value: 0.75 })).toBe(0.75);
    expect(evaluateStaticProperty({ value: 0.75, enabled: false })).toBeUndefined();
  });

  it('resolves an animated transform, sampling only keyframed channels', () => {
    const object: VisualObjectV1 = {
      id: 'obj-1',
      kind: 'text',
      transform: {
        x: 0,
        y: 42,
        scaleX: 1,
        scaleY: 1,
        rotationDeg: 0,
        opacity: 1,
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
      animations: {
        x: {
          keyframes: [
            { timeUs: 0, value: 0, interpolation: 'linear' },
            { timeUs: 1_000_000, value: 200, interpolation: 'linear' },
          ],
        },
      },
    };
    expect(evaluateAnimatedTransform(object, 500_000).x).toBeCloseTo(100, 6);
    expect(evaluateAnimatedTransform(object, 500_000).y).toBe(42);
    // No animation → the static transform passes through by reference.
    const staticObject: VisualObjectV1 = { id: 'o', kind: 'shape', transform: object.transform };
    expect(evaluateAnimatedTransform(staticObject, 500_000)).toBe(object.transform);
  });

  it('evaluateCameraTransform: no cameraId reproduces plain parenting (no-camera regression guard)', () => {
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      'obj-1': {
        id: 'obj-1',
        kind: 'text',
        transform: {
          x: 10,
          y: 20,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
    };
    expect(evaluateCameraTransform('obj-1', undefined, objects, 0, 1080)).toEqual(
      evaluateAnimatedTransform(objects['obj-1']!, 0),
    );
  });

  it('evaluateCameraTransform: projects depth-offset layers through a 2.5D camera', () => {
    const baseTransform = {
      x: 100,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      'cam-1': {
        id: 'cam-1',
        kind: 'camera',
        transform: { ...baseTransform, x: 0, positionZ: 0 },
        camera: { fieldOfViewDeg: 54 },
      },
      near: { id: 'near', kind: 'text', transform: { ...baseTransform, positionZ: 500 } },
    };
    const projected = evaluateCameraTransform('near', 'cam-1', objects, 0, 1080);
    expect(projected.x).not.toBe(100); // camera projection actually altered the layer
    expect(Number.isFinite(projected.x)).toBe(true);
    expect(projected.scaleX).toBeGreaterThan(0);
  });

  it('evaluateExpressionTransform: a channel expression overrides the static value', () => {
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      'obj-1': {
        id: 'obj-1',
        kind: 'text',
        transform: {
          x: 10,
          y: 20,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
        expressions: { x: 'time * 100' },
      },
    };
    const result = evaluateExpressionTransform('obj-1', objects, 2_000_000);
    expect(result.transform.x).toBeCloseTo(200, 6);
    expect(result.diagnostics).toEqual([]);
  });

  it('evaluateExpressionTransform: falls back and reports a diagnostic on a bad expression', () => {
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      'obj-1': {
        id: 'obj-1',
        kind: 'text',
        transform: {
          x: 10,
          y: 20,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
        expressions: { x: 'not_a_thing' },
      },
    };
    const result = evaluateExpressionTransform('obj-1', objects, 0);
    expect(result.transform.x).toBe(10); // graceful fallback, never a crash
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.property).toBe('x');
  });

  it('evaluateCameraExpressionTransform: composes an expression-driven camera dolly with a layer expression (WP-10.5)', () => {
    const baseTransform = {
      x: 100,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      'cam-1': {
        id: 'cam-1',
        kind: 'camera',
        transform: { ...baseTransform, x: 0, positionZ: 0 },
        expressions: { positionZ: '-500 + sin(time) * 200' },
        camera: { fieldOfViewDeg: 54 },
      },
      layer: {
        id: 'layer',
        kind: 'text',
        transform: { ...baseTransform, positionZ: 200, opacity: 1 },
        expressions: { opacity: 'clamp(time, 0, 1)' },
      },
    };
    const atHalfSecond = evaluateCameraExpressionTransform(
      'layer',
      'cam-1',
      objects,
      500_000,
      1080,
    );
    expect(atHalfSecond.transform.opacity).toBeCloseTo(0.5, 6);
    expect(Number.isFinite(atHalfSecond.transform.x)).toBe(true);
    expect(atHalfSecond.transform.scaleX).toBeGreaterThan(0);
    expect(atHalfSecond.diagnostics).toEqual([]);
  });

  it('evaluateCameraExpressionTransform: no cameraId reproduces evaluateExpressionTransform exactly (no-regression guard)', () => {
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      'obj-1': {
        id: 'obj-1',
        kind: 'text',
        transform: {
          x: 10,
          y: 20,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
        expressions: { x: 'time * 100' },
      },
    };
    expect(evaluateCameraExpressionTransform('obj-1', undefined, objects, 2_000_000, 1080)).toEqual(
      evaluateExpressionTransform('obj-1', objects, 2_000_000),
    );
  });
});
