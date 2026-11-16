// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIdentityColorGrade,
  type JoyProjectV1,
  type SpikeProject,
  type VideoClip,
  type VisualObjectV1,
} from '@joy-media/project-schema';
import { videoFrameNodeFromDecoded } from '@joy-media/playback-engine';
import { nodeBoundsFromBox } from '@joy-media/render-ir';
import { createCompositionObserver } from './composition-observer.js';
import { StickerImageCache } from '../sticker-image-cache.js';

const mocks = vi.hoisted(() => ({
  createRenderer: vi.fn(),
  waitFonts: vi.fn(async () => undefined),
  loadDetachedVideo: vi.fn(async (video: HTMLVideoElement) => {
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
  }),
  seekDetachedVideo: vi.fn(
    async (_video: HTMLVideoElement, _timeUs: number, _signal: AbortSignal) => undefined,
  ),
  openExportFrameSource: vi.fn(),
  readSourceFrameTimingWithin: vi.fn(
    async (): Promise<
      { readonly frameDurationUs: number; readonly toleranceUs: number } | undefined
    > => undefined,
  ),
  createDecoder: vi.fn(() => ({
    captureCurrentFrame: vi.fn((token: number) => ({
      assetId: 'video-asset',
      sourceTimeUs: 0,
      token,
      bitmap: {
        width: 4,
        height: 4,
        data: new Uint8ClampedArray(4 * 4 * 4).fill(90),
      },
    })),
  })),
}));

vi.mock('@joy-media/renderer-pixi/browser', () => ({
  createBrowserPixiRenderer: mocks.createRenderer,
}));
vi.mock('../font-readiness.js', () => ({ waitForContentFonts: mocks.waitFonts }));
vi.mock('../export-preload.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadDetachedVideo: mocks.loadDetachedVideo,
    seekDetachedVideo: mocks.seekDetachedVideo,
  };
});
vi.mock('../export-frame-source.js', () => ({
  openExportFrameSource: mocks.openExportFrameSource,
}));
vi.mock('../export-source-frame.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readSourceFrameTimingWithin: mocks.readSourceFrameTimingWithin };
});
vi.mock('@joy-media/playback-engine', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createHtmlMediaDecoder: mocks.createDecoder };
});

import {
  createIsolatedCompositionCapture,
  videoClipSpecAt,
} from './isolated-composition-capture.js';

const ZERO_CROP = { left: 0, top: 0, right: 0, bottom: 0 } as const;

function transform(
  overrides: Partial<VisualObjectV1['transform']> = {},
): VisualObjectV1['transform'] {
  return {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: ZERO_CROP,
    ...overrides,
  };
}

function visualProject(objects: Record<string, VisualObjectV1> = {}): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id: 'capture-fixture',
    title: 'Fixture',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 4,
        height: 4,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 1_000_000,
        background: '#000000',
        activeCameraId: undefined,
        tracks: [
          {
            id: 'captions',
            kind: 'caption',
            name: 'Captions',
            order: 1,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'caption-clip',
                kind: 'caption',
                captionDocumentId: 'doc',
                startUs: 0,
                durationUs: 1_000_000,
              },
            ],
          },
          {
            id: 'hidden-track',
            kind: 'video',
            name: 'Hidden',
            order: 2,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'hidden-clip',
                kind: 'video',
                assetId: 'hidden-asset',
                sourceInUs: 0,
                startUs: 0,
                durationUs: 1_000_000,
              },
            ],
          },
        ],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: objects,
    captionDocuments: {
      doc: {
        id: 'doc',
        language: 'en',
        direction: 'ltr',
        speakers: [],
        words: { word: { id: 'word', text: 'Caption', startUs: 0, endUs: 800_000 } },
        segments: [{ id: 'segment', startUs: 0, endUs: 800_000, wordIds: ['word'] }],
      },
    },
    pluginData: {
      'joy.captions.burnIn': true,
      'joy.clipObjects': { 'hidden-clip': 'hidden-title' },
    },
  } as unknown as JoyProjectV1;
}

function timelineProject(enabled = false): SpikeProject {
  return {
    rootCompositionId: 'root',
    compositions: {
      root: {
        durationUs: 1_000_000,
        tracks: [
          {
            id: 'hidden-track',
            kind: 'video',
            name: 'Hidden',
            order: 0,
            enabled,
            locked: false,
            clips: [
              {
                id: 'hidden-clip',
                kind: 'video',
                assetId: 'hidden-asset',
                sourceInUs: 0,
                startUs: 0,
                durationUs: 1_000_000,
              },
            ],
          },
        ],
      },
    },
  } as unknown as SpikeProject;
}

function fakeRenderer(options: { readonly throwOnRender?: boolean } = {}) {
  const pixels = new Uint8ClampedArray(4 * 4 * 4).fill(37);
  const renderer = {
    canvas: document.createElement('canvas'),
    width: 4,
    height: 4,
    resolution: 1,
    setPixelScale: vi.fn(),
    setView: vi.fn(),
    nodeBounds: vi.fn(),
    render: vi.fn((_frame: unknown, _bitmaps: unknown) => {
      if (options.throwOnRender) throw new Error('render failed');
      return { width: 4, height: 4, drawCalls: 1, created: 1, reused: 0 };
    }),
    readPixels: vi.fn((width = 640, height = 360) => ({
      width: Math.min(width, 4),
      height: Math.min(height, 4),
      data: pixels,
    })),
    destroy: vi.fn(),
  };
  mocks.createRenderer.mockResolvedValue(renderer);
  return renderer;
}

function requestFor(
  capture: ReturnType<typeof createIsolatedCompositionCapture>,
  signal?: AbortSignal,
) {
  return {
    ...capture.composition,
    outputTimesUs: [0],
    ...(signal === undefined ? {} : { signal }),
  };
}

function activeVideoTimeline(clip: VideoClip): SpikeProject {
  return {
    rootCompositionId: 'root',
    compositions: {
      root: {
        durationUs: 1_000_000,
        tracks: [
          {
            id: 'video-track',
            kind: 'video',
            name: 'Video',
            order: 0,
            enabled: true,
            locked: false,
            clips: [clip],
          },
        ],
      },
    },
  } as unknown as SpikeProject;
}

function stubImageDecode(): void {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 4, height: 4, close: vi.fn() })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({
      width: 4,
      height: 4,
      data: new Uint8ClampedArray(4 * 4 * 4).fill(120),
    })),
  } as never);
}

function imageDataWithPrototypeDimensions() {
  const prototype = {
    get width() {
      return 4;
    },
    get height() {
      return 4;
    },
  };
  const imageData = Object.create(prototype) as {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
  };
  Object.defineProperty(imageData, 'data', {
    get: () => new Uint8ClampedArray(4 * 4 * 4).fill(90),
  });
  return imageData;
}

function stubImageDataPixels(): void {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 4, height: 4, close: vi.fn() })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn(() => imageDataWithPrototypeDimensions()),
  } as never);
}

function stubObjectUrls(): void {
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:capture-fixture'),
    revokeObjectURL: vi.fn(),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.createRenderer.mockReset();
  mocks.loadDetachedVideo.mockClear().mockImplementation(async (video) => {
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
  });
  mocks.seekDetachedVideo.mockReset().mockResolvedValue(undefined);
  mocks.openExportFrameSource.mockReset();
  mocks.readSourceFrameTimingWithin.mockReset().mockResolvedValue(undefined);
  mocks.createDecoder.mockClear();
  mocks.waitFonts.mockReset().mockResolvedValue(undefined);
});

describe('isolated composition capture', () => {
  it('collects renderer title bounds and leaves missing-font text unmeasured', async () => {
    const renderer = fakeRenderer();
    renderer.nodeBounds.mockImplementation((id: string) =>
      id === 'title'
        ? nodeBoundsFromBox(
            id,
            { translateX: 0, translateY: 10, scaleX: 1, scaleY: 1 },
            { x: -2, y: 0, width: 20, height: 10 },
          )
        : undefined,
    );
    const title: VisualObjectV1 = {
      id: 'title',
      kind: 'text',
      text: 'Title',
      transform: transform(),
    };
    const fixtureProject = visualProject({ title });
    const root = fixtureProject.compositions.root!;
    const project = {
      ...fixtureProject,
      compositions: { ...fixtureProject.compositions, root: { ...root, tracks: [] } },
      pluginData: { ...fixtureProject.pluginData, 'joy.captions.burnIn': false },
    };
    const capture = createIsolatedCompositionCapture({
      visualProject: project,
      timelineProject: timelineProject(),
      loadProjectAssetBlob: async () => undefined,
    });
    try {
      const measured = await capture.collectTextBoxes();
      expect(measured.boxes).toHaveLength(1);
      expect(measured.boxes[0]?.x).toBeLessThan(0);
      expect(measured.notMeasured).toBe(false);
    } finally {
      capture.release();
    }

    const missingRenderer = fakeRenderer();
    mocks.waitFonts.mockRejectedValueOnce(new Error('font missing'));
    const missingFont = createIsolatedCompositionCapture({
      visualProject: visualProject({
        title: { ...title, textStyle: { fontFamily: 'Missing Font' } as never },
      }),
      timelineProject: timelineProject(),
      loadProjectAssetBlob: async () => undefined,
    });
    try {
      await expect(missingFont.collectTextBoxes()).resolves.toEqual({
        boxes: [],
        notMeasured: true,
      });
    } finally {
      missingFont.release();
    }
    expect(missingRenderer.render).not.toHaveBeenCalled();
  });

  it('reads the full frame pixels and turns render throws into a failed result', async () => {
    const renderer = fakeRenderer();
    const successful = createIsolatedCompositionCapture({
      visualProject: visualProject(),
      timelineProject: timelineProject(),
      loadProjectAssetBlob: async () => undefined,
    });
    try {
      const result = await createCompositionObserver().capture(requestFor(successful));
      expect(result).toMatchObject({ status: 'captured', frames: [{ width: 4, height: 4 }] });
      expect(renderer.readPixels).toHaveBeenCalledWith(4, 4);
      expect(result.status === 'captured' && result.frames[0]?.rgba).toEqual(
        new Uint8Array(4 * 4 * 4).fill(37),
      );
    } finally {
      successful.release();
    }
    await Promise.resolve();
    expect(renderer.destroy).toHaveBeenCalledTimes(1);

    const failingRenderer = fakeRenderer({ throwOnRender: true });
    const failed = createIsolatedCompositionCapture({
      visualProject: visualProject(),
      timelineProject: timelineProject(),
      loadProjectAssetBlob: async () => undefined,
    });
    try {
      await expect(createCompositionObserver().capture(requestFor(failed))).resolves.toMatchObject({
        status: 'failed',
        code: 'renderer-failed',
      });
    } finally {
      failed.release();
    }
    await Promise.resolve();
    expect(failingRenderer.destroy).toHaveBeenCalledTimes(1);
  });

  it('releases after an aborted capture', async () => {
    const renderer = fakeRenderer();
    let resolveRenderer: ((value: ReturnType<typeof fakeRenderer>) => void) | undefined;
    mocks.createRenderer.mockReturnValue(
      new Promise((resolve) => {
        resolveRenderer = resolve;
      }),
    );
    const capture = createIsolatedCompositionCapture({
      visualProject: visualProject(),
      timelineProject: timelineProject(),
      loadProjectAssetBlob: async () => undefined,
    });
    const controller = new AbortController();
    const operation = createCompositionObserver().capture(requestFor(capture, controller.signal));
    await vi.waitFor(() => expect(mocks.createRenderer).toHaveBeenCalledTimes(1));
    controller.abort();
    resolveRenderer?.(renderer);
    try {
      await expect(operation).resolves.toMatchObject({ status: 'cancelled' });
    } finally {
      capture.release();
    }
    await Promise.resolve();
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not cache a blob that resolves after the capture has been released', async () => {
    stubImageDecode();
    const pendingImage: VisualObjectV1 = {
      id: 'pending-sticker',
      kind: 'image',
      assetId: 'image-asset',
      transform: transform(),
    };
    let finishLoad!: (blob: Blob) => void;
    const load = vi.fn(
      () =>
        new Promise<Blob>((resolve) => {
          finishLoad = resolve;
        }),
    );
    const cleared = vi.spyOn(StickerImageCache.prototype, 'clear');
    const capture = createIsolatedCompositionCapture({
      visualProject: {
        ...visualProject({ 'pending-sticker': pendingImage }),
        assets: { 'image-asset': { id: 'image-asset', kind: 'image', displayName: 'Image' } },
      } as JoyProjectV1,
      timelineProject: timelineProject(),
      loadProjectAssetBlob: load,
    });
    const evaluation = capture.composition.evaluator.evaluate(
      capture.composition.snapshot,
      0,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    capture.release();
    finishLoad(new Blob(['image']));
    await expect(evaluation).rejects.toThrow();
    expect(cleared).toHaveBeenCalledOnce();
  });

  it('copies export frame fields: hidden content is absent while title and caption nodes remain', async () => {
    fakeRenderer();
    const title: VisualObjectV1 = {
      id: 'title',
      kind: 'text',
      text: 'Title',
      transform: transform(),
    };
    const hiddenTitle: VisualObjectV1 = {
      id: 'hidden-title',
      kind: 'text',
      text: 'Hidden',
      transform: transform(),
    };
    const capture = createIsolatedCompositionCapture({
      visualProject: visualProject({ title, 'hidden-title': hiddenTitle }),
      timelineProject: timelineProject(false),
      loadProjectAssetBlob: async () => undefined,
    });
    try {
      const frame = await capture.composition.evaluator.evaluate(
        capture.composition.snapshot,
        0,
        new AbortController().signal,
      );
      expect(frame.nodes.some((node) => node.id === 'title')).toBe(true);
      expect(frame.nodes.some((node) => node.id === 'hidden-title')).toBe(false);
      expect(frame.nodes.some((node) => node.kind === 'text' && node.id !== 'title')).toBe(true);
    } finally {
      capture.release();
    }
  });

  it('blocks a missing font before rendering any pixels', async () => {
    const renderer = fakeRenderer();
    mocks.waitFonts.mockRejectedValueOnce(new Error('font missing'));
    const title: VisualObjectV1 = {
      id: 'title',
      kind: 'text',
      text: 'Title',
      textStyle: { fontFamily: 'Missing Font' } as never,
      transform: transform(),
    };
    const capture = createIsolatedCompositionCapture({
      visualProject: visualProject({ title }),
      timelineProject: timelineProject(),
      loadProjectAssetBlob: async () => undefined,
    });
    try {
      await expect(createCompositionObserver().capture(requestFor(capture))).resolves.toMatchObject(
        {
          status: 'blocked',
          code: 'dependency-not-ready',
          diagnostics: [{ kind: 'font' }],
        },
      );
    } finally {
      capture.release();
    }
    expect(renderer.render).not.toHaveBeenCalled();
    expect(renderer.readPixels).not.toHaveBeenCalled();
  });

  it('does not produce a frame when a still-clip decode fails', async () => {
    const decode = vi.fn(async () => {
      throw new Error('decode failed');
    });
    vi.stubGlobal('createImageBitmap', decode);
    const renderer = fakeRenderer();
    const clip: VideoClip = {
      id: 'still-clip',
      kind: 'video',
      assetId: 'image-asset',
      sourceInUs: 0,
      startUs: 0,
      durationUs: 1_000_000,
    };
    const project = {
      ...visualProject(),
      assets: { 'image-asset': { id: 'image-asset', kind: 'image', displayName: 'Still' } },
    } as JoyProjectV1;
    const capture = createIsolatedCompositionCapture({
      visualProject: project,
      timelineProject: activeVideoTimeline(clip),
      loadProjectAssetBlob: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) as Blob,
    });
    try {
      await expect(createCompositionObserver().capture(requestFor(capture))).resolves.toMatchObject(
        { status: 'failed', code: 'renderer-failed' },
      );
    } finally {
      capture.release();
    }
    expect(decode).toHaveBeenCalledTimes(1);
    expect(renderer.readPixels).not.toHaveBeenCalled();
  });

  it('fails closed when an active sticker bitmap is missing from the cache', async () => {
    stubImageDecode();
    const renderer = fakeRenderer();
    vi.spyOn(StickerImageCache.prototype, 'bitmaps').mockReturnValue(new Map());
    const sticker: VisualObjectV1 = {
      id: 'sticker',
      kind: 'image',
      assetId: 'sticker-asset',
      transform: transform(),
    };
    const capture = createIsolatedCompositionCapture({
      visualProject: {
        ...visualProject({ sticker }),
        assets: { 'sticker-asset': { id: 'sticker-asset', kind: 'image', displayName: 'Sticker' } },
      } as JoyProjectV1,
      timelineProject: timelineProject(),
      loadProjectAssetBlob: async () => new Blob(['image']),
    });
    try {
      await expect(createCompositionObserver().capture(requestFor(capture))).resolves.toMatchObject(
        { status: 'failed', code: 'renderer-failed' },
      );
    } finally {
      capture.release();
    }
    expect(renderer.render).not.toHaveBeenCalled();
    expect(renderer.readPixels).not.toHaveBeenCalled();
  });

  it('copies ImageData dimensions from the forward video path into the renderer', async () => {
    const renderer = fakeRenderer();
    const clip: VideoClip = {
      id: 'video-clip',
      kind: 'video',
      assetId: 'video-asset',
      sourceInUs: 0,
      startUs: 0,
      durationUs: 1_000_000,
    };
    const grade = createIdentityColorGrade();
    const project = {
      ...visualProject(),
      assets: { 'video-asset': { id: 'video-asset', kind: 'video', displayName: 'Video' } },
      clipColorGrades: {
        'video-clip': { ...grade, adjust: { ...grade.adjust, saturation: 0.4 } },
      },
    } as unknown as JoyProjectV1;
    const frameAt = vi.fn(async () => ({
      assetId: 'video-asset',
      sourceTimeUs: 0,
      token: 0,
      bitmap: imageDataWithPrototypeDimensions(),
    }));
    mocks.openExportFrameSource.mockResolvedValue({
      frameAt,
      size: () => ({ width: 4, height: 4 }),
      seekTiming: undefined,
      release: vi.fn(),
      close: vi.fn(),
    });
    const capture = createIsolatedCompositionCapture({
      visualProject: project,
      timelineProject: activeVideoTimeline(clip),
      loadProjectAssetBlob: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) as Blob,
    });
    try {
      const result = await createCompositionObserver().capture(requestFor(capture));
      expect(result.status, JSON.stringify(result)).toBe('captured');
      const renderArgs = renderer.render.mock.calls[0];
      const frame = renderArgs?.[0] as { nodes: Array<{ id: string; colorGrade?: unknown }> };
      const bitmaps = renderArgs?.[1] as Map<string, { width: number; height: number }>;
      expect(bitmaps.get('video-clip')).toMatchObject({ width: 4, height: 4 });
      expect(Object.hasOwn(imageDataWithPrototypeDimensions(), 'width')).toBe(false);
      expect(frameAt).toHaveBeenCalledTimes(1);
      expect(renderer.render).toHaveBeenCalledTimes(1);
      expect(frame.nodes.find((node) => node.id === 'video-clip')?.colorGrade).toMatchObject({
        saturation: 0.4,
      });
    } finally {
      capture.release();
    }
  });

  it('uses the export mask source and keeps overlay video clips visible', async () => {
    const renderer = fakeRenderer();
    const clip: VideoClip = {
      id: 'video-clip',
      kind: 'video',
      assetId: 'original-video',
      sourceInUs: 0,
      startUs: 0,
      durationUs: 1_000_000,
    };
    const frameAt = vi.fn(async () => ({
      assetId: 'masked-video',
      sourceTimeUs: 0,
      token: 1,
      bitmap: { width: 4, height: 4, data: new Uint8ClampedArray(64) },
    }));
    mocks.openExportFrameSource.mockResolvedValue({
      frameAt,
      size: () => ({ width: 4, height: 4 }),
      seekTiming: undefined,
      close: vi.fn(),
    });
    const project = {
      ...visualProject(),
      assets: {
        'original-video': { id: 'original-video', kind: 'video', displayName: 'Original' },
        'masked-video': { id: 'masked-video', kind: 'video', displayName: 'Masked' },
      },
      pluginData: {
        'joy.videoMaskSource': { 'video-clip': 'masked-video' },
        'joy.timelineElementKinds': { 'video-clip': 'overlay' },
      },
    } as unknown as JoyProjectV1;
    const capture = createIsolatedCompositionCapture({
      visualProject: project,
      timelineProject: activeVideoTimeline(clip),
      loadProjectAssetBlob: async (assetId) => new Blob([assetId]),
    });
    try {
      const result = await createCompositionObserver().capture(requestFor(capture));
      expect(result.status).toBe('captured');
      expect(mocks.openExportFrameSource).toHaveBeenCalledWith(
        expect.any(Blob),
        'masked-video',
        expect.objectContaining({ signal: expect.anything() }),
      );
      const frame = renderer.render.mock.calls[0]?.[0] as { nodes: Array<{ id: string }> };
      expect(frame.nodes.some((node) => node.id === 'video-clip')).toBe(true);
    } finally {
      capture.release();
    }
  });

  it('copies ImageData dimensions from a still clip into the renderer', async () => {
    stubImageDataPixels();
    const renderer = fakeRenderer();
    const clip: VideoClip = {
      id: 'still-clip',
      kind: 'video',
      assetId: 'image-asset',
      sourceInUs: 0,
      startUs: 0,
      durationUs: 1_000_000,
    };
    const capture = createIsolatedCompositionCapture({
      visualProject: {
        ...visualProject(),
        assets: { 'image-asset': { id: 'image-asset', kind: 'image', displayName: 'Still' } },
      } as JoyProjectV1,
      timelineProject: activeVideoTimeline(clip),
      loadProjectAssetBlob: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) as Blob,
    });
    try {
      const result = await createCompositionObserver().capture(requestFor(capture));
      expect(
        result,
        JSON.stringify({ result, renderCalls: renderer.render.mock.calls.length }),
      ).toMatchObject({ status: 'captured' });
      const bitmaps = renderer.render.mock.calls[0]?.[1] as Map<string, { width: number }>;
      expect(bitmaps.get('still-clip')?.width).toBe(4);
    } finally {
      capture.release();
    }
  });

  it('sizes a cropped sticker from the returned cropped bitmap', async () => {
    stubImageDecode();
    fakeRenderer();
    const image: VisualObjectV1 = {
      id: 'cropped-image',
      kind: 'image',
      assetId: 'image-asset',
      transform: transform({ crop: { left: 0.25, top: 0, right: 0, bottom: 0 } }),
    };
    const project = {
      ...visualProject({ 'cropped-image': image }),
      assets: { 'image-asset': { id: 'image-asset', kind: 'image', displayName: 'Sticker' } },
    } as JoyProjectV1;
    const capture = createIsolatedCompositionCapture({
      visualProject: project,
      timelineProject: timelineProject(),
      loadProjectAssetBlob: async () => new Blob(['image']),
    });
    try {
      const frame = await capture.composition.evaluator.evaluate(
        capture.composition.snapshot,
        0,
        new AbortController().signal,
      );
      expect(frame.nodes.find((node) => node.id === 'cropped-image')).toMatchObject({ width: 3 });
    } finally {
      capture.release();
    }
  });

  it('keeps an image without an asset as the renderer placeholder', async () => {
    const renderer = fakeRenderer();
    const image: VisualObjectV1 = {
      id: 'missing-image',
      kind: 'image',
      transform: transform(),
    } as VisualObjectV1;
    const capture = createIsolatedCompositionCapture({
      visualProject: visualProject({ 'missing-image': image }),
      timelineProject: timelineProject(),
      loadProjectAssetBlob: async () => undefined,
    });
    try {
      const result = await createCompositionObserver().capture(requestFor(capture));
      expect(result.status).toBe('captured');
      const frame = renderer.render.mock.calls[0]?.[0] as { nodes: Array<{ id: string }> };
      expect(frame.nodes.some((node) => node.id === 'missing-image')).toBe(true);
    } finally {
      capture.release();
    }
  });

  it('captures a reversed clip at source time zero with decoded pixels', async () => {
    stubObjectUrls();
    const renderer = fakeRenderer();
    const clip: VideoClip = {
      id: 'reverse-clip',
      kind: 'video',
      assetId: 'video-asset',
      sourceInUs: 0,
      startUs: 0,
      durationUs: 1_000_000,
      reversed: true,
    };
    const project = {
      ...visualProject(),
      assets: { 'video-asset': { id: 'video-asset', kind: 'video', displayName: 'Video' } },
    } as JoyProjectV1;
    mocks.readSourceFrameTimingWithin.mockResolvedValueOnce({
      frameDurationUs: 100_000,
      toleranceUs: 10_000,
    });
    const capture = createIsolatedCompositionCapture({
      visualProject: project,
      timelineProject: activeVideoTimeline(clip),
      loadProjectAssetBlob: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) as Blob,
    });
    try {
      const result = await createCompositionObserver().capture(requestFor(capture));
      expect(result.status, JSON.stringify(result)).toBe('captured');
      expect(mocks.seekDetachedVideo).toHaveBeenCalledWith(
        expect.anything(),
        50_000,
        expect.anything(),
      );
      expect(mocks.readSourceFrameTimingWithin).toHaveBeenCalledOnce();
      const bitmaps = renderer.render.mock.calls[0]?.[1] as Map<
        string,
        { data: Uint8ClampedArray }
      >;
      expect(bitmaps.get('reverse-clip')?.data).toEqual(new Uint8ClampedArray(4 * 4 * 4).fill(90));
    } finally {
      capture.release();
    }
  });

  it('reuses a clip source through the one-second grace period before closing it', async () => {
    stubObjectUrls();
    fakeRenderer();
    const closeForward = vi.fn();
    const frameAt = vi.fn(async (sourceTimeUs: number) => ({
      assetId: 'video-asset',
      sourceTimeUs,
      token: sourceTimeUs,
      bitmap: {
        width: 4,
        height: 4,
        data: new Uint8ClampedArray(4 * 4 * 4).fill(90),
      },
    }));
    mocks.openExportFrameSource.mockResolvedValue({
      frameAt,
      size: () => ({ width: 4, height: 4 }),
      seekTiming: undefined,
      release: vi.fn(),
      close: closeForward,
    });
    const clip: VideoClip = {
      id: 'reverse-clip',
      kind: 'video',
      assetId: 'video-asset',
      sourceInUs: 0,
      startUs: 0,
      durationUs: 100_000,
    };
    const project = {
      ...visualProject(),
      assets: { 'video-asset': { id: 'video-asset', kind: 'video', displayName: 'Video' } },
    } as JoyProjectV1;
    const capture = createIsolatedCompositionCapture({
      visualProject: project,
      timelineProject: activeVideoTimeline(clip),
      loadProjectAssetBlob: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) as Blob,
    });
    try {
      await expect(
        createCompositionObserver().capture({
          ...capture.composition,
          outputTimesUs: [0, 50_000, 200_000, 1_600_001],
        }),
      ).resolves.toMatchObject({ status: 'captured', frames: [{}, {}, {}, {}] });
      expect(mocks.openExportFrameSource).toHaveBeenCalledTimes(1);
      expect(frameAt).toHaveBeenCalledTimes(2);
      expect(mocks.seekDetachedVideo).not.toHaveBeenCalled();
      expect(closeForward).toHaveBeenCalledTimes(1);
    } finally {
      capture.release();
    }
  });

  it('keeps the left transition source open through a transition longer than the old grace window', async () => {
    fakeRenderer();
    const closeLeft = vi.fn();
    const frameAt = vi.fn(async (sourceTimeUs: number) => ({
      assetId: 'video-asset',
      sourceTimeUs,
      token: sourceTimeUs,
      bitmap: { width: 4, height: 4, data: new Uint8ClampedArray(64) },
    }));
    mocks.openExportFrameSource.mockResolvedValue({
      frameAt,
      size: () => ({ width: 4, height: 4 }),
      seekTiming: undefined,
      close: closeLeft,
    });
    const left: VideoClip = {
      id: 'left',
      kind: 'video',
      assetId: 'video-asset',
      sourceInUs: 0,
      startUs: 0,
      durationUs: 1_000_000,
    };
    const right: VideoClip = {
      id: 'right',
      kind: 'video',
      assetId: 'video-asset',
      sourceInUs: 0,
      startUs: 5_000_000,
      durationUs: 1_000_000,
    };
    const timeline = {
      rootCompositionId: 'root',
      compositions: {
        root: {
          durationUs: 7_000_000,
          tracks: [
            {
              id: 'video-track',
              kind: 'video',
              name: 'Video',
              order: 0,
              enabled: true,
              locked: false,
              clips: [left, right],
            },
          ],
        },
      },
    } as unknown as SpikeProject;
    const project = {
      ...visualProject(),
      assets: { 'video-asset': { id: 'video-asset', kind: 'video', displayName: 'Video' } },
      transitions: [
        {
          id: 'long-dissolve',
          trackId: 'video-track',
          leftClipId: 'left',
          rightClipId: 'right',
          type: 'dissolve',
          durationUs: 4_000_000,
        },
      ],
    } as unknown as JoyProjectV1;
    const capture = createIsolatedCompositionCapture({
      visualProject: project,
      timelineProject: timeline,
      loadProjectAssetBlob: async () => new Blob(['video']),
    });
    try {
      await expect(
        createCompositionObserver().capture({
          ...capture.composition,
          outputTimesUs: [0, 3_000_000],
        }),
      ).resolves.toMatchObject({ status: 'captured' });
      expect(closeLeft).not.toHaveBeenCalled();
      expect(mocks.openExportFrameSource).toHaveBeenCalledTimes(2);
    } finally {
      capture.release();
    }
  });

  it('closes a forward decoder if the caller aborts as it opens', async () => {
    fakeRenderer();
    const controller = new AbortController();
    const close = vi.fn();
    mocks.openExportFrameSource.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({
        frameAt: vi.fn(),
        size: () => ({ width: 4, height: 4 }),
        seekTiming: undefined,
        close,
      });
    });
    const clip: VideoClip = {
      id: 'open-abort-clip',
      kind: 'video',
      assetId: 'video-asset',
      sourceInUs: 0,
      startUs: 0,
      durationUs: 1_000_000,
    };
    const capture = createIsolatedCompositionCapture({
      visualProject: {
        ...visualProject(),
        assets: { 'video-asset': { id: 'video-asset', kind: 'video', displayName: 'Video' } },
      } as JoyProjectV1,
      timelineProject: activeVideoTimeline(clip),
      loadProjectAssetBlob: async () => new Blob(['video']),
    });
    try {
      await expect(
        createCompositionObserver().capture(requestFor(capture, controller.signal)),
      ).resolves.toMatchObject({ status: 'cancelled' });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      capture.release();
    }
  });

  it('keeps repeated timeline slices of one clip on separate decoder resources', async () => {
    fakeRenderer();
    const clipAt = (startUs: number): VideoClip => ({
      id: 'reused-leaf',
      kind: 'video',
      assetId: 'video-asset',
      sourceInUs: 0,
      startUs,
      durationUs: 100_000,
    });
    const close = vi.fn();
    mocks.openExportFrameSource.mockImplementation(async () => ({
      frameAt: async (sourceTimeUs: number) => ({
        assetId: 'video-asset',
        sourceTimeUs,
        token: sourceTimeUs,
        bitmap: { width: 4, height: 4, data: new Uint8ClampedArray(64) },
      }),
      size: () => ({ width: 4, height: 4 }),
      seekTiming: undefined,
      close,
    }));
    const project = {
      ...visualProject(),
      compositions: {
        root: { ...visualProject().compositions.root, durationUs: 4_000_000 },
      },
      assets: { 'video-asset': { id: 'video-asset', kind: 'video', displayName: 'Video' } },
    } as unknown as JoyProjectV1;
    const timeline = {
      rootCompositionId: 'root',
      compositions: {
        root: {
          durationUs: 4_000_000,
          tracks: [
            {
              id: 'video-track',
              kind: 'video',
              name: 'Video',
              order: 0,
              enabled: true,
              locked: false,
              clips: [clipAt(0), clipAt(3_000_000)],
            },
          ],
        },
      },
    } as unknown as SpikeProject;
    const capture = createIsolatedCompositionCapture({
      visualProject: project,
      timelineProject: timeline,
      loadProjectAssetBlob: async () => new Blob(['video']),
    });
    try {
      const result = await createCompositionObserver().capture({
        ...capture.composition,
        outputTimesUs: [0, 3_000_000],
      });
      expect(result.status).toBe('captured');
      expect(mocks.openExportFrameSource).toHaveBeenCalledTimes(2);
    } finally {
      capture.release();
    }
  });

  it('keeps same-time leaves from separate compound tracks in separate resources and bitmaps', async () => {
    const renderer = fakeRenderer();
    mocks.openExportFrameSource.mockImplementation(async (_blob, assetId: string) => ({
      frameAt: async (sourceTimeUs: number) => ({
        assetId,
        sourceTimeUs,
        token: sourceTimeUs,
        bitmap: { width: 4, height: 4, data: new Uint8ClampedArray(64) },
      }),
      size: () => ({ width: 4, height: 4 }),
      seekTiming: undefined,
      close: vi.fn(),
    }));
    const childClip: VideoClip = {
      id: 'shared-leaf',
      kind: 'video',
      assetId: 'video-asset',
      sourceInUs: 0,
      startUs: 0,
      durationUs: 1_000_000,
    };
    const timeline = {
      rootCompositionId: 'root',
      compositions: {
        root: {
          durationUs: 1_000_000,
          tracks: ['track-a', 'track-b'].map((id) => ({
            id,
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                id: `compound-${id}`,
                kind: 'compound',
                compositionId: 'child',
                childOffsetUs: 0,
                startUs: 0,
                durationUs: 1_000_000,
              },
            ],
          })),
        },
        child: {
          durationUs: 1_000_000,
          tracks: [{ id: 'child-video', kind: 'video', enabled: true, clips: [childClip] }],
        },
      },
    } as unknown as SpikeProject;
    const capture = createIsolatedCompositionCapture({
      visualProject: {
        ...visualProject(),
        assets: { 'video-asset': { id: 'video-asset', kind: 'video', displayName: 'Video' } },
      } as JoyProjectV1,
      timelineProject: timeline,
      loadProjectAssetBlob: async () => new Blob(['video']),
    });
    try {
      await expect(createCompositionObserver().capture(requestFor(capture))).resolves.toMatchObject(
        {
          status: 'captured',
        },
      );
      expect(mocks.openExportFrameSource).toHaveBeenCalledTimes(2);
      const bitmaps = renderer.render.mock.calls[0]?.[1] as Map<string, unknown>;
      expect(bitmaps.size).toBe(2);
      expect([...bitmaps.keys()]).toEqual(
        expect.arrayContaining([
          'shared-leaf@0@compound-track-a/shared-leaf',
          'shared-leaf@0@compound-track-b/shared-leaf',
        ]),
      );
    } finally {
      capture.release();
    }
  });

  it('closes a failed forward decoder before seeking its fallback frame', async () => {
    stubObjectUrls();
    fakeRenderer();
    const close = vi.fn();
    const order: string[] = [];
    mocks.openExportFrameSource.mockResolvedValue({
      frameAt: async () => undefined,
      size: () => ({ width: 4, height: 4 }),
      seekTiming: undefined,
      close: () => {
        order.push('close');
        close();
      },
    });
    mocks.seekDetachedVideo.mockImplementation(async (video) => {
      order.push('seek');
      Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
    });
    const clip: VideoClip = {
      id: 'fallback-clip',
      kind: 'video',
      assetId: 'video-asset',
      sourceInUs: 0,
      startUs: 0,
      durationUs: 1_000_000,
    };
    const capture = createIsolatedCompositionCapture({
      visualProject: {
        ...visualProject(),
        assets: { 'video-asset': { id: 'video-asset', kind: 'video', displayName: 'Video' } },
      } as JoyProjectV1,
      timelineProject: activeVideoTimeline(clip),
      loadProjectAssetBlob: async () => new Blob(['video']),
    });
    try {
      await expect(
        createCompositionObserver().capture({
          ...capture.composition,
          outputTimesUs: [0, 100_000],
        }),
      ).resolves.toMatchObject({
        status: 'captured',
      });
      expect(close).toHaveBeenCalledOnce();
      expect(mocks.openExportFrameSource.mock.results[0]?.value).toBeDefined();
      expect(mocks.seekDetachedVideo).toHaveBeenCalledTimes(2);
      expect(order.indexOf('close')).toBeLessThan(order.indexOf('seek'));
    } finally {
      capture.release();
    }
  });

  it('falls back when opening the forward decoder times out and closes a late open', async () => {
    stubObjectUrls();
    fakeRenderer();
    let finishOpen!: (source: {
      close: () => void;
      size: () => { width: number; height: number };
      frameAt: () => Promise<undefined>;
    }) => void;
    const lateClose = vi.fn();
    mocks.openExportFrameSource.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        }),
    );
    const clip: VideoClip = {
      id: 'timeout-clip',
      kind: 'video',
      assetId: 'video-asset',
      sourceInUs: 0,
      startUs: 0,
      durationUs: 1_000_000,
    };
    const capture = createIsolatedCompositionCapture({
      visualProject: {
        ...visualProject(),
        assets: { 'video-asset': { id: 'video-asset', kind: 'video', displayName: 'Video' } },
      } as JoyProjectV1,
      timelineProject: activeVideoTimeline(clip),
      loadProjectAssetBlob: async () => new Blob(['video']),
    });
    vi.useFakeTimers();
    try {
      const operation = createCompositionObserver().capture(requestFor(capture));
      for (
        let attempt = 0;
        attempt < 20 && !mocks.openExportFrameSource.mock.calls.length;
        attempt++
      )
        await Promise.resolve();
      expect(mocks.openExportFrameSource).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(operation).resolves.toMatchObject({ status: 'captured' });
      finishOpen({
        close: lateClose,
        size: () => ({ width: 4, height: 4 }),
        frameAt: async () => undefined,
      });
      await Promise.resolve();
      expect(lateClose).toHaveBeenCalledOnce();
    } finally {
      capture.release();
      vi.useRealTimers();
    }
  });

  it('fails closed when a seek resolves before the video frame is ready', async () => {
    stubObjectUrls();
    const renderer = fakeRenderer();
    mocks.seekDetachedVideo.mockImplementationOnce(async (video) => {
      Object.defineProperty(video, 'readyState', { configurable: true, value: 1 });
    });
    const clip: VideoClip = {
      id: 'reverse-clip',
      kind: 'video',
      assetId: 'video-asset',
      sourceInUs: 0,
      startUs: 0,
      durationUs: 1_000_000,
      reversed: true,
    };
    const capture = createIsolatedCompositionCapture({
      visualProject: {
        ...visualProject(),
        assets: { 'video-asset': { id: 'video-asset', kind: 'video', displayName: 'Video' } },
      } as JoyProjectV1,
      timelineProject: activeVideoTimeline(clip),
      loadProjectAssetBlob: async () => new Blob(['video']),
    });
    try {
      await expect(createCompositionObserver().capture(requestFor(capture))).resolves.toMatchObject(
        {
          status: 'failed',
        },
      );
      expect(renderer.readPixels).not.toHaveBeenCalled();
    } finally {
      capture.release();
    }
  });

  it('fails a reversed frame when its detached seek rejects', async () => {
    stubObjectUrls();
    const renderer = fakeRenderer();
    mocks.seekDetachedVideo.mockRejectedValueOnce(new Error('seeking video timed out'));
    const clip: VideoClip = {
      id: 'reverse-clip',
      kind: 'video',
      assetId: 'video-asset',
      sourceInUs: 0,
      startUs: 0,
      durationUs: 1_000_000,
      reversed: true,
    };
    const project = {
      ...visualProject(),
      assets: { 'video-asset': { id: 'video-asset', kind: 'video', displayName: 'Video' } },
    } as JoyProjectV1;
    const capture = createIsolatedCompositionCapture({
      visualProject: project,
      timelineProject: activeVideoTimeline(clip),
      loadProjectAssetBlob: async () => new Blob(['video']),
    });
    try {
      await expect(createCompositionObserver().capture(requestFor(capture))).resolves.toMatchObject(
        {
          status: 'failed',
        },
      );
      expect(renderer.readPixels).not.toHaveBeenCalled();
    } finally {
      capture.release();
    }
  });

  it('copies video transform, grade, and effects from the export clip-spec glue', () => {
    const clip: VideoClip = {
      id: 'video-clip',
      kind: 'video',
      assetId: 'video-asset',
      sourceInUs: 0,
      startUs: 0,
      durationUs: 1_000_000,
    };
    const object: VisualObjectV1 = {
      id: 'video-object',
      kind: 'null',
      transform: transform({ x: 12, y: 7, scaleX: 2, scaleY: 3, opacity: 0.75 }),
      effects: [
        { id: 'effect-1', effectId: 'fixture-effect', enabled: true, params: { amount: 0.25 } },
      ],
    };
    const grade = createIdentityColorGrade();
    const project = {
      ...visualProject({ 'video-object': object }),
      assets: { 'video-asset': { id: 'video-asset', kind: 'video', displayName: 'Video' } },
      clipColorGrades: {
        'video-clip': { ...grade, adjust: { ...grade.adjust, saturation: 0.5 } },
      },
      pluginData: { 'joy.clipObjects': { 'video-clip': 'video-object' } },
    } as unknown as JoyProjectV1;
    const timeline = {
      rootCompositionId: 'root',
      compositions: { root: { tracks: [{ clips: [clip] }] } },
    } as unknown as SpikeProject;

    const node = videoFrameNodeFromDecoded(videoClipSpecAt(project, timeline, clip, 0, 4), {
      assetId: clip.assetId,
      sourceTimeUs: 0,
      token: 'fixture-frame',
      bitmap: { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) },
    });
    expect(node).toMatchObject({
      id: 'video-clip',
      transform: { translateX: 12, translateY: 7, scaleX: 2, scaleY: 3 },
      opacity: 0.75,
      colorGrade: { saturation: 0.5 },
      effects: [{ id: 'effect-1', kind: 'fixture-effect', params: { amount: 0.25 } }],
    });
  });
});
