import { describe, expect, it } from 'vitest';
import { emptyScene3D, IDENTITY_3D_TRANSFORM } from './scene.js';

describe('scene3d document', () => {
  it('creates a stable JSON-round-trippable empty document', () => {
    const scene = emptyScene3D('scene-1', 'Hero');
    expect(JSON.parse(JSON.stringify(scene))).toEqual(scene);
    expect(scene.durationUs).toBe(5_000_000);
    expect(IDENTITY_3D_TRANSFORM.scale).toEqual({ x: 1, y: 1, z: 1 });
  });
});
