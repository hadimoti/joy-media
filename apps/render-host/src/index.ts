import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  freezeManifest,
  renderRgbaFrameStream,
  verifyExport,
  type RenderManifest,
} from '@joy-media/export-core';
import { planRenderFrame, type RenderBundleV1 } from '@joy-media/render-planner';
import { renderHeadlessFrame } from '@joy-media/renderer-headless';
import {
  RENDER_HOST_PROTOCOL_VERSION,
  RENDER_HOST_VERSION,
  type RenderHostDriver,
  type RenderHostExportRequestV1,
  type RenderHostExportResultV1,
  type RenderHostFrameInputV1,
  type RenderHostMediaResolver,
  type RenderHostResolvedInput,
} from './protocol.js';

export {
  RENDER_HOST_PROTOCOL_VERSION,
  RENDER_HOST_VERSION,
  type RenderHostDriver,
  type RenderHostExportRequestV1,
  type RenderHostExportResultV1,
  type RenderHostFrameInputV1,
  type RenderHostMediaResolver,
  type RenderHostResolvedMedia,
} from './protocol.js';

export function createPinnedOfflineRenderHostDriver(): RenderHostDriver {
  return {
    export: renderBundleToFile,
  };
}

export async function renderBundleToFile(
  request: RenderHostExportRequestV1,
): Promise<RenderHostExportResultV1> {
  if (request.protocolVersion !== RENDER_HOST_PROTOCOL_VERSION) {
    throw new Error(`unsupported render-host protocol ${request.protocolVersion}`);
  }
  const manifest = manifestFromBundle(request.bundle);
  const frameCount = frameCountForManifest(manifest, request.frameLimit);
  const frameInputs = collectFrameInputsForExport({
    bundle: request.bundle,
    mediaResolver: request.mediaResolver,
    frameCount,
    manifest,
  });
  const streamed = await renderRgbaFrameStream(
    manifest,
    renderResolvedFrameInputs(frameInputs),
    request.outputPath,
    { pcmS16leStereo48000: renderAudioPcm(frameInputs, manifest) },
  );
  const probe = verifyExport(request.outputPath);
  const bytes = readFileSync(request.outputPath);
  return {
    manifest,
    frames: streamed.frames,
    videoCodec: probe.videoCodec,
    audioCodec: probe.audioCodec,
    width: probe.width,
    height: probe.height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    toolVersions: {
      renderHost: RENDER_HOST_VERSION,
      ffmpeg: toolVersion('ffmpeg'),
      ffprobe: toolVersion('ffprobe'),
    },
  };
}

export async function* renderBundleFrames(
  bundle: RenderBundleV1,
  frameCount: number,
  manifest: RenderManifest = manifestFromBundle(bundle),
  options?: { readonly mediaResolver?: RenderHostMediaResolver },
): AsyncIterable<Uint8Array> {
  if (options?.mediaResolver !== undefined) {
    yield* renderResolvedFrameInputs(
      collectFrameInputsForExport({
        bundle,
        mediaResolver: options.mediaResolver,
        frameCount,
        manifest,
      }),
    );
    return;
  }
  for (const input of collectPlannedFrames(bundle, frameCount, manifest)) {
    const rendered = renderHeadlessFrame(input.plan.frame);
    yield rendered.pixels;
  }
}

export function collectFrameInputsForExport(input: {
  readonly bundle: RenderBundleV1;
  readonly mediaResolver: RenderHostMediaResolver;
  readonly frameCount: number;
  readonly manifest?: RenderManifest;
}): readonly RenderHostFrameInputV1[] {
  const manifest = input.manifest ?? manifestFromBundle(input.bundle);
  return collectPlannedFrames(input.bundle, input.frameCount, manifest).map(({ plan }) => {
    const blockingFinding = plan.findings.find((finding) => finding.severity === 'error');
    if (blockingFinding !== undefined) throw new Error(blockingFinding.message);
    return {
      plan,
      videoSamples: plan.videoSamples.map((sample) => ({
        ...sample,
        media: resolveAssetInput(input.bundle, input.mediaResolver, sample.assetId),
      })),
      stillBitmaps: plan.captureRequirements
        .filter(
          (requirement) => requirement.kind === 'still-bitmap' && requirement.assetId !== undefined,
        )
        .map((requirement) => ({
          ...requirement,
          media: resolveAssetInput(input.bundle, input.mediaResolver, requirement.assetId!),
        })),
      htmlScenes: plan.captureRequirements
        .filter(
          (requirement) => requirement.kind === 'html-scene' && requirement.assetId !== undefined,
        )
        .map((requirement) => ({
          ...requirement,
          media: resolveAssetInput(input.bundle, input.mediaResolver, requirement.assetId!),
        })),
      audioSamples: plan.audioSamples.map((sample) => ({
        ...sample,
        media: resolveAssetInput(input.bundle, input.mediaResolver, sample.assetId),
      })),
    };
  });
}

function collectPlannedFrames(
  bundle: RenderBundleV1,
  frameCount: number,
  manifest: RenderManifest,
): readonly Pick<RenderHostFrameInputV1, 'plan'>[] {
  const imageSizesByObjectId = imageSizesForBundle(bundle);
  const frames: Array<Pick<RenderHostFrameInputV1, 'plan'>> = [];
  for (let index = 0; index < frameCount; index++) {
    frames.push({
      plan: planRenderFrame({
        bundle,
        timeUs: timeUsForFrame(index, manifest.frameRate),
        viewport: { width: manifest.width, height: manifest.height },
        imageSizesByObjectId,
      }),
    });
  }
  return frames;
}

export function manifestFromBundle(bundle: RenderBundleV1): RenderManifest {
  const composition = bundle.visualProject.compositions[bundle.compositionId];
  if (composition === undefined) throw new Error(`unknown composition ${bundle.compositionId}`);
  const frameRate = composition.frameRate.num / composition.frameRate.den;
  return freezeManifest({
    projectId: bundle.visualProject.id,
    revision: 0,
    width: composition.width,
    height: composition.height,
    frameRate,
    durationUs: composition.durationUs,
    preset: bundle.outputPreset === 'preview' ? 'social-h264-aac' : bundle.outputPreset,
  });
}

async function* renderResolvedFrameInputs(
  inputs: readonly RenderHostFrameInputV1[],
): AsyncIterable<Uint8Array> {
  for (const input of inputs) {
    const rendered = renderHeadlessFrame(input.plan.frame);
    yield applyResolvedMediaCaptures(rendered.pixels, rendered.width, rendered.height, input);
  }
}

function resolveAssetInput(
  bundle: RenderBundleV1,
  resolver: RenderHostMediaResolver,
  assetId: string,
): RenderHostResolvedInput {
  const descriptor = bundle.assets[assetId];
  if (descriptor === undefined) throw new Error(`missing required asset descriptor: ${assetId}`);
  try {
    const resolved = resolver.require(descriptor.opaqueRef);
    resolver.describe(descriptor.opaqueRef);
    return { opaqueRef: descriptor.opaqueRef, resolved };
  } catch (error) {
    throw new Error(`missing required asset ${assetId}: ${(error as Error).message}`);
  }
}

function applyResolvedMediaCaptures(
  pixels: Uint8Array,
  width: number,
  height: number,
  input: RenderHostFrameInputV1,
): Uint8Array {
  const result = new Uint8Array(pixels);
  const allCaptures = [
    ...input.videoSamples.map((sample) => ({
      key: `${sample.media.opaqueRef}:${sample.clipId}:${sample.sourceTimeUs}:${sample.role}`,
      x: 0,
      y: 0,
      w: Math.max(1, Math.floor(width / 3)),
      h: Math.max(1, Math.floor(height / 3)),
    })),
    ...input.stillBitmaps.map((sample) => ({
      key: `${sample.media.opaqueRef}:${sample.objectId ?? ''}:still`,
      x: Math.floor(width / 3),
      y: Math.floor(height / 3),
      w: Math.max(1, Math.floor(width / 4)),
      h: Math.max(1, Math.floor(height / 4)),
    })),
    ...input.htmlScenes.map((sample) => ({
      key: `${sample.media.opaqueRef}:${sample.objectId ?? ''}:${sample.sourceTimeUs ?? 0}`,
      x: Math.floor(width / 2),
      y: 0,
      w: Math.max(1, Math.floor(width / 3)),
      h: Math.max(1, Math.floor(height / 4)),
    })),
  ];
  for (const capture of allCaptures) {
    const color = colorFromResolvedInput(capture.key);
    for (let row = capture.y; row < Math.min(height, capture.y + capture.h); row++) {
      for (let column = capture.x; column < Math.min(width, capture.x + capture.w); column++) {
        const offset = (row * width + column) * 4;
        result[offset] = color.r;
        result[offset + 1] = color.g;
        result[offset + 2] = color.b;
        result[offset + 3] = 255;
      }
    }
  }
  return result;
}

async function* renderAudioPcm(
  inputs: readonly RenderHostFrameInputV1[],
  manifest: RenderManifest,
): AsyncIterable<Uint8Array> {
  const sampleRate = 48_000;
  let absoluteSample = 0;
  for (const input of inputs) {
    const samplesThisFrame = Math.max(1, Math.round(sampleRate / manifest.frameRate));
    const chunk = new Uint8Array(samplesThisFrame * 4);
    const view = new DataView(chunk.buffer);
    const audioKey = input.audioSamples
      .map(
        (sample) => `${sample.media.opaqueRef}:${sample.sourceTimeUs}:${sample.gain}:${sample.pan}`,
      )
      .join('|');
    const frequency = 220 + (hash32(audioKey || 'silence') % 440);
    const amplitude = input.audioSamples.length === 0 ? 0 : 1800;
    for (let sample = 0; sample < samplesThisFrame; sample++) {
      const value = Math.round(
        Math.sin(((absoluteSample + sample) / sampleRate) * Math.PI * 2 * frequency) * amplitude,
      );
      view.setInt16(sample * 4, value, true);
      view.setInt16(sample * 4 + 2, value, true);
    }
    absoluteSample += samplesThisFrame;
    yield chunk;
  }
}

function colorFromResolvedInput(value: string): {
  readonly r: number;
  readonly g: number;
  readonly b: number;
} {
  const hash = hash32(value);
  return {
    r: 32 + (hash & 0xbf),
    g: 32 + ((hash >>> 8) & 0xbf),
    b: 32 + ((hash >>> 16) & 0xbf),
  };
}

function imageSizesForBundle(
  bundle: RenderBundleV1,
): Readonly<Record<string, { readonly width: number; readonly height: number }>> {
  const sizes: Record<string, { readonly width: number; readonly height: number }> = {};
  for (const object of Object.values(bundle.visualProject.visualObjects)) {
    if (object.kind === 'image') {
      sizes[object.id] = {
        width: Math.max(
          1,
          Math.round(bundle.visualProject.compositions[bundle.compositionId]?.width ?? 1),
        ),
        height: Math.max(
          1,
          Math.round(bundle.visualProject.compositions[bundle.compositionId]?.height ?? 1),
        ),
      };
    }
  }
  return sizes;
}

function frameCountForManifest(manifest: RenderManifest, limit: number | undefined): number {
  const total = Math.max(1, Math.ceil((manifest.durationUs / 1_000_000) * manifest.frameRate));
  return limit === undefined ? total : Math.min(total, limit);
}

function timeUsForFrame(index: number, frameRate: number): number {
  return Math.floor((index * 1_000_000) / frameRate);
}

function toolVersion(tool: 'ffmpeg' | 'ffprobe'): string {
  const result = spawnSync(tool, ['-version'], { shell: false, encoding: 'utf8' });
  if (result.status !== 0) return 'unavailable';
  return result.stdout.split(/\r?\n/, 1)[0] ?? tool;
}

function hash32(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
