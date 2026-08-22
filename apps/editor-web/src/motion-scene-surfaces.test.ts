import { describe, expect, it } from 'vitest';
import { MotionSceneSurfaceCache } from './motion-scene-surfaces.js';

describe('MotionSceneSurfaceCache', () => {
  it('records explicit evidence instead of painting an unresolved scene as success', async () => {
    const cache = new MotionSceneSurfaceCache({
      getItem: () => null,
      setItem: () => undefined,
    });

    await cache.sync([
      {
        requirementId: 'motion-scene:object-a',
        objectId: 'object-a',
        assetId: 'motion-scene:missing-doc',
        motionSceneId: 'missing-doc',
        timeUs: 0,
      },
    ]);

    expect(cache.bitmaps().has('object-a')).toBe(false);
    expect(cache.diagnostics()).toEqual([
      {
        objectId: 'object-a',
        motionSceneId: 'missing-doc',
        code: 'MOTION_SCENE_NOT_PUBLISHED',
        message: 'Motion scene missing-doc is not published and cannot be previewed',
      },
    ]);
  });
});
