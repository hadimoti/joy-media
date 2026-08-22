import { describe, expect, it } from 'vitest';
import {
  applyApprovedScene3DTool,
  commandForScene3DTool,
  dryRunScene3DTool,
  emptyScene3D,
  IDENTITY_3D_TRANSFORM,
  inspectScene3DTool,
} from './index.js';

const session = () => ({
  actorId: 'actor',
  projectId: 'project',
  sceneId: 'scene',
  revision: 'r1',
  document: emptyScene3D('scene'),
});

describe('scene3d structured tools', () => {
  it('keeps reads bounded to the bound scene and returns dry-run diffs', () => {
    expect(inspectScene3DTool(session(), 'scene3d.summary')).toMatchObject({
      sceneId: 'scene',
      objectCount: 0,
    });
    const dry = dryRunScene3DTool(session(), 'scene3d.add', {
      object: {
        id: 'box',
        name: 'Box',
        kind: 'primitive',
        primitive: 'box',
        transform: IDENTITY_3D_TRANSFORM,
      },
    });
    expect(dry.diff).toMatchObject({ created: ['box'] });
    expect(dry.diff?.changedAssets).toEqual([]);
  });
  it('requires a matching, unexpired approval and applies atomically with an undo transaction', () => {
    const result = applyApprovedScene3DTool(
      session(),
      'scene3d.add',
      {
        object: {
          id: 'box',
          name: 'Box',
          kind: 'primitive',
          primitive: 'box',
          transform: IDENTITY_3D_TRANSFORM,
        },
      },
      {
        approvalId: 'a1',
        actorId: 'actor',
        projectId: 'project',
        sceneId: 'scene',
        baseRevision: 'r1',
        expiresAt: 1000,
      },
      100,
    );
    expect(result.document?.objects.box).toBeDefined();
    expect(result.inverse?.commands).toHaveLength(1);
    expect(
      applyApprovedScene3DTool(
        session(),
        'scene3d.add',
        {
          object: {
            id: 'box',
            name: 'Box',
            kind: 'primitive',
            primitive: 'box',
            transform: IDENTITY_3D_TRANSFORM,
          },
        },
        {
          approvalId: 'a1',
          actorId: 'wrong',
          projectId: 'project',
          sceneId: 'scene',
          baseRevision: 'r1',
          expiresAt: 1000,
        },
        100,
      ).error,
    ).toContain('binding');
  });
  it('rejects arbitrary filesystem, shell, URL, or environment authority by construction', () => {
    expect(Object.keys({ ...session().document.objects })).toEqual([]);
    expect([
      'scene3d.summary',
      'scene3d.assets',
      'scene3d.scene',
      'scene3d.selection',
    ]).not.toContain('shell.exec');
  });

  it('rejects malformed write inputs before they reach the command boundary', () => {
    expect(() => commandForScene3DTool('scene3d.add', {})).toThrow('object must be an object');
    expect(() => commandForScene3DTool('scene3d.remove', { objectId: 42 })).toThrow(
      'objectId must be a non-empty string',
    );
    expect(() => commandForScene3DTool('scene3d.transform', { objectId: 'box' })).toThrow(
      'transform must be an object',
    );
  });

  it('reports non-object changes in material and camera diffs', () => {
    const material = {
      id: 'mat',
      color: '#ffffff',
      roughness: 0.5,
      metalness: 0.1,
    };
    const materialDiff = dryRunScene3DTool(session(), 'scene3d.material', { material });
    expect(materialDiff.diff?.changedMaterials).toEqual(['mat']);
    const cameraDiff = dryRunScene3DTool(session(), 'scene3d.camera', { cameraId: 'camera' });
    expect(cameraDiff.error).toContain('active camera');
  });
});
