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
  type RenderHostExportRequestV1,
  type RenderHostExportResultV1,
  type RenderHostMediaResolver,
} from './protocol.js';

export {
  RENDER_HOST_PROTOCOL_VERSION,
  RENDER_HOST_VERSION,
  type RenderHostExportRequestV1,
  type RenderHostExportResultV1,
  type RenderHostMediaResolver,
  type RenderHostResolvedMedia,
} from './protocol.js';

export async function renderBundleToFile(
  request: RenderHostExportRequestV1,
): Promise<RenderHostExportResultV1> {
  if (request.protocolVersion !== RENDER_HOST_PROTOCOL_VERSION) {
    throw new Error(`unsupported render-host protocol ${request.protocolVersion}`);
  }
  const manifest = manifestFromBundle(request.bundle);
  const frameCount = frameCountForManifest(manifest, request.frameLimit);
  preflightRequiredAssets(request.bundle, request.mediaResolver, frameCount, manifest);
  const streamed = await renderRgbaFrameStream(
    manifest,
    renderBundleFrames(request.bundle, frameCount, manifest),
    request.outputPath,
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
): AsyncIterable<Uint8Array> {
  const imageSizesByObjectId = imageSizesForBundle(bundle);
  for (let index = 0; index < frameCount; index++) {
    const timeUs = timeUsForFrame(index, manifest.frameRate);
    const plan = planRenderFrame({
      bundle,
      timeUs,
      viewport: { width: manifest.width, height: manifest.height },
      imageSizesByObjectId,
    });
    const rendered = renderHeadlessFrame(plan.frame);
    yield rendered.pixels;
  }
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

function preflightRequiredAssets(
  bundle: RenderBundleV1,
  resolver: RenderHostMediaResolver,
  frameCount: number,
  manifest: RenderManifest,
): void {
  const imageSizesByObjectId = imageSizesForBundle(bundle);
  const seen = new Set<string>();
  for (let index = 0; index < frameCount; index++) {
    const plan = planRenderFrame({
      bundle,
      timeUs: timeUsForFrame(index, manifest.frameRate),
      viewport: { width: manifest.width, height: manifest.height },
      imageSizesByObjectId,
    });
    const blockingFinding = plan.findings.find((finding) => finding.severity === 'error');
    if (blockingFinding !== undefined) throw new Error(blockingFinding.message);
    for (const requirement of plan.requiredAssets) {
      const descriptor = requirement.descriptor;
      if (descriptor === undefined) {
        throw new Error(`missing required asset descriptor: ${requirement.assetId}`);
      }
      if (seen.has(descriptor.opaqueRef)) continue;
      try {
        resolver.require(descriptor.opaqueRef);
        resolver.describe(descriptor.opaqueRef);
      } catch (error) {
        throw new Error(
          `missing required asset ${requirement.assetId}: ${(error as Error).message}`,
        );
      }
      seen.add(descriptor.opaqueRef);
    }
  }
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
