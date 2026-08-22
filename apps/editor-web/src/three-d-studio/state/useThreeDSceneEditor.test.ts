import { describe, expect, it } from 'vitest';
import {
  applyScene3DTransaction,
  emptyScene3D,
  IDENTITY_3D_TRANSFORM,
} from '@joy-media/scene3d-core';

describe('3D studio command boundary', () => {
  it('keeps a compound edit atomic and invertible', () => {
    const scene = emptyScene3D('scene-1');
    const object = {
      id: 'box',
      name: 'Box',
      kind: 'primitive' as const,
      primitive: 'box' as const,
      transform: IDENTITY_3D_TRANSFORM,
    };
    const applied = applyScene3DTransaction(scene, {
      label: 'Add box',
      commands: [{ type: 'object.add', payload: { object } }],
    });
    expect(applied.document.objects.box).toEqual(object);
    expect(applyScene3DTransaction(applied.document, applied.record.inverses).document).toEqual(
      scene,
    );
  });

  it('rejects a reparenting cycle at the durable validation boundary', () => {
    const scene = emptyScene3D('scene-1');
    const result = applyScene3DTransaction(scene, {
      label: 'Bad hierarchy',
      commands: [
        {
          type: 'object.add',
          payload: {
            object: { id: 'a', name: 'A', kind: 'empty', transform: IDENTITY_3D_TRANSFORM },
          },
        },
        {
          type: 'object.add',
          payload: {
            object: {
              id: 'b',
              name: 'B',
              kind: 'empty',
              parentId: 'a',
              transform: IDENTITY_3D_TRANSFORM,
            },
          },
        },
      ],
    });
    expect(() =>
      applyScene3DTransaction(result.document, {
        label: 'cycle',
        commands: [{ type: 'object.setParent', payload: { objectId: 'a', parentId: 'b' } }],
      }),
    ).toThrow('cycle');
  });
});
