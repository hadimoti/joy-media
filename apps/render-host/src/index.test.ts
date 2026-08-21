import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CAPTION_BURN_IN_KEY, createRenderBundle } from '@joy-media/render-planner';
import type {
  JoyProjectV1,
  SpikeProject,
  VisualObjectTransformV1,
} from '@joy-media/project-schema';
import {
  collectFrameInputsForExport,
  createPinnedOfflineRenderHostDriver,
  renderBundleFrames,
  renderHostAudioPcmForTest,
  type RenderHostMediaResolver,
} from './index.js';
import * as renderPage from './render-page.js';

const SECOND = 1_000_000;
const THIS_FILE = fileURLToPath(import.meta.url);

describe('render-host media execution', () => {
  it('resolves planned video, still, html, and audio inputs for every exported frame', async () => {
    const reads: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-resolve-'));
    const videoA = join(directory, 'video-a.bin');
    const imageA = join(directory, 'image-a.bin');
    writeFileSync(videoA, Buffer.from('video-content-a'));
    writeFileSync(imageA, Buffer.from('image-content-a'));
    const resolver: RenderHostMediaResolver = {
      require(opaqueRef) {
        reads.push(opaqueRef);
        if (opaqueRef.startsWith('html-scene:')) {
          return { kind: 'html-scene', packageId: opaqueRef.slice('html-scene:'.length) };
        }
        return { kind: 'file', path: opaqueRef === 'asset:image-a' ? imageA : videoA };
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

  it('uses resolved media file contents when producing frame pixels', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-content-'));
    const videoA = join(directory, 'video-a.bin');
    const imageA = join(directory, 'image-a.bin');
    writeFileSync(videoA, Buffer.from('video-content-a'));
    writeFileSync(imageA, Buffer.from('image-content-a'));
    const resolver: RenderHostMediaResolver = {
      require(opaqueRef) {
        if (opaqueRef === 'asset:image-a') return { kind: 'file', path: imageA };
        if (opaqueRef.startsWith('html-scene:'))
          return { kind: 'html-scene', packageId: 'joy.firstparty.title' };
        return { kind: 'file', path: videoA };
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

    writeFileSync(videoA, Buffer.from('video-content-b'));
    writeFileSync(imageA, Buffer.from('image-content-b'));
    const [changed] = await collectAsync(
      renderBundleFrames(bundle, 1, undefined, { mediaResolver: resolver }),
    );
    expect(changed).toBeDefined();
    expect(changed).not.toEqual(first);
  });

  it('uses resolved media file contents when producing audio PCM', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-audio-'));
    const videoA = join(directory, 'video-a.bin');
    writeFileSync(videoA, Buffer.from('audio-content-a'));
    const resolver: RenderHostMediaResolver = {
      require(opaqueRef) {
        if (opaqueRef === 'asset:image-a') return { kind: 'file', path: videoA };
        if (opaqueRef.startsWith('html-scene:'))
          return { kind: 'html-scene', packageId: 'joy.firstparty.title' };
        return { kind: 'file', path: videoA };
      },
      describe(opaqueRef) {
        return { opaqueRef };
      },
    };
    const bundle = renderBundle();
    const [first] = await collectAsync(
      renderHostAudioPcmForTest(
        collectFrameInputsForExport({ bundle, mediaResolver: resolver, frameCount: 1 }),
      ),
    );

    writeFileSync(videoA, Buffer.from('audio-content-b'));
    const [changed] = await collectAsync(
      renderHostAudioPcmForTest(
        collectFrameInputsForExport({ bundle, mediaResolver: resolver, frameCount: 1 }),
      ),
    );

    expect(first).toBeDefined();
    expect(changed).toBeDefined();
    expect(changed).not.toEqual(first);
  });

  it('fails when a planned capture input cannot be resolved', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-missing-'));
    const videoA = join(directory, 'video-a.bin');
    writeFileSync(videoA, Buffer.from('video-content-a'));
    const resolver: RenderHostMediaResolver = {
      require(opaqueRef) {
        if (opaqueRef === 'asset:image-a') throw new Error('missing sticker');
        if (opaqueRef.startsWith('html-scene:'))
          return { kind: 'html-scene', packageId: 'joy.firstparty.title' };
        return { kind: 'file', path: videoA };
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

  it('fails closed when resolved file content is missing at render time', async () => {
    const resolver: RenderHostMediaResolver = {
      require(opaqueRef) {
        if (opaqueRef.startsWith('html-scene:'))
          return { kind: 'html-scene', packageId: 'joy.firstparty.title' };
        return { kind: 'file', path: 'C:\\private\\missing-media.bin' };
      },
      describe(opaqueRef) {
        return { opaqueRef };
      },
    };

    await expect(
      collectAsync(renderBundleFrames(renderBundle(), 1, undefined, { mediaResolver: resolver })),
    ).rejects.toThrow(/resolved media content is unavailable/);
  });

  it('default driver crosses the offline render-page transport boundary', async () => {
    const calls: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-driver-'));
    const outputPath = join(directory, 'driver-output.mp4');
    const spy = vi.spyOn(renderPage, 'createOfflineRenderHostTransport');
    const driver = createPinnedOfflineRenderHostDriver();
    const request = {
      protocolVersion: 1 as const,
      bundle: renderBundle(),
      outputPath,
      mediaResolver: {
        require(opaqueRef: string) {
          calls.push(opaqueRef);
          if (opaqueRef.startsWith('html-scene:'))
            return { kind: 'html-scene' as const, packageId: 'joy.firstparty.title' };
          return { kind: 'file' as const, path: THIS_FILE };
        },
        describe(opaqueRef: string) {
          return { opaqueRef };
        },
      },
      frameLimit: 1,
    };

    const result = await driver.export(request);

    expect(spy).toHaveBeenCalled();
    expect(result).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    expect(JSON.stringify(result)).not.toContain(outputPath);
    expect(calls).toEqual(expect.arrayContaining(['asset:video-a', 'asset:image-a']));
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
