import { describe, expect, it } from 'vitest';
import type { VisualObjectTransformV1, VisualObjectV1 } from '@joy-media/project-schema';
import {
  resolveWorldTransform,
  resolveWorldTransformWithExpressions,
} from '@joy-media/motion-core';
import {
  CameraSceneError,
  resolveCameraParams,
  resolveObjectTransformThroughCamera,
  resolveObjectTransformThroughCameraWithExpressions,
  worldDepth,
} from './scene.js';

const baseTransform: VisualObjectTransformV1 = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  opacity: 1,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

const compHeight = 1080;

function scene(): Record<string, VisualObjectV1> {
  return {
    rig: {
      id: 'rig',
      kind: 'null',
      transform: { ...baseTransform, positionZ: -50 },
    },
    'cam-1': {
      id: 'cam-1',
      kind: 'camera',
      transform: { ...baseTransform, positionZ: 0 },
      parentId: 'rig',
      camera: { fieldOfViewDeg: 54 },
    },
    near: { id: 'near', kind: 'text', transform: { ...baseTransform, x: 100, positionZ: 200 } },
    far: { id: 'far', kind: 'text', transform: { ...baseTransform, x: 100, positionZ: 2000 } },
  };
}

describe('worldDepth', () => {
  it('sums positionZ down the parent chain', () => {
    const objects = scene();
    expect(worldDepth('cam-1', objects, 0)).toBeCloseTo(-50, 6); // rig(-50) + cam(0)
    expect(worldDepth('near', objects, 0)).toBeCloseTo(200, 6); // no parent
  });

  it('defaults absent positionZ to 0', () => {
    const objects = { leaf: { id: 'leaf', kind: 'text' as const, transform: baseTransform } };
    expect(worldDepth('leaf', objects, 0)).toBe(0);
  });

  it('throws CameraSceneError for an unknown object', () => {
    expect(() => worldDepth('ghost', {}, 0)).toThrow(CameraSceneError);
  });
});

describe('resolveCameraParams', () => {
  it('resolves world position/roll/FOV, composing the camera under its parent rig', () => {
    const objects = scene();
    const params = resolveCameraParams('cam-1', objects, 0);
    expect(params.z).toBeCloseTo(-50, 6);
    expect(params.fieldOfViewDeg).toBe(54);
    expect(params.x).toBe(0);
    expect(params.rollDeg).toBe(0);
  });

  it('rejects a non-camera object and a camera missing params', () => {
    const objects = scene();
    expect(() => resolveCameraParams('near', objects, 0)).toThrow(CameraSceneError);
    const cameraWithoutParams: VisualObjectV1 = {
      id: 'cam-1',
      kind: 'camera',
      transform: objects['cam-1']!.transform,
      parentId: 'rig',
    };
    const broken = { ...objects, 'cam-1': cameraWithoutParams };
    expect(() => resolveCameraParams('cam-1', broken, 0)).toThrow(CameraSceneError);
  });
});

describe('resolveObjectTransformThroughCamera', () => {
  it('with no cameraId, is identical to plain parent-chain world resolution (no-regression guarantee)', () => {
    const objects = scene();
    const plain = resolveWorldTransform('near', objects, 0);
    const throughUndefinedCamera = resolveObjectTransformThroughCamera(
      'near',
      undefined,
      objects,
      0,
      compHeight,
    );
    expect(throughUndefinedCamera).toEqual(plain);
  });

  it('projects a nearer layer with more parallax shift than a farther one under the same camera', () => {
    const objects = scene();
    const near = resolveObjectTransformThroughCamera('near', 'cam-1', objects, 0, compHeight);
    const far = resolveObjectTransformThroughCamera('far', 'cam-1', objects, 0, compHeight);
    // Same world x offset (100) from the camera, but different depth: the nearer
    // layer must be foreshortened less (bigger |x|) than the farther one.
    expect(Math.abs(near.x)).toBeGreaterThan(Math.abs(far.x));
    expect(near.scaleX).toBeGreaterThan(far.scaleX);
  });
});

describe('resolveObjectTransformThroughCameraWithExpressions (WP-10.5 combined evidence)', () => {
  function expressionScene(): Record<string, VisualObjectV1> {
    return {
      rig: { id: 'rig', kind: 'null', transform: { ...baseTransform, positionZ: 0 } },
      'cam-1': {
        id: 'cam-1',
        kind: 'camera',
        // Expression-driven dolly: the camera's own depth moves over time.
        transform: { ...baseTransform, positionZ: 0 },
        expressions: { positionZ: '-500 + sin(time) * 200' },
        parentId: 'rig',
        camera: { fieldOfViewDeg: 54 },
      },
      near: {
        id: 'near',
        kind: 'text',
        transform: { ...baseTransform, x: 100, positionZ: 200, opacity: 1 },
        // The layer being projected also carries its own expression.
        expressions: { opacity: 'clamp(time, 0, 1)' },
      },
      far: { id: 'far', kind: 'text', transform: { ...baseTransform, x: 100, positionZ: 2000 } },
    };
  }

  it('with no cameraId, is identical to resolveWorldTransformWithExpressions alone (no-regression guarantee)', () => {
    const objects = expressionScene();
    const plain = resolveWorldTransformWithExpressions('near', objects, 0);
    const throughUndefinedCamera = resolveObjectTransformThroughCameraWithExpressions(
      'near',
      undefined,
      objects,
      0,
      compHeight,
    );
    expect(throughUndefinedCamera).toEqual(plain);
  });

  it('honors an expression-driven camera dolly together with a layer expression, simultaneously', () => {
    const objects = expressionScene();
    // At time=0: opacity expression clamp(0,0,1) = 0.
    const atZero = resolveObjectTransformThroughCameraWithExpressions(
      'near',
      'cam-1',
      objects,
      0,
      compHeight,
    );
    expect(atZero.transform.opacity).toBe(0);
    expect(atZero.diagnostics).toEqual([]);

    // At time=0.5s: opacity expression clamp(0.5,0,1) = 0.5, and the dolly has
    // moved (sin(0.5) != sin(0)), so scale differs from time=0 too — both the
    // layer's own expression AND the camera's expression are live simultaneously.
    const atHalf = resolveObjectTransformThroughCameraWithExpressions(
      'near',
      'cam-1',
      objects,
      500_000,
      compHeight,
    );
    expect(atHalf.transform.opacity).toBeCloseTo(0.5, 6);
    expect(atHalf.transform.scaleX).not.toBeCloseTo(atZero.transform.scaleX, 6);
    expect(atHalf.diagnostics).toEqual([]);
  });

  it('still produces parallax (dolly-zoom) across depth-offset layers with an expression-driven camera', () => {
    const objects = expressionScene();
    const near = resolveObjectTransformThroughCameraWithExpressions(
      'near',
      'cam-1',
      objects,
      500_000,
      compHeight,
    );
    const far = resolveObjectTransformThroughCameraWithExpressions(
      'far',
      'cam-1',
      objects,
      500_000,
      compHeight,
    );
    expect(near.transform.scaleX).toBeGreaterThan(far.transform.scaleX);
  });

  it('aggregates diagnostics from the object, its ancestors, and the camera chain together', () => {
    const objects = expressionScene();
    const broken: Record<string, VisualObjectV1> = {
      ...objects,
      near: { ...objects['near']!, expressions: { opacity: 'mystery' } },
      'cam-1': { ...objects['cam-1']!, expressions: { positionZ: 'also_mystery' } },
    };
    const result = resolveObjectTransformThroughCameraWithExpressions(
      'near',
      'cam-1',
      broken,
      0,
      compHeight,
    );
    const objectIds = result.diagnostics.map((diagnostic) => diagnostic.objectId);
    expect(objectIds).toContain('near');
    expect(objectIds).toContain('cam-1');
  });
});
