import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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

    const inputs = await collectFrameInputsForExport({
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
        await collectFrameInputsForExport({ bundle, mediaResolver: resolver, frameCount: 1 }),
      ),
    );

    writeFileSync(videoA, Buffer.from('audio-content-b'));
    const [changed] = await collectAsync(
      renderHostAudioPcmForTest(
        await collectFrameInputsForExport({ bundle, mediaResolver: resolver, frameCount: 1 }),
      ),
    );

    expect(first).toBeDefined();
    expect(changed).toBeDefined();
    expect(changed).not.toEqual(first);
  });

  it('streams media content in bounded chunks and resolves frames incrementally', async () => {
    const calls: string[] = [];
    const chunkSizes: number[] = [];
    const opened: Record<string, number> = {};
    const largePayload = new Uint8Array(1024 * 1024 + 17).fill(0x5a);
    const resolver: RenderHostMediaResolver = {
      require(opaqueRef) {
        calls.push(opaqueRef);
        if (opaqueRef.startsWith('html-scene:'))
          return { kind: 'html-scene', packageId: 'joy.firstparty.title' };
        return {
          kind: 'stream',
          async *open() {
            opened[opaqueRef] = (opened[opaqueRef] ?? 0) + 1;
            for (let offset = 0; offset < largePayload.length; offset += 16 * 1024) {
              const chunk = largePayload.slice(offset, offset + 16 * 1024);
              chunkSizes.push(chunk.length);
              yield chunk;
            }
          },
        } as ReturnType<RenderHostMediaResolver['require']>;
      },
      describe(opaqueRef) {
        return { opaqueRef };
      },
    };

    const iterator = renderBundleFrames(renderBundle(), 4, undefined, {
      mediaResolver: resolver,
    })[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.done).toBe(false);
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(16 * 1024);

    const remaining: Uint8Array[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      remaining.push(next.value);
    }
    expect(remaining).toHaveLength(3);
    expect(opened).toEqual({ 'asset:video-a': 1, 'asset:image-a': 1 });
  });

  it('fails when a planned capture input cannot be resolved', async () => {
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

    await expect(
      collectFrameInputsForExport({
        bundle: renderBundle(),
        mediaResolver: resolver,
        frameCount: 1,
      }),
    ).rejects.toThrow(/image-a/);
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

  it('fails closed instead of verifying a synthetic export for unsupported scene inputs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-driver-'));
    const outputPath = join(directory, 'driver-output.mp4');
    const driver = createPinnedOfflineRenderHostDriver();
    const request = {
      protocolVersion: 1 as const,
      bundle: renderBundle(),
      outputPath,
      mediaResolver: {
        require(opaqueRef: string) {
          if (opaqueRef.startsWith('html-scene:'))
            return { kind: 'html-scene' as const, packageId: 'joy.firstparty.title' };
          return { kind: 'file' as const, path: THIS_FILE };
        },
        describe(opaqueRef: string) {
          return { opaqueRef };
        },
      },
    };

    await expect(driver.export(request)).rejects.toThrow(/source-backed export is unavailable/);
    expect(() => readFileSync(outputPath)).toThrow();
  });

  it('decodes a contiguous file-backed clip and preserves its source picture', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-source-'));
    const sourcePath = join(directory, 'source.mp4');
    const outputPath = join(directory, 'source-output.mp4');
    const generated = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=64x36:r=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:sample_rate=48000',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        sourcePath,
      ],
      { shell: false, encoding: 'utf8' },
    );
    expect(generated.status).toBe(0);
    const driver = createPinnedOfflineRenderHostDriver();
    const result = await driver.export({
      protocolVersion: 1,
      bundle: sourceBackedBundle(),
      outputPath,
      mediaResolver: {
        require() {
          return { kind: 'file' as const, path: sourcePath };
        },
        describe(opaqueRef) {
          return { opaqueRef };
        },
      },
    });
    expect(result).toMatchObject({ frames: 30, videoCodec: 'h264', audioCodec: 'aac' });
    const frame = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        outputPath,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ],
      { shell: false },
    );
    expect(frame.status).toBe(0);
    const pixels = frame.stdout as Buffer;
    const red = pixels.reduce((sum, value, index) => (index % 3 === 0 ? sum + value : sum), 0);
    const green = pixels.reduce((sum, value, index) => (index % 3 === 1 ? sum + value : sum), 0);
    expect(red / (pixels.length / 3)).toBeGreaterThan(180);
    expect(green / (pixels.length / 3)).toBeLessThan(80);
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

function sourceBackedBundle() {
  const bundle = renderBundle();
  const timeline = bundle.timelineProject.compositions.root!;
  const visual = bundle.visualProject.compositions.root!;
  return {
    ...bundle,
    timelineProject: {
      ...bundle.timelineProject,
      compositions: {
        root: {
          ...timeline,
          durationUs: SECOND,
          tracks: timeline.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((clip) => ({ ...clip, durationUs: SECOND, sourceInUs: 0 })),
          })),
        },
      },
    },
    visualProject: {
      ...bundle.visualProject,
      compositions: {
        root: { ...visual, durationUs: SECOND },
      },
      visualObjects: {},
      captionDocuments: {},
      pluginData: {},
      transitions: [],
    },
  };
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
