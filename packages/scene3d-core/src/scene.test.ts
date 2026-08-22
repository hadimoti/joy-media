import { describe, expect, it } from 'vitest';
import { emptyScene3D, IDENTITY_3D_TRANSFORM, migrateScene3DDocument, parseScene3DDocument } from './scene.js';

describe('scene3d document', () => {
  it('creates a stable JSON-round-trippable empty document', () => {
    const scene = emptyScene3D('scene-1', 'Hero');
    expect(JSON.parse(JSON.stringify(scene))).toEqual(scene);
    expect(scene.durationUs).toBe(5_000_000);
    expect(IDENTITY_3D_TRANSFORM.scale).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('migrates the v0 spike shape before validation', () => {
    const migrated = migrateScene3DDocument({
      schemaVersion: 0,
      sceneId: 'legacy-scene',
      title: 'Legacy',
      objects: { root: { kind: 'empty', transform: {} } },
    });
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.id).toBe('legacy-scene');
    expect(migrated.objects.root?.transform).toEqual(IDENTITY_3D_TRANSFORM);
    expect(parseScene3DDocument(JSON.stringify(migrated))).toEqual(migrated);
  });
});
