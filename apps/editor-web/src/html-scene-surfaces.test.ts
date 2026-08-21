import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  captures: [] as Array<{
    readonly instanceId: string;
    readonly width: number;
    readonly height: number;
  }>,
  destroyed: [] as string[],
  updates: [] as Array<{ readonly instanceId: string; readonly timeUs: number }>,
}));

vi.mock('@joy-media/html-scene-runtime/browser', () => ({
  createScenePreviewHost: vi.fn(
    (options: { readonly instanceId: string }) =>
      ({
        instanceId: options.instanceId,
        ready: Promise.resolve(),
        update: vi.fn((timeUs: number) => {
          mockState.updates.push({ instanceId: options.instanceId, timeUs });
        }),
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

import * as sceneSurfaces from './html-scene-surfaces.js';

describe('HtmlSceneSurfaceCache', () => {
  beforeEach(() => {
    mockState.captures.length = 0;
    mockState.destroyed.length = 0;
    mockState.updates.length = 0;
  });

  it('keeps Monitor captures quarter-scale but captures delivery frames at full scene size', async () => {
    const cache = new sceneSurfaces.HtmlSceneSurfaceCache();
    const targets = [
      {
        requirementId: 'html-scene:scene',
        objectId: 'scene',
        assetId: 'html-scene:scene.package',
        scenePackageId: 'scene.package',
        timeUs: 250_000,
      },
    ] as const;

    const preview = await cache.sync(targets);
    const delivery = await cache.captureFull(targets);

    expect(preview.get('scene')).toMatchObject({ width: 100, height: 75 });
    expect(delivery.get('scene')).toMatchObject({ width: 400, height: 300 });
    expect(cache.bitmaps().get('scene')).toMatchObject({ width: 100, height: 75 });
    expect(mockState.captures).toEqual([
      { instanceId: 'scene', width: 100, height: 75 },
      { instanceId: 'export-html-scene:scene', width: 400, height: 300 },
    ]);
    expect(mockState.updates).toEqual([
      { instanceId: 'scene', timeUs: 250_000 },
      { instanceId: 'export-html-scene:scene', timeUs: 250_000 },
    ]);
    expect(mockState.destroyed).toEqual(['export-html-scene:scene']);

    cache.destroy();
  });

  it('captures delivery frames lazily instead of preloading every export frame', async () => {
    expect(typeof (sceneSurfaces as Record<string, unknown>).createDeliverySceneFrameSource).toBe(
      'function',
    );

    const calls: number[] = [];
    const cache = {
      captureFull: vi.fn(
        async (targets: ReadonlyArray<{ readonly objectId: string; readonly timeUs: number }>) => {
          const timeUs = targets[0]?.timeUs ?? 0;
          calls.push(timeUs);
          return new Map([
            [
              'scene',
              {
                width: 400,
                height: 300,
                data: new Uint8ClampedArray([Math.round(timeUs / 1_000)]),
              },
            ],
          ]);
        },
      ),
      destroy: vi.fn(),
    };
    const source = (
      sceneSurfaces as typeof sceneSurfaces & {
        createDeliverySceneFrameSource: (
          cache: Pick<sceneSurfaces.HtmlSceneSurfaceCache, 'captureFull' | 'destroy'>,
        ) => {
          captureInto: (
            bitmaps: Map<string, { width: number; height: number; data: Uint8ClampedArray }>,
            captureTargets: ReadonlyArray<{
              readonly requirementId: string;
              readonly objectId: string;
              readonly assetId: string;
              readonly scenePackageId: string;
              readonly timeUs: number;
            }>,
          ) => Promise<void>;
          destroy: () => void;
        };
      }
    ).createDeliverySceneFrameSource(
      cache as unknown as Pick<sceneSurfaces.HtmlSceneSurfaceCache, 'captureFull' | 'destroy'>,
    );

    expect(cache.captureFull).not.toHaveBeenCalled();

    const firstFrame = new Map<
      string,
      { width: number; height: number; data: Uint8ClampedArray }
    >();
    await source.captureInto(firstFrame, [
      {
        requirementId: 'html-scene:scene',
        objectId: 'scene',
        assetId: 'html-scene:scene.package',
        scenePackageId: 'scene.package',
        timeUs: 100_000,
      },
    ]);

    expect(cache.captureFull).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([100_000]);
    expect(firstFrame.get('scene')?.data[0]).toBe(100);

    const secondFrame = new Map<
      string,
      { width: number; height: number; data: Uint8ClampedArray }
    >();
    await source.captureInto(secondFrame, [
      {
        requirementId: 'html-scene:scene',
        objectId: 'scene',
        assetId: 'html-scene:scene.package',
        scenePackageId: 'scene.package',
        timeUs: 200_000,
      },
    ]);

    expect(cache.captureFull).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([100_000, 200_000]);
    expect(secondFrame.get('scene')?.data[0]).toBe(200);

    source.destroy();
    expect(cache.destroy).toHaveBeenCalledTimes(1);
  });
});
