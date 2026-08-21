import { describe, expect, it } from 'vitest';
import { CAPTION_BURN_IN_KEY, createRenderBundle } from '@joy-media/render-planner';
import type {
  JoyProjectV1,
  SpikeProject,
  VisualObjectTransformV1,
} from '@joy-media/project-schema';
import {
  collectFrameInputsForExport,
  renderBundleFrames,
  type RenderHostMediaResolver,
} from './index.js';

const SECOND = 1_000_000;

describe('render-host media execution', () => {
  it('resolves planned video, still, html, and audio inputs for every exported frame', async () => {
    const reads: string[] = [];
    const resolver: RenderHostMediaResolver = {
      require(opaqueRef) {
        reads.push(opaqueRef);
        if (opaqueRef.startsWith('html-scene:')) {
          return { kind: 'html-scene', packageId: opaqueRef.slice('html-scene:'.length) };
        }
        return { kind: 'file', path: `C:\\private\\${opaqueRef.replace(/[^A-Za-z0-9._-]/g, '-')}` };
      },
      describe(opaqueRef) {
        return { opaqueRef };
      },
    };

    const inputs = collectFrameInputsForExport({
      bundle: renderBundle(),
      mediaResolver: resolver,
      frameCount: 2,
    });

    expect(
      inputs.flatMap((input) => input.videoSamples.map((sample) => sample.media.opaqueRef)),
    ).toEqual(['asset:video-a', 'asset:video-a']);
    expect(
      inputs.flatMap((input) => input.stillBitmaps.map((sample) => sample.media.opaqueRef)),
    ).toEqual(['asset:image-a', 'asset:image-a']);
    expect(
      inputs.flatMap((input) => input.htmlScenes.map((sample) => sample.media.opaqueRef)),
    ).toEqual(['html-scene:joy.firstparty.title', 'html-scene:joy.firstparty.title']);
    expect(
      inputs.flatMap((input) => input.audioSamples.map((sample) => sample.media.opaqueRef)),
    ).toEqual(['asset:video-a', 'asset:video-a']);
    expect(reads).toEqual(
      expect.arrayContaining(['asset:video-a', 'asset:image-a', 'html-scene:joy.firstparty.title']),
    );
  });

  it('uses resolved media inputs when producing frame pixels', async () => {
    const resolver: RenderHostMediaResolver = {
      require(opaqueRef) {
        if (opaqueRef === 'asset:image-a')
          return { kind: 'file', path: 'C:\\private\\sticker-a.png' };
        if (opaqueRef.startsWith('html-scene:'))
          return { kind: 'html-scene', packageId: 'joy.firstparty.title' };
        return { kind: 'file', path: 'C:\\private\\video-a.mp4' };
      },
      describe(opaqueRef) {
        return { opaqueRef };
      },
    };

    const bundle = renderBundle();
    const [first, second] = await collectAsync(
      renderBundleFrames(bundle, 2, undefined, { mediaResolver: resolver }),
    );

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toEqual(second);
  });

  it('fails when a planned capture input cannot be resolved', () => {
    const resolver: RenderHostMediaResolver = {
      require(opaqueRef) {
        if (opaqueRef === 'asset:image-a') throw new Error('missing sticker');
        if (opaqueRef.startsWith('html-scene:'))
          return { kind: 'html-scene', packageId: 'joy.firstparty.title' };
        return { kind: 'file', path: 'C:\\private\\video-a.mp4' };
      },
      describe(opaqueRef) {
        return { opaqueRef };
      },
    };

    expect(() =>
      collectFrameInputsForExport({
        bundle: renderBundle(),
        mediaResolver: resolver,
        frameCount: 1,
      }),
    ).toThrow(/image-a/);
  });
});

async function collectAsync<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

function renderBundle() {
  return createRenderBundle({
    timelineProject: timelineProject(),
    visualProject: visualProject(),
    outputPreset: 'social-h264-aac',
    seed: 'render-host-test',
  });
}

function timelineProject(): SpikeProject {
  return {
    schemaVersion: 0,
    id: 'timeline',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 64,
        height: 36,
        frameRate: { num: 30, den: 1 },
        durationUs: 2 * SECOND,
        tracks: [
          {
            id: 'track-1',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-a',
                startUs: 0,
                durationUs: SECOND,
                assetId: 'video-a',
                sourceInUs: 5 * SECOND,
              },
            ],
          },
        ],
      },
    },
  };
}

function visualProject(): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id: 'visual',
    title: 'Visual',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 64,
        height: 36,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 2 * SECOND,
        background: '#000000',
        tracks: [
          {
            id: 'caption-track',
            kind: 'caption',
            name: 'Captions',
            order: 0,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'caption-1',
                kind: 'caption',
                startUs: 0,
                durationUs: SECOND,
                captionDocumentId: 'doc-1',
              },
            ],
          },
          {
            id: 'video-track',
            kind: 'video',
            name: 'Video',
            order: 1,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'clip-a',
                kind: 'video',
                startUs: 0,
                durationUs: SECOND,
                assetId: 'video-a',
                sourceInUs: 5 * SECOND,
              },
            ],
          },
        ],
      },
    },
    assets: {
      'video-a': { id: 'video-a', kind: 'video', displayName: 'Moving timecode' },
      'image-a': { id: 'image-a', kind: 'image', displayName: 'Sticker' },
    },
    variables: {},
    markers: [],
    visualObjects: {
      sticker: {
        id: 'sticker',
        kind: 'image',
        assetId: 'image-a',
        transform: transform(4, 4),
      },
      scene: {
        id: 'scene',
        kind: 'html-scene',
        scenePackageId: 'joy.firstparty.title',
        transform: transform(16, 10),
      },
    },
    captionDocuments: {
      'doc-1': {
        id: 'doc-1',
        language: 'en',
        direction: 'ltr',
        speakers: [],
        words: { w1: { id: 'w1', text: 'Caption', startUs: 0, endUs: SECOND } },
        segments: [{ id: 's1', startUs: 0, endUs: SECOND, wordIds: ['w1'] }],
      },
    },
    pluginData: { [CAPTION_BURN_IN_KEY]: true },
    audio: {
      clips: { 'clip-a': { gain: 0.75, pan: -0.2, mute: false, solo: false } },
      buses: [],
      effects: [],
    },
  };
}

function transform(x: number, y: number): VisualObjectTransformV1 {
  return {
    x,
    y,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  };
}
