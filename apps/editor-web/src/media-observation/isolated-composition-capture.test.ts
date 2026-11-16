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
import { createCompositionObserver } from './composition-observer.js';

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
vi.mock('../export-preload.js', () => ({
  loadDetachedVideo: mocks.loadDetachedVideo,
  seekDetachedVideo: mocks.seekDetachedVideo,
}));
vi.mock('../export-frame-source.js', () => ({
  openExportFrameSource: mocks.openExportFrameSource,
}));
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
  mocks.createDecoder.mockClear();
  mocks.waitFonts.mockReset().mockResolvedValue(undefined);
});

describe('isolated composition capture', () => {
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
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('decode failed');
      }),
    );
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
        { status: 'failed' },
      );
    } finally {
      capture.release();
    }
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
      expect(renderer.render).toHaveBeenCalledTimes(1);
      expect(frame.nodes.find((node) => node.id === 'video-clip')?.colorGrade).toMatchObject({
        saturation: 0.4,
      });
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
    const capture = createIsolatedCompositionCapture({
      visualProject: project,
      timelineProject: activeVideoTimeline(clip),
      loadProjectAssetBlob: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) as Blob,
    });
    try {
      const result = await createCompositionObserver().capture(requestFor(capture));
      expect(result.status, JSON.stringify(result)).toBe('captured');
      expect(mocks.seekDetachedVideo).toHaveBeenCalledWith(expect.anything(), 0, expect.anything());
      const bitmaps = renderer.render.mock.calls[0]?.[1] as Map<
        string,
        { data: Uint8ClampedArray }
      >;
      expect(bitmaps.get('reverse-clip')?.data).toEqual(new Uint8ClampedArray(4 * 4 * 4).fill(90));
    } finally {
      capture.release();
    }
  });

  it('reuses an active clip decoder and closes it after samples pass the clip end', async () => {
    stubObjectUrls();
    fakeRenderer();
    const closeForward = vi.fn();
    mocks.openExportFrameSource.mockResolvedValue({
      frameAt: vi.fn(async () => undefined),
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
          outputTimesUs: [0, 50_000, 200_000],
        }),
      ).resolves.toMatchObject({ status: 'captured', frames: [{}, {}, {}] });
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
      expect(mocks.createDecoder).toHaveBeenCalledTimes(1);
      expect(mocks.seekDetachedVideo).toHaveBeenCalledTimes(2);
      expect(closeForward).toHaveBeenCalledTimes(1);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:capture-fixture');
    } finally {
      capture.release();
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

  it('fails a reversed frame when its detached seek times out', async () => {
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
