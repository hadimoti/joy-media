import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisualObjectV1 } from '@joy-media/project-schema';
import { HtmlSceneSurfaceCache } from './html-scene-surfaces.js';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@joy-media/html-scene-runtime/browser', () => ({
  createScenePreviewHost: mocks.create,
  findFirstPartyScene: (id: string) => (id === 'missing' ? undefined : { id }),
  defaultVariablesForScene: () => ({}),
  viewportForScene: () => ({ width: 1080, height: 1920 }),
}));
const scene = (id = 'scene'): VisualObjectV1 =>
  ({ id, kind: 'html-scene', scenePackageId: 'title' }) as VisualObjectV1;
const size = { width: 64, height: 36 };
function host(ready: Promise<void> = Promise.resolve()) {
  return {
    ready,
    update: vi.fn(() => true),
    destroy: vi.fn(),
    capture: vi.fn(async (width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    })),
  };
}

describe('HTML scene export conformance', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.create.mockImplementation(() => host());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures a real target-sized RGBA plane, including 4K landscape exports', async () => {
    const cache = new HtmlSceneSurfaceCache();
    const frame = await cache.captureFull({ scene: scene() }, 12_345, {
      width: 3840,
      height: 2160,
    });
    expect(frame.get('scene')).toMatchObject({ width: 3840, height: 2160 });
    expect(frame.get('scene')!.data.byteLength).toBe(33_177_600);
    expect(mocks.create.mock.results[0]!.value.update).toHaveBeenCalledWith(12_345, {});
    cache.destroy();
    expect(cache.exportMetrics().retainedFrameBytes).toBe(0);
  });

  it('retains one current frame over a ten-minute 30fps sequence, and releases retired hosts', async () => {
    const cache = new HtmlSceneSurfaceCache();
    for (let frame = 0; frame < 18_000; frame++) {
      await cache.captureFull({ scene: scene() }, Math.floor((frame * 1_000_000) / 30), size);
    }
    expect(cache.exportMetrics()).toEqual({
      capturedFrames: 18_000,
      retainedFrameBytes: 9216,
      peakFrameBytes: 9216,
      hosts: 1,
    });
    const firstHost = mocks.create.mock.results[0]!.value;
    await cache.captureFull({ next: scene('next') }, 600_000_000, size);
    expect(firstHost.destroy).toHaveBeenCalledOnce();
    expect(cache.exportMetrics().hosts).toBe(1);
    cache.destroy();
    expect(cache.exportMetrics()).toMatchObject({ retainedFrameBytes: 0, hosts: 0 });
  });

  it('rejects excessive frame memory before creating any hosts', async () => {
    const cache = new HtmlSceneSurfaceCache();
    await expect(
      cache.captureFull({ scene: scene() }, 0, { ...size, maxFrameBytes: 100 }),
    ).rejects.toThrow('memory budget');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('serializes overlapping scenes instead of allocating all captures in parallel', async () => {
    let finish: () => void = () => undefined;
    const first = host(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    mocks.create.mockReturnValueOnce(first).mockImplementation(() => host());
    const cache = new HtmlSceneSurfaceCache();
    const capture = cache.captureFull({ a: scene('a'), b: scene('b') }, 0, size);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    await expect(cache.captureFull({ a: scene('a') }, 0, size)).rejects.toThrow('in progress');
    finish();
    expect((await capture).size).toBe(2);
    cache.destroy();
  });

  it.each(['ready', 'capture'] as const)(
    'cancels during %s and destroys every owned host',
    async (phase) => {
      const pending = host(phase === 'ready' ? new Promise(() => undefined) : Promise.resolve());
      if (phase === 'capture')
        pending.capture.mockImplementation(() => new Promise(() => undefined));
      mocks.create.mockReturnValue(pending);
      const cache = new HtmlSceneSurfaceCache();
      const controller = new AbortController();
      const capture = cache.captureFull({ scene: scene() }, 0, {
        ...size,
        signal: controller.signal,
      });
      const assertion = expect(capture).rejects.toMatchObject({ name: 'AbortError' });
      await Promise.resolve();
      controller.abort();
      await assertion;
      expect(pending.destroy).toHaveBeenCalledOnce();
      expect(cache.exportMetrics()).toMatchObject({ retainedFrameBytes: 0, hosts: 0 });
    },
  );

  it('times out scene readiness and surfaces capture failures without accepting missing pixels', async () => {
    vi.useFakeTimers();
    const pending = host(new Promise(() => undefined));
    mocks.create.mockReturnValueOnce(pending);
    const cache = new HtmlSceneSurfaceCache();
    const assertion = expect(
      cache.captureFull({ scene: scene() }, 0, { ...size, timeoutMs: 10 }),
    ).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(pending.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const failed = host();
    failed.capture.mockRejectedValue(new Error('raster failed'));
    mocks.create.mockReturnValueOnce(failed);
    await expect(cache.captureFull({ scene: scene() }, 0, size)).rejects.toThrow('raster failed');
    expect(failed.destroy).toHaveBeenCalledOnce();
    expect(cache.exportMetrics().capturedFrames).toBe(0);
  });
});
