import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisualObjectV1 } from '@joy-media/project-schema';

const mockState = vi.hoisted(() => ({
  captures: [] as Array<{
    readonly instanceId: string;
    readonly width: number;
    readonly height: number;
  }>,
  destroyed: [] as string[],
}));

vi.mock('@joy-media/html-scene-runtime/browser', () => ({
  createScenePreviewHost: vi.fn(
    (options: { readonly instanceId: string }) =>
      ({
        instanceId: options.instanceId,
        ready: Promise.resolve(),
        update: vi.fn(),
        capture: vi.fn(async (width: number, height: number) => {
          mockState.captures.push({ instanceId: options.instanceId, width, height });
          return { width, height, data: new Uint8ClampedArray(width * height * 4) };
        }),
        destroy: vi.fn(() => mockState.destroyed.push(options.instanceId)),
      }) as unknown,
  ),
  defaultVariablesForScene: vi.fn(() => ({ title: 'JOY' })),
  findFirstPartyScene: vi.fn((packageId: string) =>
    packageId === 'scene.package'
      ? {
          manifest: { viewport: { width: 400, height: 300 } },
          source: '',
        }
      : undefined,
  ),
  viewportForScene: vi.fn(() => ({ width: 400, height: 300 })),
}));

import { HtmlSceneSurfaceCache } from './html-scene-surfaces.js';

describe('HtmlSceneSurfaceCache', () => {
  beforeEach(() => {
    mockState.captures.length = 0;
    mockState.destroyed.length = 0;
  });

  it('keeps Monitor captures quarter-scale but captures delivery frames at full scene size', async () => {
    const cache = new HtmlSceneSurfaceCache();
    const objects = { scene: htmlScene('scene') };

    const preview = await cache.sync(objects, 250_000);
    const delivery = await cache.captureFull(objects, 250_000);

    expect(preview.get('scene')).toMatchObject({ width: 100, height: 75 });
    expect(delivery.get('scene')).toMatchObject({ width: 400, height: 300 });
    expect(cache.bitmaps().get('scene')).toMatchObject({ width: 100, height: 75 });
    expect(mockState.captures).toEqual([
      { instanceId: 'scene', width: 100, height: 75 },
      { instanceId: 'export-scene', width: 400, height: 300 },
    ]);
    expect(mockState.destroyed).toEqual(['export-scene']);

    cache.destroy();
  });
});

function htmlScene(id: string): VisualObjectV1 {
  return {
    id,
    kind: 'html-scene',
    scenePackageId: 'scene.package',
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    },
  };
}
