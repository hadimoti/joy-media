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
}));

vi.mock('@joy-media/renderer-pixi/browser', () => ({
  createBrowserPixiRenderer: mocks.createRenderer,
}));
vi.mock('../font-readiness.js', () => ({ waitForContentFonts: mocks.waitFonts }));

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
    render: vi.fn(() => {
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.createRenderer.mockReset();
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

  it('does not produce a frame when an image decode fails', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('decode failed');
      }),
    );
    const renderer = fakeRenderer();
    const image: VisualObjectV1 = {
      id: 'image',
      kind: 'image',
      assetId: 'image-asset',
      transform: transform(),
    };
    const project = {
      ...visualProject({ image }),
      assets: { 'image-asset': { id: 'image-asset', kind: 'image', displayName: 'Still' } },
    } as JoyProjectV1;
    const capture = createIsolatedCompositionCapture({
      visualProject: project,
      timelineProject: timelineProject(),
      loadProjectAssetBlob: async () => new Blob(['image']),
    });
    try {
      await expect(createCompositionObserver().capture(requestFor(capture))).resolves.toMatchObject(
        { status: 'failed', code: 'evaluator-failed' },
      );
    } finally {
      capture.release();
    }
    expect(renderer.readPixels).not.toHaveBeenCalled();
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
