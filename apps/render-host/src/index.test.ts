import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPTION_BURN_IN_KEY,
  bundleDigestV2,
  captionBurnInDigestV2,
  createRenderBundle,
  createRenderBundleV2,
  canonicalJsonV2,
  planDigestV2,
  preflightCompositionPlanV2,
  sha256HexV2,
  type CompositionPlanV2,
} from '@joy-media/render-planner';
import type {
  JoyProjectV1,
  SpikeProject,
  VisualObjectTransformV1,
} from '@joy-media/project-schema';
import type { MotionSceneDocument } from '../../../packages/motion-core/src/scene.js';
import {
  collectFrameInputsForExport,
  createPinnedOfflineRenderHostDriver,
  renderBundleToFile,
  renderBundleFrames,
  renderHostAudioPcmForTest,
  verifyRenderBundleV2Assets,
  type RenderHostMediaResolver,
} from './index.js';

const SECOND = 1_000_000;
const THIS_FILE = fileURLToPath(import.meta.url);

describe('render-host media execution', () => {
  it.each([
    ['video', { kind: 'video', crop: { left: 0.1, top: 0, right: 0, bottom: 0 } }],
    ['text', { kind: 'text', crop: { left: 0.1, top: 0, right: 0, bottom: 0 } }],
    ['negative', { kind: 'image', crop: { left: -0.1, top: 0, right: 0, bottom: 0 } }],
    ['nonfinite', { kind: 'image', crop: { left: Number.NaN, top: 0, right: 0, bottom: 0 } }],
    ['depth', { kind: 'image', positionZ: 1, crop: { left: 0.1, top: 0, right: 0, bottom: 0 } }],
    [
      'effect',
      { kind: 'image', effects: [], effect: {}, crop: { left: 0.1, top: 0, right: 0, bottom: 0 } },
    ],
    [
      'animated',
      { kind: 'image', animations: {}, crop: { left: 0.1, top: 0, right: 0, bottom: 0 } },
    ],
  ])('preflight rejects V2 %s crop combinations', (_label, patch) => {
    const layer = {
      id: 'image',
      assetId: 'image',
      startUs: 0,
      durationUs: 1_000_000,
      zIndex: 1,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      ...(patch as object),
    } as CompositionPlanV2['layers'][number];
    const plan: CompositionPlanV2 = {
      version: 2,
      composition: { id: 'c', width: 1, height: 1 },
      viewport: { width: 1, height: 1 },
      frameRate: { num: 30, den: 1 },
      durationUs: 1_000_000,
      background: '#000',
      layers: [layer],
      audio: [],
      outputPreset: 'preview',
      planSha256: '',
    };
    expect(preflightCompositionPlanV2(plan)).toMatchObject({ allowed: false });
  });

  it.each(['video', 'text', 'html-scene', 'motion-scene'] as const)(
    'fails before export for non-image V2 %s effects',
    async (kind) => {
      const effect = {
        id: 'e',
        effectId: 'brightness-contrast',
        enabled: true,
        params: { brightness: 0, contrast: 0 },
      };
      const unsigned = {
        version: 2,
        composition: { id: 'c', width: 1, height: 1 },
        viewport: { width: 1, height: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 1_000_000,
        background: '#000000',
        layers: [
          {
            id: kind,
            kind,
            assetId: kind,
            ...(kind === 'text'
              ? {
                  text: 'x',
                  bitmapAssetId: 'bitmap',
                  fontId: 'system-ui',
                  sourceSha256: 'a'.repeat(64),
                }
              : {}),
            startUs: 0,
            durationUs: 1_000_000,
            zIndex: 1,
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
            effects: [effect],
          },
        ],
        audio: [],
        outputPreset: 'preview',
        planSha256: '',
      } as unknown as CompositionPlanV2;
      (unsigned as unknown as { planSha256: string }).planSha256 = planDigestV2(unsigned);
      const bundleBase = {
        version: 2 as const,
        plan: unsigned,
        assets: {
          [kind]: {
            assetId: kind,
            opaqueRef: `asset:${kind}`,
            integrity: { sha256: 'a'.repeat(64), bytes: 1, mime: 'image/png' },
          },
        },
        snapshot: {
          projectRef: 'p',
          revision: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          planSha256: unsigned.planSha256,
          bundleSha256: '',
        },
      };
      bundleBase.snapshot.bundleSha256 = bundleDigestV2(bundleBase);
      await expect(
        verifyRenderBundleV2Assets(bundleBase, {
          require() {
            throw new Error('resolver must not be called');
          },
          describe() {
            return { opaqueRef: 'unused' };
          },
        }),
      ).rejects.toThrow(/static image|Effects/);
    },
  );

  it('renders V2 static image crop from source pixels before scale and rotation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-crop-v2-'));
    const sourcePath = join(directory, 'source.mp4');
    const imagePath = join(directory, 'two-color.png');
    const outputPath = join(directory, 'cropped.mp4');
    expect(
      spawnSync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=black:s=32x24:r=30',
          '-t',
          '0.2',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          sourcePath,
        ],
        { shell: false },
      ).status,
    ).toBe(0);
    expect(
      spawnSync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=red:s=8x4',
          '-vf',
          'drawbox=x=2:y=0:w=6:h=4:color=blue:t=fill',
          '-frames:v',
          '1',
          imagePath,
        ],
        { shell: false },
      ).status,
    ).toBe(0);
    const bundle = cropV2Bundle(
      sourcePath,
      imagePath,
      { left: 0.25, top: 0, right: 0, bottom: 0 },
      { x: 16, y: 12, scaleX: 2, scaleY: 2, rotationDeg: 90 },
    );
    await renderBundleToFile({
      protocolVersion: 1,
      bundle,
      outputPath,
      mediaResolver: cropResolver(sourcePath, imagePath),
    });
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
    ).stdout as Buffer;
    expect(frame.length).toBe(32 * 24 * 3);
    let redPixels = 0;
    let bluePixels = 0;
    for (let offset = 0; offset < frame.length; offset += 3) {
      if (frame[offset]! > frame[offset + 2]! + 30) redPixels++;
      if (frame[offset + 2]! > frame[offset]! + 30) bluePixels++;
    }
    expect(redPixels).toBe(0);
    expect(bluePixels).toBeGreaterThan(20);
  });

  it('preserves the V2 zero-crop image pixels', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-crop-zero-v2-'));
    const sourcePath = join(directory, 'source.mp4');
    const imagePath = join(directory, 'two-color.png');
    const outputPath = join(directory, 'zero-crop.mp4');
    expect(
      spawnSync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=black:s=32x24:r=30',
          '-t',
          '0.2',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          sourcePath,
        ],
        { shell: false },
      ).status,
    ).toBe(0);
    expect(
      spawnSync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=red:s=8x4',
          '-vf',
          'drawbox=x=2:y=0:w=6:h=4:color=blue:t=fill',
          '-frames:v',
          '1',
          imagePath,
        ],
        { shell: false },
      ).status,
    ).toBe(0);
    const bundle = cropV2Bundle(
      sourcePath,
      imagePath,
      { left: 0, top: 0, right: 0, bottom: 0 },
      { x: 0, y: 0, scaleX: 1, scaleY: 1 },
    );
    await renderBundleToFile({
      protocolVersion: 1,
      bundle,
      outputPath,
      mediaResolver: cropResolver(sourcePath, imagePath),
    });
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
    ).stdout as Buffer;
    expect(frame[(1 * 32 + 1) * 3]!).toBeGreaterThan(150);
    expect(frame[(1 * 32 + 6) * 3 + 2]!).toBeGreaterThan(120);
  });

  it('renders a verified static Motion title bitmap into decoded MP4 pixels', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-title-v2-'));
    const sourcePath = join(directory, 'source.mp4');
    const bitmapPath = join(directory, 'title.png');
    const outputPath = join(directory, 'title.mp4');
    expect(
      spawnSync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=red:s=32x32:r=30',
          '-t',
          '0.2',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          sourcePath,
        ],
        { shell: false },
      ).status,
    ).toBe(0);
    expect(
      spawnSync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=green:s=8x8',
          '-frames:v',
          '1',
          bitmapPath,
        ],
        { shell: false },
      ).status,
    ).toBe(0);
    const sourceBytes = readFileSync(sourcePath);
    const bitmapBytes = readFileSync(bitmapPath);
    const sourceSha = createHash('sha256').update(sourceBytes).digest('hex');
    const bitmapSha = createHash('sha256').update(bitmapBytes).digest('hex');
    const titleSourceSha = 'c'.repeat(64);
    const base = {
      version: 2,
      composition: { id: 'comp', width: 32, height: 32 },
      viewport: { width: 32, height: 32 },
      frameRate: { num: 30, den: 1 },
      durationUs: 200_000,
      background: '#000000',
      layers: [
        {
          id: 'video',
          kind: 'video',
          assetId: 'video',
          startUs: 0,
          durationUs: 200_000,
          sourceInUs: 0,
          playbackRate: 1,
          zIndex: 0,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
        {
          id: 'title',
          kind: 'text',
          text: 'JOY',
          bitmapAssetId: 'title-bitmap',
          fontId: 'falsafeh-light',
          sourceSha256: titleSourceSha,
          startUs: 0,
          durationUs: 200_000,
          zIndex: 10,
          x: 12,
          y: 12,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
      ],
      audio: [],
      outputPreset: 'preview',
      planSha256: '',
    } as CompositionPlanV2;
    const bundle = createRenderBundleV2({
      plan: { ...base, planSha256: planDigestV2(base) },
      projectRef: 'title-e2e',
      assets: {
        video: {
          assetId: 'video',
          opaqueRef: 'asset:video',
          integrity: { sha256: sourceSha, bytes: sourceBytes.length, mime: 'video/mp4' },
        },
        'title-bitmap': {
          assetId: 'title-bitmap',
          opaqueRef: 'asset:title-bitmap',
          integrity: { sha256: bitmapSha, bytes: bitmapBytes.length, mime: 'image/png' },
          textBitmap: {
            sourceSha256: titleSourceSha,
            width: 8,
            height: 8,
            fontId: 'falsafeh-light',
          },
        },
      },
    });
    const resolver = {
      require(ref: string) {
        return { kind: 'file' as const, path: ref === 'asset:video' ? sourcePath : bitmapPath };
      },
      describe(opaqueRef: string) {
        return { opaqueRef };
      },
    };
    await renderBundleToFile({ protocolVersion: 1, bundle, outputPath, mediaResolver: resolver });
    const decoded = spawnSync(
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
    ).stdout as Buffer;
    expect(decoded.length).toBe(32 * 32 * 3);
    const center = (16 * 32 + 16) * 3;
    expect(decoded[center + 1]).toBeGreaterThan(decoded[center]! + 20);
  });

  it.each([
    [
      'missing bitmap binding',
      (base: Record<string, unknown>) => {
        delete (base.layers as Array<Record<string, unknown>>)[0]!.bitmapAssetId;
      },
      /bitmap|pre-rasterized/,
    ],
    [
      'unallowlisted font',
      (base: Record<string, unknown>) => {
        (base.layers as Array<Record<string, unknown>>)[0]!.fontId = 'Comic Sans';
      },
      /allowlist|unsupported pinned font/,
    ],
    [
      'source hash mismatch',
      (base: Record<string, unknown>) => {
        (base.layers as Array<Record<string, unknown>>)[0]!.sourceSha256 = 'd'.repeat(64);
      },
      /metadata mismatch/,
    ],
    ['bitmap dimension mismatch', (_base: Record<string, unknown>) => {}, /dimensions/],
  ])('fails before export for V2 title %s', async (_label, mutate, error) => {
    const base = {
      version: 2,
      composition: { id: 'c', width: 1, height: 1 },
      viewport: { width: 1, height: 1 },
      frameRate: { num: 30, den: 1 },
      durationUs: 1_000_000,
      background: '#000',
      layers: [
        {
          id: 'title',
          kind: 'text',
          text: 'JOY',
          bitmapAssetId: 'bitmap',
          fontId: 'falsafeh-light',
          sourceSha256: 'c'.repeat(64),
          startUs: 0,
          durationUs: 1_000_000,
          zIndex: 1,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
      ],
      audio: [],
      outputPreset: 'preview' as const,
    } as unknown as CompositionPlanV2;
    mutate(base as unknown as Record<string, unknown>);
    const plan = { ...base, planSha256: planDigestV2(base) };
    const binding = {
      assetId: 'bitmap',
      opaqueRef: 'asset:bitmap',
      integrity: { sha256: 'a'.repeat(64), bytes: 1, mime: 'image/png' },
      textBitmap: { sourceSha256: 'c'.repeat(64), width: 1, height: 1, fontId: 'falsafeh-light' },
    };
    if (_label === 'unallowlisted font')
      expect(() =>
        createRenderBundleV2({ plan, projectRef: 'negative', assets: { bitmap: binding } }),
      ).toThrow(error);
    else if (_label === 'missing bitmap binding')
      expect(() => createRenderBundleV2({ plan, projectRef: 'negative', assets: {} })).toThrow(
        error,
      );
    else if (_label === 'source hash mismatch')
      expect(() =>
        createRenderBundleV2({ plan, projectRef: 'negative', assets: { bitmap: binding } }),
      ).toThrow(error);
    else {
      const signed = createRenderBundleV2({
        plan,
        projectRef: 'negative',
        assets: { bitmap: binding },
      });
      await expect(
        verifyRenderBundleV2Assets(signed, {
          require: () => ({ kind: 'file', path: 'missing' }),
          describe: (opaqueRef) => ({ opaqueRef }),
        }),
      ).rejects.toThrow(/unavailable|dimensions/);
    }
  });
  it('sanitizes local paths when V2 resolved media is absent', async () => {
    const plan: CompositionPlanV2 = {
      version: 2,
      composition: { id: 'comp', width: 1, height: 1 },
      viewport: { width: 1, height: 1 },
      frameRate: { num: 30, den: 1 },
      durationUs: SECOND,
      background: '#000',
      layers: [],
      audio: [],
      outputPreset: 'preview',
      planSha256: '',
    };
    const signedPlan = { ...plan, planSha256: planDigestV2(plan) };
    const bundle = createRenderBundleV2({
      plan: signedPlan,
      projectRef: 'project',
      assets: {
        missing: {
          assetId: 'missing',
          opaqueRef: 'asset:missing',
          integrity: { sha256: 'a'.repeat(64), bytes: 12, mime: 'video/mp4' },
        },
      },
    });
    let message = '';
    try {
      await verifyRenderBundleV2Assets(bundle, {
        require: () => ({ kind: 'file', path: 'C:\\private\\secret.mp4' }),
        describe: () => ({ opaqueRef: 'asset:missing' }),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/unavailable/);
    expect(message).not.toMatch(/private|secret/);
  });

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

    await expect(driver.export(request)).rejects.toThrow(
      /source-backed (?:ffmpeg export failed|export artifact is missing|could not decode|export does not support)/i,
    );
    expect(() => readFileSync(outputPath)).toThrow();
  });

  it('fails closed for image rotation and crop instead of silently dropping them', async () => {
    const driver = createPinnedOfflineRenderHostDriver();
    const base = sourceBackedBundle();
    for (const [label, transformPatch] of [
      ['rotationDeg', { rotationDeg: 12 }],
      ['crop', { crop: { left: 1, top: 0, right: 0, bottom: 0 } }],
    ] as const) {
      const bundle = {
        ...base,
        visualProject: {
          ...base.visualProject,
          visualObjects: {
            image: {
              id: 'image',
              kind: 'image' as const,
              assetId: 'image-a',
              transform: { ...transform(4, 4), ...transformPatch },
            },
          },
        },
      };
      await expect(
        driver.export({
          protocolVersion: 1,
          bundle,
          outputPath: join(tmpdir(), `joy-media-invalid-${label}.mp4`),
          mediaResolver: {
            require() {
              throw new Error('resolver should not be reached');
            },
            describe(opaqueRef) {
              return { opaqueRef };
            },
          },
        }),
      ).rejects.toThrow(label);
    }
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
        '-ss',
        '0.5',
        '-v',
        'error',
        '-ss',
        '0.1',
        '-i',
        outputPath,
        '-vf',
        'select=eq(n\\,15)',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ],
      { shell: false, maxBuffer: 4 * 1024 * 1024 },
    );
    expect(frame.status).toBe(0);
    const pixels = frame.stdout as Buffer;
    const red = pixels.reduce((sum, value, index) => (index % 3 === 0 ? sum + value : sum), 0);
    const green = pixels.reduce((sum, value, index) => (index % 3 === 1 ? sum + value : sum), 0);
    expect(red / (pixels.length / 3)).toBeGreaterThan(180);
    expect(green / (pixels.length / 3)).toBeLessThan(80);
  });

  it('applies a V2 master grade once to zero-overlay source output with pixel proof', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-v2-grade-'));
    const sourcePath = join(directory, 'source.mp4');
    const identityPath = join(directory, 'identity.mp4');
    const gradedPath = join(directory, 'graded.mp4');
    const gradedRepeatPath = join(directory, 'graded-repeat.mp4');
    const source = spawnSync(
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
        '0.2',
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
    expect(source.status).toBe(0);
    const sourceBytes = readFileSync(sourcePath);
    const planBase: CompositionPlanV2 = {
      version: 2,
      composition: { id: 'comp', width: 64, height: 36 },
      viewport: { width: 64, height: 36 },
      frameRate: { num: 30, den: 1 },
      durationUs: 200_000,
      background: '#000000',
      layers: [
        {
          id: 'video',
          kind: 'video',
          assetId: 'video',
          startUs: 0,
          durationUs: 200_000,
          sourceInUs: 0,
          playbackRate: 1,
          zIndex: 0,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
      ],
      audio: [
        {
          id: 'audio:video',
          assetId: 'video',
          startUs: 0,
          durationUs: 200_000,
          sourceInUs: 0,
          gain: 1,
          pan: 0,
          mute: false,
        },
      ],
      outputPreset: 'preview',
      planSha256: '',
    };
    const makeBundle = (colorGrade?: CompositionPlanV2['colorGrade']) => {
      const unsigned = colorGrade === undefined ? planBase : { ...planBase, colorGrade };
      const signed = { ...unsigned, planSha256: planDigestV2(unsigned) };
      return createRenderBundleV2({
        plan: signed,
        projectRef: 'project',
        assets: {
          video: {
            assetId: 'video',
            opaqueRef: 'asset:video',
            integrity: {
              sha256: createHash('sha256').update(sourceBytes).digest('hex'),
              bytes: sourceBytes.length,
              mime: 'video/mp4',
            },
          },
        },
      });
    };
    const resolver: RenderHostMediaResolver = {
      require() {
        return { kind: 'file', path: sourcePath };
      },
      describe(opaqueRef) {
        return { opaqueRef };
      },
    };
    await renderBundleToFile({
      protocolVersion: 1,
      bundle: makeBundle(),
      outputPath: identityPath,
      mediaResolver: resolver,
    });
    const gradedBundle = makeBundle({ lift: 0, gamma: 1, gain: 0.65, saturation: 0.2 });
    const firstGraded = await renderBundleToFile({
      protocolVersion: 1,
      bundle: gradedBundle,
      outputPath: gradedPath,
      mediaResolver: resolver,
    });
    const secondGraded = await renderBundleToFile({
      protocolVersion: 1,
      bundle: gradedBundle,
      outputPath: gradedRepeatPath,
      mediaResolver: resolver,
    });
    expect(firstGraded.sha256).toBe(secondGraded.sha256);
    expect(firstGraded.sha256).not.toBe(
      createHash('sha256').update(readFileSync(identityPath)).digest('hex'),
    );
    const firstPixel = (path: string): [number, number, number] => {
      const frame = spawnSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          path,
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
      return [pixels[0]!, pixels[1]!, pixels[2]!];
    };
    const identityPixel = firstPixel(identityPath);
    const gradedPixel = firstPixel(gradedPath);
    expect(gradedPixel).not.toEqual(identityPixel);
    expect(gradedPixel[0]! + gradedPixel[1]! + gradedPixel[2]!).toBeLessThan(
      identityPixel[0]! + identityPixel[1]! + identityPixel[2]!,
    );
  });

  it('composites planned image and text overlays into the real source pixels', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-overlay-'));
    const sourcePath = join(directory, 'source.mp4');
    const imagePath = join(directory, 'overlay.png');
    const outputPath = join(directory, 'overlay-output.mp4');
    const source = spawnSync(
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
        '0.2',
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
    expect(source.status).toBe(0);
    const image = spawnSync(
      'ffmpeg',
      ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=8x8', '-frames:v', '1', imagePath],
      { shell: false, encoding: 'utf8' },
    );
    expect(image.status).toBe(0);

    const base = sourceBackedBundle();
    const visual = base.visualProject.compositions.root!;
    const bundle = {
      ...base,
      timelineProject: {
        ...base.timelineProject,
        compositions: {
          root: {
            ...base.timelineProject.compositions.root!,
            durationUs: 200_000,
            tracks: base.timelineProject.compositions.root!.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) => ({ ...clip, durationUs: 200_000 })),
            })),
          },
        },
      },
      assets: {
        ...base.assets,
        'image-a': {
          id: 'image-a',
          kind: 'image' as const,
          displayName: 'Overlay',
          opaqueRef: 'asset:image-a',
        },
      },
      visualProject: {
        ...base.visualProject,
        compositions: { root: { ...visual, durationUs: 200_000 } },
        visualObjects: {
          text: { id: 'text', kind: 'text' as const, text: 'JOY', transform: transform(20, 4) },
          image: {
            id: 'image',
            kind: 'image' as const,
            assetId: 'image-a',
            transform: transform(4, 4),
          },
        },
      },
    };
    const driver = createPinnedOfflineRenderHostDriver();
    const result = await driver.export({
      protocolVersion: 1,
      bundle,
      outputPath,
      mediaResolver: {
        require(opaqueRef) {
          return {
            kind: 'file' as const,
            path: opaqueRef === 'asset:image-a' ? imagePath : sourcePath,
          };
        },
        describe(opaqueRef) {
          return { opaqueRef };
        },
      },
    });
    expect(result).toMatchObject({ frames: 6, videoCodec: 'h264', audioCodec: 'aac' });
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
      { shell: false, maxBuffer: 4 * 1024 * 1024 },
    );
    expect(frame.status).toBe(0);
    const pixels = frame.stdout as Buffer;
    const at = (x: number, y: number): [number, number, number] => {
      const offset = (y * 64 + x) * 3;
      return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
    };
    const [red, green, blue] = at(6, 6);
    expect(blue).toBeGreaterThan(red);
    expect(blue).toBeGreaterThan(green);
    const textPixels = Array.from({ length: 12 }, (_, y) =>
      Array.from({ length: 20 }, (_, x) => at(20 + x, 4 + y)),
    ).flat();
    expect(textPixels.some(([r, g, b]) => r > 180 && g > 180 && b > 180)).toBe(true);
    const [referenceFrame] = await collectAsync(renderBundleFrames(bundle, 1));
    expect(referenceFrame).toBeDefined();
    const referenceTextPixels = [] as [number, number, number][];
    const actualTextPixels = [] as [number, number, number][];
    for (let y = 4; y < 16; y++) {
      for (let x = 20; x < 40; x++) {
        const offset = (y * 64 + x) * 4;
        const expected = referenceFrame!;
        if (expected[offset]! > 180 && expected[offset + 1]! > 180 && expected[offset + 2]! > 180) {
          referenceTextPixels.push([
            expected[offset]!,
            expected[offset + 1]!,
            expected[offset + 2]!,
          ]);
          actualTextPixels.push(at(x, y));
        }
      }
    }
    expect(referenceTextPixels.length).toBeGreaterThan(0);
    expect(actualTextPixels.filter(([, g, b]) => g > 100 && b > 100).length).toBe(
      referenceTextPixels.length,
    );

    writeFileSync(imagePath, Buffer.from('not-an-image'));
    const badOutputPath = join(directory, 'bad-overlay-output.mp4');
    let failure: unknown;
    try {
      await driver.export({
        protocolVersion: 1,
        bundle,
        outputPath: badOutputPath,
        mediaResolver: {
          require(opaqueRef) {
            return {
              kind: 'file' as const,
              path: opaqueRef === 'asset:image-a' ? imagePath : sourcePath,
            };
          },
          describe(opaqueRef) {
            return { opaqueRef };
          },
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain('image-a');
    expect(String(failure)).not.toContain(directory);
  });

  it('renders V2 overlays according to explicit zIndex rather than kind/order', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-v2-order-'));
    const sourcePath = join(directory, 'source.mp4');
    const bluePath = join(directory, 'blue.png');
    const greenPath = join(directory, 'green.png');
    const textPath = join(directory, 'text.png');
    const source = spawnSync(
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
        '0.2',
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
    expect(source.status).toBe(0);
    for (const [path, color] of [
      [bluePath, 'blue'],
      [greenPath, 'green'],
    ] as const) {
      const image = spawnSync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          `color=c=${color}:s=8x8`,
          '-frames:v',
          '1',
          path,
        ],
        { shell: false, encoding: 'utf8' },
      );
      expect(image.status).toBe(0);
    }
    expect(
      spawnSync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=cyan:s=4x8',
          '-frames:v',
          '1',
          textPath,
        ],
        { shell: false },
      ).status,
    ).toBe(0);
    const bytes = (path: string) => readFileSync(path);
    const digest = (path: string) => createHash('sha256').update(bytes(path)).digest('hex');
    const planBase: CompositionPlanV2 = {
      version: 2,
      composition: { id: 'comp', width: 64, height: 36 },
      viewport: { width: 64, height: 36 },
      frameRate: { num: 30, den: 1 },
      durationUs: 200_000,
      background: '#000000',
      layers: [
        {
          id: 'video',
          kind: 'video',
          assetId: 'video',
          startUs: 0,
          durationUs: 200_000,
          sourceInUs: 0,
          playbackRate: 1,
          zIndex: 0,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
        {
          id: 'green',
          kind: 'image',
          assetId: 'green',
          startUs: 0,
          durationUs: 200_000,
          zIndex: 5,
          x: 4,
          y: 4,
          scaleX: 2,
          scaleY: 1,
          rotationDeg: 90,
          opacity: 0.75,
          effects: [
            {
              id: 'green-brightness',
              effectId: 'brightness-contrast',
              enabled: true,
              params: { brightness: 0.2, contrast: 0 },
            },
          ],
        },
        {
          id: 'blue',
          kind: 'image',
          assetId: 'blue',
          startUs: 0,
          durationUs: 200_000,
          zIndex: 10,
          x: 1,
          y: 6,
          scaleX: 0.5,
          scaleY: 0.5,
          opacity: 0.35,
        },
        {
          id: 'text-overlay',
          kind: 'text',
          text: 'A',
          bitmapAssetId: 'text',
          fontId: 'system-ui',
          sourceSha256: 'e'.repeat(64),
          startUs: 0,
          durationUs: 200_000,
          zIndex: 15,
          x: 40,
          y: 20,
          scaleX: 2,
          scaleY: 2,
          rotationDeg: 90,
          opacity: 0.6,
        },
      ],
      audio: [
        {
          id: 'audio:video',
          assetId: 'video',
          startUs: 0,
          durationUs: 200_000,
          sourceInUs: 0,
          gain: 1,
          pan: 0,
          mute: false,
        },
      ],
      outputPreset: 'preview',
      planSha256: '',
    };
    const plan = { ...planBase, planSha256: planDigestV2(planBase) };
    const bundle = createRenderBundleV2({
      plan,
      projectRef: 'project',
      assets: Object.fromEntries([
        [
          'video',
          {
            assetId: 'video',
            opaqueRef: 'asset:video',
            integrity: {
              sha256: digest(sourcePath),
              bytes: bytes(sourcePath).length,
              mime: 'video/mp4',
            },
          },
        ],
        [
          'blue',
          {
            assetId: 'blue',
            opaqueRef: 'asset:blue',
            integrity: {
              sha256: digest(bluePath),
              bytes: bytes(bluePath).length,
              mime: 'image/png',
            },
          },
        ],
        [
          'green',
          {
            assetId: 'green',
            opaqueRef: 'asset:green',
            integrity: {
              sha256: digest(greenPath),
              bytes: bytes(greenPath).length,
              mime: 'image/png',
            },
          },
        ],
        [
          'text',
          {
            assetId: 'text',
            opaqueRef: 'asset:text',
            integrity: {
              sha256: digest(textPath),
              bytes: bytes(textPath).length,
              mime: 'image/png',
            },
            textBitmap: { sourceSha256: 'e'.repeat(64), width: 4, height: 8, fontId: 'system-ui' },
          },
        ],
      ]),
    });
    const outputPath = join(directory, 'output.mp4');
    await createPinnedOfflineRenderHostDriver().export({
      protocolVersion: 1,
      bundle: bundle as never,
      outputPath,
      mediaResolver: {
        require(ref) {
          return {
            kind: 'file' as const,
            path:
              ref === 'asset:video'
                ? sourcePath
                : ref === 'asset:blue'
                  ? bluePath
                  : ref === 'asset:green'
                    ? greenPath
                    : textPath,
          };
        },
        describe(opaqueRef) {
          return { opaqueRef };
        },
      },
    });
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
    const offset = (8 * 64 + 2) * 3;
    expect(pixels[offset + 2]!).toBeGreaterThan(pixels[offset]!);
    expect(pixels[offset + 1]!).toBeGreaterThan(pixels[offset]!);

    // Rotation is around the layer origin: the green 8x8 source rotated at
    // (4,4) occupies the left edge (not its unrotated x=4..20 footprint).
    const greenOnly = (5 * 64 + 2) * 3;
    expect(pixels[greenOnly + 1]!).toBeGreaterThan(20);
    // The decoded green bitmap is brightened before compositing (source-backed V2 effect).
    expect(pixels[greenOnly]!).toBeGreaterThan(70);
    expect(pixels[greenOnly]!).toBeLessThan(220);
    // The half-size blue layer is above green and fractional opacity blends
    // both source colours at their known overlap.
    const blended = (8 * 64 + 2) * 3;
    expect(pixels[blended + 2]!).toBeGreaterThan(20);
    expect(pixels[blended + 1]!).toBeGreaterThan(20);
    // Rotated/scaled text must produce non-red pixels in its transformed area.
    let textPixels = 0;
    let textMinX = 42;
    let textMaxX = 30;
    let textMinY = 32;
    let textMaxY = 20;
    for (let y = 20; y < 32; y++)
      for (let x = 30; x < 42; x++) {
        const at = (y * 64 + x) * 3;
        if (pixels[at + 1]! > 20 && pixels[at + 2]! > 20) {
          textPixels++;
          textMinX = Math.min(textMinX, x);
          textMaxX = Math.max(textMaxX, x);
          textMinY = Math.min(textMinY, y);
          textMaxY = Math.max(textMaxY, y);
        }
      }
    expect(textPixels).toBeGreaterThan(0);
    // A 4x5 glyph scaled 2x then rotated 90° is wider than tall here;
    // identity rotation or scale=1 cannot satisfy these extents.
    expect(textMaxX - textMinX + 1).toBeGreaterThanOrEqual(8);
    expect(textMaxY - textMinY + 1).toBeGreaterThanOrEqual(6);
    expect(textMaxX - textMinX).toBeGreaterThan(textMaxY - textMinY);
  });

  it('renders signed V2 LTR and RTL caption payloads into real export pixels', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-caption-'));
    const sourcePath = join(directory, 'source.mp4');
    const outputPath = join(directory, 'caption.mp4');
    const repeatPath = join(directory, 'caption-repeat.mp4');
    const source = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x202020:s=64x36:r=30',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=stereo',
        '-t',
        '0.2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        sourcePath,
      ],
      { shell: false, encoding: 'utf8' },
    );
    expect(source.status).toBe(0);
    const sourceBytes = readFileSync(sourcePath);
    const captionBase = {
      intent: 'burn-in' as const,
      styleRef: 'joy-clean' as const,
      segments: [
        { id: 'ltr', startUs: 0, endUs: 100_000, text: 'JOY', direction: 'ltr' as const },
        { id: 'rtl', startUs: 100_000, endUs: 200_000, text: 'سلام', direction: 'rtl' as const },
      ],
    };
    const captionBurnIn = { ...captionBase, payloadSha256: captionBurnInDigestV2(captionBase) };
    const planBase: CompositionPlanV2 = {
      version: 2,
      composition: { id: 'comp', width: 64, height: 36 },
      viewport: { width: 64, height: 36 },
      frameRate: { num: 30, den: 1 },
      durationUs: 200_000,
      background: '#000000',
      layers: [
        {
          id: 'video',
          kind: 'video',
          assetId: 'video',
          startUs: 0,
          durationUs: 200_000,
          sourceInUs: 0,
          playbackRate: 1,
          zIndex: 0,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
      ],
      audio: [
        {
          id: 'audio:video',
          assetId: 'video',
          startUs: 0,
          durationUs: 200_000,
          sourceInUs: 0,
          gain: 1,
          pan: 0,
          mute: false,
        },
      ],
      captionBurnIn,
      outputPreset: 'preview',
      planSha256: '',
    };
    const plan = { ...planBase, planSha256: planDigestV2(planBase) };
    const bundle = createRenderBundleV2({
      plan,
      projectRef: 'project',
      assets: {
        video: {
          assetId: 'video',
          opaqueRef: 'asset:video',
          integrity: {
            sha256: createHash('sha256').update(sourceBytes).digest('hex'),
            bytes: sourceBytes.length,
            mime: 'video/mp4',
          },
        },
      },
    });
    const resolver: RenderHostMediaResolver = {
      require: () => ({ kind: 'file', path: sourcePath }),
      describe: (opaqueRef) => ({ opaqueRef }),
    };
    await renderBundleToFile({ protocolVersion: 1, bundle, outputPath, mediaResolver: resolver });
    await renderBundleToFile({
      protocolVersion: 1,
      bundle,
      outputPath: repeatPath,
      mediaResolver: resolver,
    });
    expect(createHash('sha256').update(readFileSync(outputPath)).digest('hex')).toBe(
      createHash('sha256').update(readFileSync(repeatPath)).digest('hex'),
    );
    const decoded = spawnSync(
      'ffmpeg',
      [
        '-ss',
        '0.5',
        '-v',
        'error',
        '-ss',
        '0.1',
        '-i',
        outputPath,
        '-frames:v',
        '2',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ],
      { shell: false, maxBuffer: 4 * 1024 * 1024 },
    );
    expect(decoded.status).toBe(0);
    const pixels = decoded.stdout as Buffer;
    const firstFrame = pixels.subarray(0, 64 * 36 * 3);
    const secondFrame = pixels.subarray(64 * 36 * 3);
    const captionRegionChanged = (frame: Buffer) => {
      for (let y = 26; y < 36; y++)
        for (let x = 0; x < 64; x++) {
          const offset = (y * 64 + x) * 3;
          if ([0, 1, 2].some((channel) => Math.abs(frame[offset + channel]! - 32) > 8)) return true;
        }
      return false;
    };
    expect(captionRegionChanged(firstFrame)).toBe(true);
    expect(captionRegionChanged(secondFrame)).toBe(true);
    expect(firstFrame.equals(secondFrame)).toBe(false);
  });

  it('renders a published V2 HTML scene into source-backed MP4 pixels', async () => {
    const { findChromiumExecutable } =
      await import('../../../packages/html-scene-runtime/src/chromium-driver.js');
    if (findChromiumExecutable() === undefined) return;
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-html-v2-'));
    const sourcePath = join(directory, 'source.mp4');
    const htmlOutputPath = join(directory, 'output.mp4');
    expect(
      spawnSync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=red:s=320x568:r=30',
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
        { shell: false },
      ).status,
    ).toBe(0);
    const scene = (
      await import('../../../packages/html-scene-runtime/src/first-party.js')
    ).findFirstPartyScene('joy.firstparty.title')!;
    const sourceSha256 = createHash('sha256').update(scene.source).digest('hex');
    const base: CompositionPlanV2 = {
      version: 2,
      composition: { id: 'comp', width: 320, height: 568 },
      viewport: { width: 320, height: 568 },
      frameRate: { num: 30, den: 1 },
      durationUs: 1_000_000,
      background: '#000',
      layers: [
        {
          id: 'video',
          kind: 'video',
          assetId: 'video',
          startUs: 0,
          durationUs: 200_000,
          sourceInUs: 0,
          playbackRate: 1,
          zIndex: 0,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
        {
          id: 'scene',
          kind: 'html-scene',
          assetId: 'html-scene:joy.firstparty.title',
          startUs: 0,
          durationUs: 1_000_000,
          zIndex: 10,
          x: -110,
          y: -196,
          scaleX: 0.5,
          scaleY: 0.5,
          opacity: 1,
        },
      ],
      audio: [
        {
          id: 'audio:video',
          assetId: 'video',
          startUs: 0,
          durationUs: 1_000_000,
          sourceInUs: 0,
          gain: 1,
          pan: 0,
          mute: false,
        },
      ],
      outputPreset: 'preview',
      planSha256: '',
    };
    const plan = { ...base, planSha256: planDigestV2(base) };
    const sourceBytes = readFileSync(sourcePath);
    const bundle = createRenderBundleV2({
      plan,
      projectRef: 'html-e2e',
      assets: {
        video: {
          assetId: 'video',
          opaqueRef: 'asset:video',
          integrity: {
            sha256: createHash('sha256').update(sourceBytes).digest('hex'),
            bytes: sourceBytes.length,
            mime: 'video/mp4',
          },
        },
        'html-scene:joy.firstparty.title': {
          assetId: 'html-scene:joy.firstparty.title',
          opaqueRef: 'html-scene:joy.firstparty.title',
          htmlScene: { packageId: scene.id, sourceSha256 },
          integrity: {
            sha256: sourceSha256,
            bytes: scene.source.length,
            mime: 'application/vnd.joy.html-scene',
          },
        },
      },
    });
    await renderBundleToFile({
      protocolVersion: 1,
      bundle,
      outputPath: htmlOutputPath,
      mediaResolver: {
        require(ref) {
          return ref === 'asset:video'
            ? { kind: 'file', path: sourcePath }
            : { kind: 'html-scene', packageId: scene.id };
        },
        describe(opaqueRef) {
          return { opaqueRef };
        },
      },
    });
    const decoded = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        '0.5',
        '-i',
        htmlOutputPath,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ],
      { shell: false, maxBuffer: 4 * 1024 * 1024 },
    );
    expect(decoded.status).toBe(0);
    const pixels = decoded.stdout as Buffer;
    expect(pixels.length).toBe(320 * 568 * 3);
    // The title scene's translucent dark surface lowers source-red pixels.
    expect([...pixels].some((value, i) => i % 3 === 0 && value < 200)).toBe(true);
  }, 60000);

  it('fails before export when a published HTML scene source identity mismatches', async () => {
    const scene = (
      await import('../../../packages/html-scene-runtime/src/first-party.js')
    ).findFirstPartyScene('joy.firstparty.title')!;
    const base: CompositionPlanV2 = {
      version: 2,
      composition: { id: 'c', width: 1, height: 1 },
      viewport: { width: 1, height: 1 },
      frameRate: { num: 30, den: 1 },
      durationUs: 1,
      background: '#000',
      layers: [],
      audio: [],
      outputPreset: 'preview',
      planSha256: '',
    };
    const plan = { ...base, planSha256: planDigestV2(base) };
    const bundle = createRenderBundleV2({
      plan,
      projectRef: 'mismatch',
      assets: {
        scene: {
          assetId: 'scene',
          opaqueRef: `html-scene:${scene.id}`,
          htmlScene: { packageId: scene.id, sourceSha256: 'a'.repeat(64) },
          integrity: { sha256: 'a'.repeat(64), bytes: 1, mime: 'application/vnd.joy.html-scene' },
        },
      },
    });
    await expect(
      verifyRenderBundleV2Assets(bundle, {
        require: () => ({ kind: 'html-scene', packageId: scene.id }),
        describe: (opaqueRef) => ({ opaqueRef }),
      }),
    ).rejects.toThrow(/integrity mismatch/);
  });

  it('renders a published static Motion scene into decoded source-backed MP4 pixels', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-render-host-motion-v2-'));
    const sourcePath = join(directory, 'source.mp4');
    const outputPath = join(directory, 'motion.mp4');
    expect(
      spawnSync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=red:s=64x64:r=30',
          '-t',
          '0.2',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          sourcePath,
        ],
        { shell: false },
      ).status,
    ).toBe(0);
    const sourceBytes = readFileSync(sourcePath);
    const snapshot = {
      schemaVersion: 1,
      id: 'motion',
      name: 'Green square',
      width: 8,
      height: 8,
      durationMs: 200,
      frameRate: 30,
      background: { kind: 'transparent' },
      layers: [
        {
          id: 'green',
          type: 'shape',
          name: 'Green',
          visible: true,
          locked: false,
          transform: {
            x: 0,
            y: 0,
            z: 0,
            width: 8,
            height: 8,
            scaleX: 1,
            scaleY: 1,
            rotationDeg: 0,
            rotationXDeg: 0,
            rotationYDeg: 0,
            skewX: 0,
            skewY: 0,
            transformOriginX: '50%',
            transformOriginY: '50%',
            perspective: 0,
            opacity: 1,
          },
          fills: [{ kind: 'solid', color: '#00ff00', opacity: 1 }],
          strokes: [],
          shadows: [],
          filters: [],
          blendMode: 'normal',
          borderRadius: [0, 0, 0, 0],
          overflow: 'visible',
          layout: { mode: 'free' },
          children: [],
          animations: [],
        },
      ],
      variables: [],
      components: [],
      markers: [],
    } as unknown as MotionSceneDocument;
    const snapshotSha256 = sha256HexV2(canonicalJsonV2(snapshot));
    const base = {
      version: 2,
      composition: { id: 'comp', width: 64, height: 64 },
      viewport: { width: 64, height: 64 },
      frameRate: { num: 30, den: 1 },
      durationUs: 200_000,
      background: '#000000',
      layers: [
        {
          id: 'video',
          kind: 'video',
          assetId: 'video',
          startUs: 0,
          durationUs: 200_000,
          sourceInUs: 0,
          playbackRate: 1,
          zIndex: 0,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
        {
          id: 'motion',
          kind: 'motion-scene',
          assetId: 'motion-scene:motion',
          startUs: 0,
          durationUs: 200_000,
          zIndex: 10,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
      ],
      audio: [],
      outputPreset: 'preview',
      planSha256: '',
    } as CompositionPlanV2;
    const bundle = createRenderBundleV2({
      plan: { ...base, planSha256: planDigestV2(base) },
      projectRef: 'motion-e2e',
      assets: {
        video: {
          assetId: 'video',
          opaqueRef: 'asset:video',
          integrity: {
            sha256: createHash('sha256').update(sourceBytes).digest('hex'),
            bytes: sourceBytes.length,
            mime: 'video/mp4',
          },
        },
        'motion-scene:motion': {
          assetId: 'motion-scene:motion',
          opaqueRef: 'motion-scene:motion',
          integrity: {
            sha256: createHash('sha256').update(sourceBytes).digest('hex'),
            bytes: sourceBytes.length,
            mime: 'video/mp4',
          },
          motionScene: { snapshot, snapshotSha256, layers: {} },
        },
      },
    });
    await renderBundleToFile({
      protocolVersion: 1,
      bundle,
      outputPath,
      mediaResolver: {
        require(_ref) {
          return { kind: 'file', path: sourcePath };
        },
        describe(opaqueRef) {
          return { opaqueRef };
        },
      },
    });
    const decoded = spawnSync(
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
    ).stdout as Buffer;
    expect(decoded.length).toBe(64 * 64 * 3);
    expect(
      [...decoded].some((value, i) => i % 3 === 1 && value > 150 && decoded[i - 1]! < 100),
    ).toBe(true);
  });

  it('fails before export for missing Motion snapshot and per-layer integrity mismatch', async () => {
    const base = {
      version: 2,
      composition: { id: 'c', width: 1, height: 1 },
      viewport: { width: 1, height: 1 },
      frameRate: { num: 30, den: 1 },
      durationUs: 1_000_000,
      background: '#000',
      layers: [],
      audio: [],
      outputPreset: 'preview' as const,
    };
    const motionLayer = {
      id: 'motion',
      kind: 'motion-scene' as const,
      assetId: 'motion',
      startUs: 0,
      durationUs: 1_000_000,
      zIndex: 1,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
    };
    const plan = { ...base, layers: [motionLayer], planSha256: '' } as CompositionPlanV2;
    (plan as unknown as { planSha256: string }).planSha256 = planDigestV2(plan);
    expect(() =>
      createRenderBundleV2({
        plan,
        projectRef: 'motion-negative',
        assets: {
          motion: {
            assetId: 'motion',
            opaqueRef: 'motion-scene:motion',
            integrity: { sha256: 'a'.repeat(64), bytes: 1, mime: 'video/mp4' },
          },
        },
      }),
    ).toThrow(/canonical snapshot/);
    const snapshot = {
      schemaVersion: 1,
      id: 'motion',
      name: 'Static',
      width: 1,
      height: 1,
      durationMs: 1000,
      frameRate: 30,
      background: { kind: 'transparent' },
      layers: [],
      variables: [],
      components: [],
      markers: [],
    } as const;
    const signed = createRenderBundleV2({
      plan,
      projectRef: 'motion-negative',
      assets: {
        motion: {
          assetId: 'motion',
          opaqueRef: 'motion-scene:motion',
          integrity: { sha256: 'a'.repeat(64), bytes: 1, mime: 'video/mp4' },
          motionScene: {
            snapshot,
            snapshotSha256: sha256HexV2(canonicalJsonV2(snapshot)),
            layers: {
              layer: {
                opaqueRef: 'asset:layer',
                integrity: { sha256: 'b'.repeat(64), bytes: 1, mime: 'image/png' },
              },
            },
          },
        },
      },
    });
    await expect(
      verifyRenderBundleV2Assets(signed, {
        require(ref) {
          throw new Error(ref);
        },
        describe(opaqueRef) {
          return { opaqueRef };
        },
      }),
    ).rejects.toThrow(/asset motion|layer/);
  });

  it('fails before export when a published HTML scene is unavailable', async () => {
    const base: CompositionPlanV2 = {
      version: 2,
      composition: { id: 'c', width: 1, height: 1 },
      viewport: { width: 1, height: 1 },
      frameRate: { num: 30, den: 1 },
      durationUs: 1,
      background: '#000',
      layers: [],
      audio: [],
      outputPreset: 'preview',
      planSha256: '',
    };
    const plan = { ...base, planSha256: planDigestV2(base) };
    const bundle = createRenderBundleV2({
      plan,
      projectRef: 'missing',
      assets: {
        scene: {
          assetId: 'scene',
          opaqueRef: 'html-scene:joy.firstparty.missing',
          htmlScene: { packageId: 'joy.firstparty.missing', sourceSha256: 'a'.repeat(64) },
          integrity: { sha256: 'a'.repeat(64), bytes: 1, mime: 'application/vnd.joy.html-scene' },
        },
      },
    });
    await expect(
      verifyRenderBundleV2Assets(bundle, {
        require: () => ({ kind: 'html-scene', packageId: 'joy.firstparty.missing' }),
        describe: (opaqueRef) => ({ opaqueRef }),
      }),
    ).rejects.toThrow(/unavailable/);
  });
});

async function collectAsync<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

function cropResolver(sourcePath: string, imagePath: string): RenderHostMediaResolver {
  return {
    require(ref) {
      return { kind: 'file', path: ref === 'asset:video' ? sourcePath : imagePath };
    },
    describe(opaqueRef) {
      return { opaqueRef };
    },
  };
}

function cropV2Bundle(
  sourcePath: string,
  imagePath: string,
  crop: { left: number; top: number; right: number; bottom: number },
  transform: { x: number; y: number; scaleX: number; scaleY: number; rotationDeg?: number },
) {
  const bytes = (path: string) => readFileSync(path);
  const digest = (path: string) => createHash('sha256').update(bytes(path)).digest('hex');
  const base: Omit<CompositionPlanV2, 'planSha256'> = {
    version: 2,
    composition: { id: 'crop', width: 32, height: 24 },
    viewport: { width: 32, height: 24 },
    frameRate: { num: 30, den: 1 },
    durationUs: 200_000,
    background: '#000000',
    layers: [
      {
        id: 'video',
        kind: 'video',
        assetId: 'video',
        startUs: 0,
        durationUs: 200_000,
        sourceInUs: 0,
        playbackRate: 1,
        zIndex: 0,
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
      },
      {
        id: 'image',
        kind: 'image',
        assetId: 'image',
        startUs: 0,
        durationUs: 200_000,
        zIndex: 10,
        ...transform,
        opacity: 1,
        crop,
      },
    ],
    audio: [],
    outputPreset: 'preview',
  };
  const plan = { ...base, planSha256: planDigestV2(base) };
  return createRenderBundleV2({
    plan,
    projectRef: 'crop-test',
    assets: {
      video: {
        assetId: 'video',
        opaqueRef: 'asset:video',
        integrity: {
          sha256: digest(sourcePath),
          bytes: bytes(sourcePath).length,
          mime: 'video/mp4',
        },
      },
      image: {
        assetId: 'image',
        opaqueRef: 'asset:image',
        integrity: { sha256: digest(imagePath), bytes: bytes(imagePath).length, mime: 'image/png' },
      },
    },
  });
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
