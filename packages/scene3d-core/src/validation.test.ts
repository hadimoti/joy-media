import { describe, expect, it } from 'vitest';
import { emptyScene3D, IDENTITY_3D_TRANSFORM, type Scene3DObject } from './scene.js';
import { validateScene3DDocument } from './validation.js';

const object = (overrides: Partial<Scene3DObject> = {}): Scene3DObject => ({
  id: 'model',
  name: 'Model',
  kind: 'model',
  assetId: 'asset',
  transform: IDENTITY_3D_TRANSFORM,
  ...overrides,
});

describe('scene3d validation', () => {
  it('rejects missing model assets and invalid transforms', () => {
    const scene = {
      ...emptyScene3D('s'),
      objects: {
        model: object({ transform: { ...IDENTITY_3D_TRANSFORM, scale: { x: 0, y: 1, z: 1 } } }),
      },
    };
    const errors = validateScene3DDocument(scene);
    expect(errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(['missing-asset', 'transform-scale']),
    );
  });

  it('rejects hierarchy cycles, invalid active camera, and missing material', () => {
    const scene = {
      ...emptyScene3D('s'),
      objects: {
        a: object({ id: 'a', parentId: 'b', materialId: 'missing' }),
        b: object({ id: 'b', parentId: 'a' }),
      },
      activeCameraId: 'a',
    };
    const codes = validateScene3DDocument(scene).map((error) => error.code);
    expect(codes).toEqual(expect.arrayContaining(['cycle', 'active-camera', 'missing-material']));
  });
});
