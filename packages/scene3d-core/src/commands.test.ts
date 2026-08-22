import { describe, expect, it } from 'vitest';
import { applyScene3DTransaction } from './commands.js';
import { emptyScene3D, IDENTITY_3D_TRANSFORM, type Scene3DObject } from './scene.js';

const model: Scene3DObject = {
  id: 'model',
  name: 'Model',
  kind: 'model',
  assetId: 'asset',
  transform: IDENTITY_3D_TRANSFORM,
};
const base = {
  ...emptyScene3D('s'),
  assets: {
    asset: { id: 'asset', kind: 'model' as const, mimeType: 'model/gltf-binary' as const },
  },
};

describe('scene3d commands', () => {
  it('applies multiple commands atomically and returns inverses', () => {
    const result = applyScene3DTransaction(base, {
      label: 'Add model',
      commands: [
        { type: 'object.add', payload: { object: model } },
        {
          type: 'scene.setEnvironment',
          payload: { environment: { backgroundColor: '#ffffff', ambientIntensity: 0.8 } },
        },
      ],
    });
    expect(result.document.objects.model).toEqual(model);
    const restored = applyScene3DTransaction(result.document, result.record.inverses).document;
    expect(restored).toEqual(base);
  });

  it('rejects deleting an active camera or a parent with children', () => {
    const camera: Scene3DObject = {
      id: 'camera',
      name: 'Camera',
      kind: 'camera',
      transform: IDENTITY_3D_TRANSFORM,
      camera: { fieldOfViewDeg: 50, near: 0.1, far: 100 },
    };
    const parent: Scene3DObject = {
      id: 'parent',
      name: 'Parent',
      kind: 'empty',
      transform: IDENTITY_3D_TRANSFORM,
    };
    const child: Scene3DObject = {
      id: 'child',
      name: 'Child',
      kind: 'empty',
      parentId: 'parent',
      transform: IDENTITY_3D_TRANSFORM,
    };
    const scene = { ...base, objects: { camera, parent, child }, activeCameraId: 'camera' };
    expect(() =>
      applyScene3DTransaction(scene, {
        label: 'remove',
        commands: [{ type: 'object.remove', payload: { objectId: 'camera' } }],
      }),
    ).toThrow('active camera');
    expect(() =>
      applyScene3DTransaction(scene, {
        label: 'remove',
        commands: [{ type: 'object.remove', payload: { objectId: 'parent' } }],
      }),
    ).toThrow('children');
  });

  it('does not partially apply when a later command fails', () => {
    expect(() =>
      applyScene3DTransaction(base, {
        label: 'atomic',
        commands: [
          { type: 'object.add', payload: { object: model } },
          {
            type: 'object.setTransform',
            payload: { objectId: 'missing', transform: IDENTITY_3D_TRANSFORM },
          },
        ],
      }),
    ).toThrow('missing');
    expect(base.objects).toEqual({});
  });
});
