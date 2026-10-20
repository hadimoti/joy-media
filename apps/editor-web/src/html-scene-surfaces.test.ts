import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHistoricalSchemaProjects } from '@joy-media/test-fixtures';
import type { JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import { HtmlSceneSurfaceCache, type HtmlSceneProjectContext } from './html-scene-surfaces.js';

const mocks = vi.hoisted(() => ({ create: vi.fn(), loadFonts: vi.fn(), buildFrame: vi.fn() }));
vi.mock('@joy-media/html-scene-runtime/browser', () => ({
  createScenePreviewHost: mocks.create,
  findFirstPartyScene: (id: string) => (id === 'missing' ? undefined : { id }),
  defaultVariablesForScene: () => ({}),
  viewportForScene: () => ({ width: 1080, height: 1920 }),
}));
vi.mock('./p0-title-fonts.js', () => ({ p0TitleFontFaces: mocks.loadFonts }));
vi.mock('@joy-media/motion-core', () => ({
  buildTitleSceneFrame: mocks.buildFrame,
}));
const scene = (id = 'scene'): VisualObjectV1 =>
  ({ id, kind: 'html-scene', scenePackageId: 'title' }) as VisualObjectV1;
const size = { width: 64, height: 36 };
function bitmap(fill = 0) {
  return {
    width: 64,
    height: 36,
    data: new Uint8ClampedArray(64 * 36 * 4).fill(fill),
  };
}
function host(ready: Promise<void> = Promise.resolve()) {
  let updatedAt = 0;
  return {
    ready,
    update: vi.fn((_time: number, variables: { time?: number }) => {
      updatedAt = variables.time ?? 0;
      return true;
    }),
    destroy: vi.fn(),
    capture: vi.fn(async (width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4).fill(updatedAt % 256),
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function p0Context(id = 'title-object', packageId = 'joy.p0.title', width = 640) {
  const base = buildHistoricalSchemaProjects().v3;
  const composition = base.compositions.root!;
  const visual = {
    ...base,
    schemaVersion: 1,
    rootCompositionId: 'root',
    compositions: {
      ...base.compositions,
      root: { ...composition, width, height: 360, frameRate: 30 },
    },
    visualObjects: {
      [id]: { id, kind: 'html-scene', scenePackageId: packageId },
    },
    pluginData: {
      ...base.pluginData,
      'joy.contentTemplates': { instances: { instance: { objectId: id } } },
      'joy.clipObjects': {},
    },
    universalTimeline: {
      schemaVersion: 1,
      items: [
        {
          id: 'clip',
          compositionId: 'root',
          trackId: 'video-track',
          elementKind: 'html-scene',
          startUs: 0,
          durationUs: 100_000,
          source: { kind: 'object', id },
          withinTrackOrder: 1,
        },
      ],
    },
  } as unknown as JoyProjectV1;
  return { visual, timeline: {} } as unknown as HtmlSceneProjectContext;
}

describe('HTML scene export conformance', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.loadFonts.mockReset().mockResolvedValue([]);
    mocks.buildFrame.mockReset().mockImplementation((_i, _id, _d, localTimeUs) => ({
      variables: { time: localTimeUs },
      paint: { fonts: [] },
    }));
    mocks.create.mockImplementation(() => host());
    vi.stubGlobal('document', { fonts: { ready: Promise.resolve() } });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses the newest P0 viewport when font preparation overlaps', async () => {
    const oldFonts = deferred<never[]>();
    mocks.loadFonts.mockReturnValueOnce(oldFonts.promise).mockResolvedValue([]);
    const firstHost = host();
    const secondHost = host();
    mocks.create.mockReturnValueOnce(firstHost).mockReturnValue(secondHost);
    const cache = new HtmlSceneSurfaceCache();
    const older = cache.sync(p0Context('title-object', 'joy.p0.title', 640), 1);
    await Promise.resolve();
    const newer = cache.sync(p0Context('title-object', 'joy.p0.title', 800), 2);
    await newer;
    oldFonts.resolve([]);
    await older;
    const created = mocks.create.mock.results.map((result) => result.value);
    expect(created).toHaveLength(2);
    expect(created.filter((entry) => entry.destroy.mock.calls.length === 0)).toHaveLength(1);
    expect(cache.exportMetrics().hosts).toBe(1);
    expect(cache.bitmaps().get('title-object')?.data[0]).toBe(2);
    cache.destroy();
    expect(created.every((entry) => entry.destroy.mock.calls.length === 1)).toBe(true);
  });

  it.each(['fonts', 'readiness', 'capture'] as const)(
    'keeps a replaced P0 host from surviving stale work (%s)',
    async (phase) => {
      const oldFonts = deferred<never[]>();
      const oldDocumentFonts = deferred<void>();
      const oldReadinessStarted = deferred<void>();
      const oldCapture = deferred<ReturnType<typeof bitmap>>();
      const captureStarted = deferred<void>();
      let documentFontReads = 0;
      mocks.loadFonts
        .mockReturnValueOnce(phase === 'fonts' ? oldFonts.promise : Promise.resolve([]))
        .mockResolvedValue([]);
      vi.stubGlobal('document', {
        fonts: {
          get ready() {
            documentFontReads += 1;
            if (phase === 'readiness' && documentFontReads === 1) oldReadinessStarted.resolve();
            return phase === 'readiness' && documentFontReads === 1
              ? oldDocumentFonts.promise
              : Promise.resolve();
          },
        },
      });
      const oldHost = host();
      if (phase === 'capture')
        oldHost.capture.mockImplementationOnce((width, height) => {
          captureStarted.resolve();
          return oldCapture.promise.then(() => ({
            width,
            height,
            data: new Uint8ClampedArray(width * height * 4).fill(1),
          }));
        });
      const newHost = host();
      mocks.create.mockReturnValueOnce(oldHost).mockReturnValue(newHost);
      const cache = new HtmlSceneSurfaceCache();
      const older = cache.sync(p0Context('title-object', 'joy.p0.title', 640), 1);

      if (phase === 'fonts') {
        await Promise.resolve();
        const newer = cache.sync(p0Context('new-object', 'joy.p0.title', 800), 2);
        await newer;
        oldFonts.resolve([]);
      } else if (phase === 'readiness') {
        await oldReadinessStarted.promise;
        const newer = cache.sync(p0Context('title-object', 'joy.p0.title', 800), 2);
        await newer;
        oldDocumentFonts.resolve();
      } else {
        await captureStarted.promise;
        const newer = cache.sync(p0Context('title-object', 'joy.p0.title', 800), 2);
        await newer;
        oldCapture.resolve(bitmap(1));
      }
      await older;

      const created = mocks.create.mock.results.map((result) => result.value);
      if (phase === 'readiness')
        expect(
          created.reduce((updates, entry) => updates + entry.update.mock.calls.length, 0),
        ).toBe(1);
      expect(created).toHaveLength(2);
      expect(created.filter((entry) => entry.destroy.mock.calls.length === 0)).toHaveLength(1);
      expect(cache.exportMetrics().hosts).toBe(1);
      expect(cache.bitmaps().get(phase === 'fonts' ? 'new-object' : 'title-object')?.data[0]).toBe(
        2,
      );
      cache.destroy();
      expect(created.every((entry) => entry.destroy.mock.calls.length === 1)).toBe(true);
      expect(cache.exportMetrics().hosts).toBe(0);
    },
  );

  it('destroys superseded pending hosts without destroying adopted hosts', async () => {
    const fontLoad = deferred<never[]>();
    mocks.loadFonts.mockReturnValue(fontLoad.promise);
    const cache = new HtmlSceneSurfaceCache();
    const first = cache.sync(p0Context('title-object', 'joy.p0.title', 640), 1);
    await Promise.resolve();
    const adopted = cache.sync(p0Context('title-object', 'joy.p0.title', 640), 2);
    const replacement = cache.sync(p0Context('title-object', 'joy.p0.title', 800), 3);
    const replacementAdopted = cache.sync(p0Context('title-object', 'joy.p0.title', 800), 4);
    await Promise.resolve();
    fontLoad.resolve([]);
    await Promise.all([first, adopted, replacement, replacementAdopted]);
    const created = mocks.create.mock.results.map((result) => result.value);
    expect(created).toHaveLength(2);
    expect(created[0]!.destroy).toHaveBeenCalledOnce();
    expect(created[1]!.destroy).not.toHaveBeenCalled();
    expect(cache.exportMetrics().hosts).toBe(1);
    cache.destroy();
    expect(created[1]!.destroy).toHaveBeenCalledOnce();
    expect(cache.exportMetrics().hosts).toBe(0);

    const pendingFonts = deferred<never[]>();
    mocks.loadFonts.mockReturnValue(pendingFonts.promise);
    const destroyedCache = new HtmlSceneSurfaceCache();
    const pendingSync = destroyedCache.sync(p0Context('orphan', 'joy.p0.title', 640), 5);
    await Promise.resolve();
    destroyedCache.destroy();
    pendingFonts.resolve([]);
    await pendingSync;
    const orphanHost = mocks.create.mock.results.at(-1)!.value;
    expect(orphanHost.destroy).toHaveBeenCalledOnce();
    expect(destroyedCache.exportMetrics().hosts).toBe(0);
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
