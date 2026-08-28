import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  freezeManifest,
  renderRgbaFrameStream,
  verifyExport,
  type RenderManifest,
} from '@joy-media/export-core';
import {
  CAPTION_BURN_IN_KEY,
  planRenderFrame,
  preflightCompositionPlanV2,
  validateRenderBundleV2,
  type RenderBundleV2,
  type CompositionPlanV2,
  type CaptionBurnInV2,
  type RenderBundleV1,
  type TransitionV2,
  type MasterLimiterV2,
} from '@joy-media/render-planner';
import { captionAssDocument } from '@joy-media/captions-core';
import type { VisualObjectTransformV1, EffectInstanceV1 } from '@joy-media/project-schema';
import type { MotionSceneDocument } from '../../../packages/motion-core/src/scene.js';

type PublishedAssetBinding = RenderBundleV1['assets'][string] & {
  readonly motionScene?: { readonly snapshot: MotionSceneDocument };
  readonly textBitmap?: { readonly width: number; readonly height: number };
};
type VisualObjectV1 = CompositionPlanV2['layers'][number];
import { applyHeadlessEffects, renderHeadlessFrame } from '@joy-media/renderer-headless';
import { applyColorGradeToPixels, isIdentityColorGrade } from '@joy-media/renderer-pixi';
import { createSandboxedReactScene } from '../../../packages/html-scene-runtime/src/runtime.js';
import { captureSceneSurface } from '../../../packages/html-scene-runtime/src/headless.js';
import { createChromiumSceneDriver } from '../../../packages/html-scene-runtime/src/chromium-driver.js';
import {
  resolveFirstPartySceneInstance,
  findFirstPartyScene,
} from '../../../packages/html-scene-runtime/src/first-party.js';
import type { RenderFrameIR, Rgba, TextNode, VideoFrameNode } from '@joy-media/render-ir';
import {
  RENDER_HOST_PROTOCOL_VERSION,
  RENDER_HOST_VERSION,
  type RenderHostDriver,
  type RenderHostExportRequestV1,
  type RenderHostExportRequestV2,
  type RenderHostExportResultV1,
  type RenderHostFrameInputV1,
  type RenderHostMediaResolver,
  type RenderHostResolvedInput,
  type RenderHostResolvedMedia,
  type RenderHostResolvedCapture,
} from './protocol.js';
import * as renderPage from './render-page.js';
import type { OfflineRenderPage } from './render-page.js';

const PINNED_CAPTION_FONT_SHA256 =
  '932319d2ebd6fe90f6eaf3e785694a9dd9210a098575d98967709477688b1cac';
const CAPTION_FONT_PATH = fileURLToPath(
  new URL('../../editor-web/public/assets/fonts/falsafeh/Falsafeh-Light.ttf', import.meta.url),
);

/** Stable, redacted host failure for an invalid verified-delivery junction. */
export class RenderHostTransitionError extends Error {
  readonly code = 'INVALID_DISSOLVE_JUNCTION' as const;

  constructor(message = 'invalid dissolve transition junction') {
    super(message);
    this.name = 'RenderHostTransitionError';
  }
}

export {
  RENDER_HOST_PROTOCOL_VERSION,
  RENDER_HOST_VERSION,
  type RenderHostDriver,
  type RenderHostExportRequestV1,
  type RenderHostExportRequestV2,
  type RenderHostExportResultV1,
  type RenderHostFrameInputV1,
  type RenderHostMediaResolver,
  type RenderHostResolvedMedia,
} from './protocol.js';

/**
 * V2 integrity gate. Resolution is deliberately performed immediately before
 * export, so a Worker cannot trust stale catalog metadata or a changed file.
 */
export async function verifyRenderBundleV2Assets(
  bundle: RenderBundleV2,
  resolver: RenderHostMediaResolver,
): Promise<void> {
  try {
    validateRenderBundleV2(bundle);
  } catch (error) {
    if (
      bundle.plan?.transitions !== undefined &&
      error instanceof Error &&
      /transition/i.test(error.message)
    )
      throw new RenderHostTransitionError();
    throw error;
  }
  const support = preflightCompositionPlanV2(bundle.plan);
  if (!support.allowed) {
    if (bundle.plan.transitions !== undefined && /transition/i.test(support.reason ?? ''))
      throw new RenderHostTransitionError();
    throw new Error(support.reason ?? 'render plan is not supported');
  }
  for (const binding of Object.values(bundle.assets)) {
    const sha256 = binding.integrity?.sha256 ?? binding.sha256;
    const bytes = binding.integrity?.bytes ?? binding.bytes;
    if (sha256 === undefined || bytes === undefined)
      throw new Error(`asset integrity is missing for ${binding.assetId}`);
    let resolved: RenderHostResolvedMedia;
    try {
      resolved = resolver.require(binding.opaqueRef);
      resolver.describe(binding.opaqueRef);
    } catch {
      throw new Error(`asset ${binding.assetId} is unavailable on this Worker`);
    }
    const actual = await digestResolvedMediaContent(binding.opaqueRef, resolved);
    if (actual !== sha256)
      throw new Error(
        `asset integrity mismatch for ${binding.assetId}: resolved bytes do not match snapshot`,
      );
    if (resolved.kind === 'file') {
      const info = await stat(resolved.path);
      if (info.size !== bytes) throw new Error(`asset byte length mismatch for ${binding.assetId}`);
    } else if (
      resolved.kind === 'stream' &&
      resolved.sizeBytes !== undefined &&
      resolved.sizeBytes !== bytes
    ) {
      throw new Error(`asset byte length mismatch for ${binding.assetId}`);
    }
    const motionScene = (
      binding as unknown as {
        motionScene?: {
          layers: Readonly<
            Record<string, { opaqueRef: string; integrity: { sha256: string; bytes: number } }>
          >;
        };
      }
    ).motionScene;
    if (motionScene !== undefined) {
      for (const [layerId, layerAsset] of Object.entries(motionScene.layers)) {
        let layerResolved: RenderHostResolvedMedia;
        try {
          layerResolved = resolver.require(layerAsset.opaqueRef);
          resolver.describe(layerAsset.opaqueRef);
        } catch {
          throw new Error(`motion scene layer ${layerId} is unavailable on this Worker`);
        }
        const layerDigest = await digestResolvedMediaContent(layerAsset.opaqueRef, layerResolved);
        if (layerDigest !== layerAsset.integrity.sha256)
          throw new Error(`motion scene layer ${layerId} integrity mismatch`);
        if (
          layerResolved.kind === 'file' &&
          (await stat(layerResolved.path)).size !== layerAsset.integrity.bytes
        )
          throw new Error(`motion scene layer ${layerId} byte length mismatch`);
      }
    }
  }
}

export function createPinnedOfflineRenderHostDriver(): RenderHostDriver {
  return {
    async export(request) {
      const transport = await renderPage.createOfflineRenderHostTransport({
        createPage: renderPage.createOfflineRenderPage,
        exportFile: renderBundleToFile,
      });
      return transport.export(request);
    },
  };
}

export function renderBundleToFile(
  request: RenderHostExportRequestV1,
  runtime?: { readonly page?: OfflineRenderPage },
): Promise<RenderHostExportResultV1>;
export function renderBundleToFile(
  request: RenderHostExportRequestV2,
  runtime?: { readonly page?: OfflineRenderPage },
): Promise<RenderHostExportResultV1>;
export async function renderBundleToFile(
  request: RenderHostExportRequestV1 | RenderHostExportRequestV2,
  runtime: { readonly page?: OfflineRenderPage } = {},
): Promise<RenderHostExportResultV1> {
  if (request.protocolVersion !== RENDER_HOST_PROTOCOL_VERSION) {
    throw new Error(`unsupported render-host protocol ${request.protocolVersion}`);
  }
  const wireBundle = request.bundle as unknown as RenderBundleV1 | RenderBundleV2;
  if (wireBundle.version === 2) {
    await verifyRenderBundleV2Assets(wireBundle, request.mediaResolver);
    const legacy = legacyRequestFromV2({
      ...request,
      bundle: wireBundle,
    } as RenderHostExportRequestV2);
    return renderSourceBackedBundleToFile(
      legacy,
      manifestFromBundleV2(wireBundle),
      runtime.page,
      wireBundle.plan.captionBurnIn,
      wireBundle.plan.transitions,
      true,
      true,
      true,
      wireBundle.plan.masterLimiter,
      true,
    );
  }
  const legacyBundle = wireBundle as RenderBundleV1;
  const manifest = manifestFromBundle(legacyBundle);
  return renderSourceBackedBundleToFile(
    { ...request, bundle: legacyBundle } as RenderHostExportRequestV1,
    manifest,
    runtime.page,
    undefined,
    undefined,
    false,
    false,
    false,
    undefined,
    false,
  );
}

/** Runtime adapter only: the wire contract remains the compact normalized V2 plan. */
function legacyRequestFromV2(request: RenderHostExportRequestV2): RenderHostExportRequestV1 {
  const plan = request.bundle.plan;
  const assets = Object.fromEntries(
    Object.entries(request.bundle.assets).map(([id, binding]) => [
      binding.opaqueRef.startsWith('motion-scene:') ? binding.opaqueRef : id,
      {
        // The validator accepts flat aliases for compatibility; the editor emits nested integrity.
        id,
        kind: (binding.integrity?.mime ?? binding.mimeType ?? '').startsWith('image/')
          ? 'image'
          : (binding.integrity?.mime ?? binding.mimeType ?? '').startsWith('audio/')
            ? 'audio'
            : 'video',
        opaqueRef: binding.opaqueRef,
        integrity: {
          sha256: binding.integrity?.sha256 ?? binding.sha256!,
          totalBytes: binding.integrity?.bytes ?? binding.bytes!,
          mimeType: binding.integrity?.mime ?? binding.mimeType!,
        },
        availability: 'ready',
        ...((binding as unknown as PublishedAssetBinding).motionScene === undefined
          ? {}
          : { motionScene: (binding as unknown as PublishedAssetBinding).motionScene }),
        ...((binding as unknown as PublishedAssetBinding).textBitmap === undefined
          ? {}
          : { textBitmap: (binding as unknown as PublishedAssetBinding).textBitmap }),
      },
    ]),
  );
  const videoClips = plan.layers
    .filter((layer) => layer.kind === 'video')
    .map((layer) => ({
      id: layer.id,
      kind: 'video' as const,
      assetId: layer.assetId,
      startUs: layer.startUs,
      durationUs: layer.durationUs,
      sourceInUs: layer.sourceInUs,
      playbackRate: layer.playbackRate,
    }));
  const audioAssetClips = plan.audio
    .filter((layer) => (layer.sourceKind ?? 'video-native') === 'audio-asset')
    .map((layer) => ({
      id: layer.id,
      kind: 'audio' as const,
      assetId: layer.assetId,
      startUs: layer.startUs,
      durationUs: layer.durationUs,
      sourceInUs: layer.sourceInUs,
      playbackRate: layer.playbackRate,
    }));
  const visualLayers = plan.layers.filter(
    (layer) =>
      layer.kind === 'image' ||
      layer.kind === 'text' ||
      (layer as { kind: string }).kind === 'html-scene' ||
      (layer as { kind: string }).kind === 'motion-scene',
  ) as unknown as VisualObjectV1[];
  const visualObjects = Object.fromEntries(
    visualLayers
      .map((layer, index) => ({ layer, index }))
      .sort((left, right) => left.layer.zIndex - right.layer.zIndex || left.index - right.index)
      .map(({ layer }) => layer)
      .map((layer) => [
        layer.id,
        {
          id: layer.id,
          kind: layer.kind,
          zIndex: layer.zIndex,
          transform: {
            x: layer.x,
            y: layer.y,
            scaleX: layer.scaleX,
            scaleY: layer.scaleY,
            rotationDeg: layer.rotationDeg ?? 0,
            opacity: layer.opacity,
            crop:
              layer.kind === 'image'
                ? (layer.crop ?? { left: 0, top: 0, right: 0, bottom: 0 })
                : { left: 0, top: 0, right: 0, bottom: 0 },
          },
          ...(layer.kind === 'image'
            ? { assetId: layer.assetId }
            : layer.kind === 'html-scene'
              ? { scenePackageId: layer.assetId.slice('html-scene:'.length) }
              : layer.kind === 'motion-scene'
                ? { motionSceneId: layer.assetId.slice('motion-scene:'.length) }
                : layer.kind === 'text'
                  ? {
                      text: layer.text,
                      bitmapAssetId: layer.bitmapAssetId,
                      fontId: layer.fontId,
                      sourceSha256: layer.sourceSha256,
                    }
                  : {}),
          ...(layer.kind === 'image' && layer.effects !== undefined
            ? { effects: layer.effects }
            : {}),
        },
      ]),
  );
  const composition = {
    id: plan.composition.id,
    name: plan.composition.id,
    width: plan.composition.width,
    height: plan.composition.height,
    pixelAspectRatio: { num: 1, den: 1 },
    frameRate: plan.frameRate,
    durationUs: plan.durationUs,
    background: plan.background,
    tracks: [
      {
        id: 'v2-video',
        kind: 'video' as const,
        name: 'Video',
        order: 0,
        enabled: true,
        locked: false,
        clips: videoClips,
      },
      ...(audioAssetClips.length === 0
        ? []
        : [
            {
              id: 'v2-audio',
              kind: 'audio' as const,
              name: 'Audio',
              order: 1,
              enabled: true,
              locked: false,
              clips: audioAssetClips,
            },
          ]),
      ...captionTracksFromV2(plan.captionBurnIn, plan.durationUs),
    ],
  };
  const timelineProject = {
    schemaVersion: 0 as const,
    id: request.bundle.snapshot.projectRef,
    rootCompositionId: plan.composition.id,
    compositions: {
      [plan.composition.id]: {
        ...composition,
        tracks: [
          {
            id: 'v2-video',
            kind: 'video' as const,
            order: 0,
            enabled: true,
            clips: videoClips,
          },
          ...(audioAssetClips.length === 0
            ? []
            : [
                {
                  id: 'v2-audio',
                  kind: 'audio' as const,
                  order: 1,
                  enabled: true,
                  clips: audioAssetClips,
                },
              ]),
        ],
      },
    },
  };
  const visualProject = {
    schemaVersion: 1 as const,
    id: request.bundle.snapshot.projectRef,
    title: plan.composition.id,
    createdAt: request.bundle.snapshot.createdAt,
    updatedAt: request.bundle.snapshot.createdAt,
    rootCompositionId: plan.composition.id,
    settings: { defaultLocale: 'en' },
    compositions: { [plan.composition.id]: composition },
    assets,
    variables: {},
    markers: [],
    visualObjects,
    audio: {
      clips: Object.fromEntries(
        plan.audio.map((layer) => [
          (layer.sourceKind ?? 'video-native') === 'video-native'
            ? layer.id.replace(/^audio:/, '')
            : layer.id,
          {
            gain: layer.gain,
            pan: layer.pan,
            mute: layer.mute,
            solo: false,
            ...(layer.busId === undefined ? {} : { busId: layer.busId }),
            ...(layer.fadeInUs === undefined ? {} : { fadeInUs: layer.fadeInUs }),
            ...(layer.fadeOutUs === undefined ? {} : { fadeOutUs: layer.fadeOutUs }),
          },
        ]),
      ),
      buses: (
        plan.audioBuses ?? [
          { id: 'master', name: 'Master', gain: 1, pan: 0, mute: false, inputs: [] },
        ]
      ).map((bus) => ({ ...bus, solo: false, inputs: [] })),
      effects: [],
    },
    ...(plan.colorGrade === undefined ? {} : { colorGrade: plan.colorGrade }),
    captionDocuments: captionDocumentsFromV2(plan.captionBurnIn),
    pluginData: plan.captionBurnIn === undefined ? {} : { [CAPTION_BURN_IN_KEY]: true },
    exportPreset: plan.outputPreset === 'preview' ? undefined : plan.outputPreset,
  };
  return {
    ...request,
    bundle: {
      version: 1,
      timelineProject,
      visualProject,
      compositionId: plan.composition.id,
      outputPreset: plan.outputPreset,
      seed: request.bundle.snapshot.bundleSha256,
      assets,
    } as unknown as RenderBundleV1,
  };
}

/** Rehydrates only resolved V2 caption cues into the host's existing caption-core path. */
function captionDocumentsFromV2(payload: CaptionBurnInV2 | undefined): Record<
  string,
  {
    readonly id: string;
    readonly language: string;
    readonly direction: 'ltr' | 'rtl';
    readonly speakers: readonly [];
    readonly words: Readonly<Record<string, never>>;
    readonly segments: readonly {
      readonly id: string;
      readonly startUs: number;
      readonly endUs: number;
      readonly wordIds: readonly [];
      readonly textOverride: string;
    }[];
    readonly styleRef: string;
  }
> {
  if (payload === undefined) return {};
  const result: Record<
    string,
    {
      readonly id: string;
      readonly language: string;
      readonly direction: 'ltr' | 'rtl';
      readonly speakers: readonly [];
      readonly words: Readonly<Record<string, never>>;
      readonly segments: readonly {
        readonly id: string;
        readonly startUs: number;
        readonly endUs: number;
        readonly wordIds: readonly [];
        readonly textOverride: string;
      }[];
      readonly styleRef: string;
    }
  > = {};
  for (const direction of ['ltr', 'rtl'] as const) {
    const segments = payload.segments
      .filter((segment) => segment.direction === direction)
      .map((segment) => ({
        id: segment.id,
        startUs: segment.startUs,
        endUs: segment.endUs,
        wordIds: [] as const,
        textOverride: segment.text,
      }));
    if (segments.length === 0) continue;
    const id = `v2-caption-${direction}`;
    result[id] = {
      id,
      language: direction === 'rtl' ? 'und-Arab' : 'und-Latn',
      direction,
      speakers: [],
      words: {},
      segments,
      styleRef: payload.styleRef,
    };
  }
  return result;
}

function captionTracksFromV2(
  payload: CaptionBurnInV2 | undefined,
  durationUs: number,
): readonly {
  readonly id: string;
  readonly kind: 'caption';
  readonly order: number;
  readonly enabled: true;
  readonly clips: readonly {
    readonly id: string;
    readonly kind: 'caption';
    readonly startUs: 0;
    readonly durationUs: number;
    readonly captionDocumentId: string;
  }[];
}[] {
  if (payload === undefined) return [];
  return (['ltr', 'rtl'] as const).flatMap((direction, index) => {
    const hasSegments = payload.segments.some((segment) => segment.direction === direction);
    if (!hasSegments) return [];
    return [
      {
        id: `v2-caption-track-${direction}`,
        kind: 'caption' as const,
        order: 100 + index,
        enabled: true as const,
        clips: [
          {
            id: `v2-caption-clip-${direction}`,
            kind: 'caption' as const,
            startUs: 0 as const,
            durationUs,
            captionDocumentId: `v2-caption-${direction}`,
          },
        ],
      },
    ];
  });
}

function manifestFromBundleV2(bundle: RenderBundleV2): RenderManifest {
  return freezeManifest({
    projectId: bundle.snapshot.projectRef,
    revision: bundle.snapshot.revision,
    width: bundle.plan.viewport.width,
    height: bundle.plan.viewport.height,
    frameRate: bundle.plan.frameRate.num / bundle.plan.frameRate.den,
    durationUs: bundle.plan.durationUs,
    preset: bundle.plan.outputPreset === 'preview' ? 'social-h264-aac' : bundle.plan.outputPreset,
  });
}

interface SourceBackedClip {
  readonly id: string;
  readonly assetId: string;
  readonly startUs: number;
  readonly durationUs: number;
  /** Input handle duration; includes the incoming dissolve overlap when needed. */
  readonly inputDurationUs: number;
  readonly sourceInUs: number;
  readonly playbackRate: number;
  readonly path: string;
  readonly gain: number;
  readonly pan: number;
  readonly mute: boolean;
  readonly nativeAudio: boolean;
  readonly fadeInUs?: number;
  readonly fadeOutUs?: number;
  readonly busId?: string;
}

interface SourceBackedAudioLayer {
  readonly id: string;
  readonly assetId: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly sourceInUs: number;
  readonly playbackRate: number;
  readonly path: string;
  readonly gain: number;
  readonly pan: number;
  readonly mute: boolean;
  readonly fadeInUs?: number;
  readonly fadeOutUs?: number;
  readonly busId?: string;
}

interface SourceBackedAudioBus {
  readonly id: string;
  readonly gain: number;
  readonly pan: number;
  readonly mute: boolean;
}

interface SourceBackedSources {
  readonly clips: readonly SourceBackedClip[];
  readonly audio: readonly SourceBackedAudioLayer[];
  readonly transitions: readonly TransitionV2[];
  readonly buses: readonly SourceBackedAudioBus[];
}

/**
 * Export the honest v1 envelope: contiguous file-backed video clips whose
 * native audio is also present in each source. FFmpeg performs the actual
 * decode, scale/pad, concat, and AAC encode. Anything outside this envelope
 * fails closed instead of producing a synthetic frame/audio receipt.
 */
async function renderSourceBackedBundleToFile(
  request: RenderHostExportRequestV1,
  manifest: RenderManifest,
  page: OfflineRenderPage | undefined,
  captionBurnIn?: CaptionBurnInV2,
  transitions?: readonly TransitionV2[],
  allowV2Gaps = false,
  allowNonOneRate = false,
  allowStaticRotation = false,
  masterLimiter?: MasterLimiterV2,
  allowStaticImageCrop = false,
): Promise<RenderHostExportResultV1> {
  const bundle = request.bundle as RenderBundleV1;
  const sources = await sourceBackedClips(
    bundle,
    request.mediaResolver,
    captionBurnIn !== undefined,
    transitions,
    allowV2Gaps,
    allowNonOneRate,
    allowStaticRotation,
    allowStaticImageCrop,
  );
  const clips = sources.clips;
  const frameCount = frameCountForManifest(manifest, undefined);
  if (request.frameLimit !== undefined && request.frameLimit !== frameCount)
    throw new Error('source-backed export does not support partial frame limits');

  const temporaryPath = `${request.outputPath}.${process.pid}.${Date.now()}.partial.mp4`;
  const basePath = `${request.outputPath}.${process.pid}.${Date.now()}.base.mp4`;
  const compositedPath = `${request.outputPath}.${process.pid}.${Date.now()}.composite.mp4`;
  const captionedPath = `${request.outputPath}.${process.pid}.${Date.now()}.captioned.mp4`;
  try {
    const hasOverlays =
      bundle.visualProject.visualObjects !== undefined &&
      Object.keys(bundle.visualProject.visualObjects).length > 0;
    const hasCaptionBurnIn = captionBurnIn !== undefined;
    const colorGrade = bundle.visualProject.colorGrade;
    const hasColorGrade = colorGrade !== undefined && !isIdentityColorGrade(colorGrade);
    const needsPixelPass = hasOverlays || hasCaptionBurnIn || hasColorGrade;
    const args = sourceBackedFfmpegArgs(
      clips,
      sources.audio,
      manifest,
      needsPixelPass ? basePath : temporaryPath,
      sources.transitions,
      sources.buses,
      masterLimiter,
    );
    const result = spawnSync('ffmpeg', args, { shell: false, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`source-backed ffmpeg export failed: ${result.stderr}`);
    }
    if (!existsSync(needsPixelPass ? basePath : temporaryPath))
      throw new Error('source-backed export artifact is missing');
    if (hasOverlays || hasCaptionBurnIn) {
      await renderBasicVisualOverlaysToFile(
        {
          ...request,
          bundle:
            captionBurnIn === undefined
              ? bundle
              : {
                  ...bundle,
                  visualProject: { ...bundle.visualProject, pluginData: {} },
                },
        } as RenderHostExportRequestV1,
        manifest,
        basePath,
        compositedPath,
        frameCount,
        colorGrade,
        allowStaticImageCrop,
      );
      const captionOutput =
        captionBurnIn === undefined
          ? compositedPath
          : renderAssCaptionsToFile(compositedPath, captionBurnIn, manifest, captionedPath);
      invokeCompositeStagedTestHook(page);
      muxSourceAudio(basePath, captionOutput, temporaryPath, manifest);
      renameSync(temporaryPath, request.outputPath);
      rmSync(basePath, { force: true });
      rmSync(compositedPath, { force: true });
      rmSync(captionedPath, { force: true });
    } else if (hasColorGrade) {
      await renderColorGradedVideoToFile(
        basePath,
        compositedPath,
        manifest,
        frameCount,
        colorGrade,
      );
      muxSourceAudio(basePath, compositedPath, temporaryPath, manifest);
      renameSync(temporaryPath, request.outputPath);
      rmSync(basePath, { force: true });
      rmSync(compositedPath, { force: true });
    } else {
      renameSync(temporaryPath, request.outputPath);
    }
    const probe = verifyExport(request.outputPath);
    const bytes = readFileSync(request.outputPath);
    return {
      manifest,
      frames: frameCount,
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
  } catch (error) {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    if (existsSync(basePath)) rmSync(basePath, { force: true });
    if (existsSync(compositedPath)) rmSync(compositedPath, { force: true });
    if (existsSync(captionedPath)) rmSync(captionedPath, { force: true });
    throw error;
  }
}

function invokeCompositeStagedTestHook(page: OfflineRenderPage | undefined): void {
  const hook = (
    page as
      | (OfflineRenderPage & { readonly __joyMediaAfterCompositeStagedForTest?: () => void })
      | undefined
  )?.__joyMediaAfterCompositeStagedForTest;
  hook?.();
}

/** Renders verified captions with pinned libass/FriBidi/HarfBuzz shaping. */
function renderAssCaptionsToFile(
  inputPath: string,
  payload: CaptionBurnInV2,
  manifest: RenderManifest,
  outputPath: string,
): string {
  const fontPath = resolveCaptionFontPath();
  const fontBytes = readFileSync(fontPath);
  const fontHash = createHash('sha256').update(fontBytes).digest('hex');
  if (fontHash !== PINNED_CAPTION_FONT_SHA256)
    throw new Error('pinned caption font integrity check failed');
  const assPath = `${outputPath}.ass`;
  const fontDir = dirname(fontPath);
  writeFileSync(
    assPath,
    captionAssDocument(payload, { width: manifest.width, height: manifest.height }),
  );
  try {
    const filter = `subtitles=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(fontDir)}`;
    const result = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-nostdin',
        '-v',
        'error',
        '-i',
        inputPath,
        '-vf',
        filter,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-an',
        outputPath,
      ],
      { shell: false, encoding: 'utf8' },
    );
    if (result.status !== 0 || !existsSync(outputPath))
      throw new Error(`pinned caption shaping failed: ${result.stderr}`);
    return outputPath;
  } finally {
    rmSync(assPath, { force: true });
  }
}

function resolveCaptionFontPath(): string {
  const candidates = [
    CAPTION_FONT_PATH,
    join(process.cwd(), 'apps/editor-web/public/assets/fonts/falsafeh/Falsafeh-Light.ttf'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) throw new Error('pinned caption font is unavailable on this Worker');
  return path;
}

function escapeFilterPath(path: string): string {
  return `'${path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`;
}

function muxSourceAudio(
  basePath: string,
  compositedPath: string,
  outputPath: string,
  manifest: RenderManifest,
): void {
  const result = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-nostdin',
      '-v',
      'error',
      '-i',
      compositedPath,
      '-i',
      basePath,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-t',
      seconds(manifest.durationUs),
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      outputPath,
    ],
    { shell: false, encoding: 'utf8' },
  );
  if (result.status !== 0 || !existsSync(outputPath))
    throw new Error(`source-backed audio mux failed: ${result.stderr}`);
}

/**
 * Encode the basic V1 visual envelope over the decoded source video. The
 * source video is real media; image assets are decoded by ffmpeg and text is
 * rasterized from the same deterministic glyph path as the headless renderer.
 * Unsupported scene/effect features are rejected before this function runs.
 */
async function renderBasicVisualOverlaysToFile(
  request: RenderHostExportRequestV1,
  manifest: RenderManifest,
  basePath: string,
  outputPath: string,
  frameCount: number,
  colorGrade: RenderBundleV1['visualProject']['colorGrade'],
  allowStaticImageCrop = false,
): Promise<void> {
  const bundle = request.bundle as RenderBundleV1;
  const imageLayers = await resolveBasicImageLayers(
    bundle,
    request.mediaResolver,
    allowStaticImageCrop,
  );
  const imageSizesByObjectId = Object.fromEntries(
    imageLayers.map((layer) => [layer.objectId, { width: layer.width, height: layer.height }]),
  );
  const frameStream = (async function* (): AsyncIterable<Uint8Array> {
    let index = 0;
    for await (const baseFrame of streamVideoFrames(basePath, manifest, frameCount)) {
      const timeUs = timeUsForFrame(index, manifest.frameRate);
      const plan = planRenderFrame({
        bundle,
        timeUs,
        viewport: { width: manifest.width, height: manifest.height },
        imageSizesByObjectId,
      });
      const blockingFinding = plan.findings.find((finding) => finding.severity === 'error');
      if (blockingFinding !== undefined) throw new Error(blockingFinding.message);
      const composited = compositeBasicVisualFrame(
        baseFrame,
        applyExplicitV2LayerOrder(plan.frame, bundle.visualProject.visualObjects),
        imageLayers,
        manifest,
      );
      await compositeHtmlScenes(composited, bundle, request.mediaResolver, manifest, timeUs);
      // The master grade is a final-surface operation: apply it exactly once
      // after source pixels and all basic overlays have been composited.
      applyColorGradeToPixels(composited, colorGrade);
      yield composited;
      index++;
    }
    if (index !== frameCount)
      throw new Error(`source-backed export decoded ${index} frames, expected ${frameCount}`);
  })();
  await renderRgbaFrameStream(manifest, frameStream, outputPath);
}

/** Resolve and rasterize published first-party scenes into real RGBA pixels. */
async function compositeHtmlScenes(
  destination: Uint8Array,
  bundle: RenderBundleV1,
  resolver: RenderHostMediaResolver,
  manifest: RenderManifest,
  timeUs: number,
): Promise<void> {
  const driver = createChromiumSceneDriver();
  for (const object of Object.values(bundle.visualProject.visualObjects)) {
    if (object.kind === 'motion-scene' && object.motionSceneId !== undefined) {
      const descriptor = (bundle.assets[`motion-scene:${object.motionSceneId}`] ??
        bundle.assets[object.motionSceneId]) as unknown as PublishedAssetBinding;
      const snapshot = descriptor?.motionScene?.snapshot;
      if (snapshot === undefined)
        throw new Error(`motion scene ${object.motionSceneId} has no canonical snapshot`);
      const captured = rasterizeStaticMotionScene(snapshot);
      compositeImage(
        destination,
        manifest.width,
        manifest.height,
        {
          objectId: object.id,
          pixels: captured.pixels,
          width: captured.width,
          height: captured.height,
        },
        {
          id: object.id,
          transform: {
            translateX: object.transform.x,
            translateY: object.transform.y,
            scaleX: object.transform.scaleX,
            scaleY: object.transform.scaleY,
            rotationDeg: object.transform.rotationDeg ?? 0,
          },
          opacity: object.transform.opacity,
          zIndex: 1000,
        } as VideoFrameNode,
      );
      continue;
    }
    if (object.kind !== 'html-scene' || object.scenePackageId === undefined) continue;
    const descriptor = bundle.assets[`html-scene:${object.scenePackageId}`];
    if (descriptor === undefined)
      throw new Error(`missing required HTML scene asset: ${object.scenePackageId}`);
    const resolved = resolver.require(descriptor.opaqueRef);
    resolver.describe(descriptor.opaqueRef);
    if (resolved.kind !== 'html-scene' || resolved.packageId !== object.scenePackageId)
      throw new Error(`published HTML scene identity mismatch: ${object.scenePackageId}`);
    const instance = resolveFirstPartySceneInstance(object.scenePackageId);
    if (instance === undefined)
      throw new Error(`published HTML scene is unavailable: ${object.scenePackageId}`);
    const scene = createSandboxedReactScene(instance.scene.manifest, instance.scene.source);
    const captured = captureSceneSurface(scene, driver, {
      timeUs: Math.min(timeUs, scene.manifest.durationUs - 1),
      frameRate: { num: Math.round(manifest.frameRate * 1000), den: 1000 },
      seed: descriptor.integrity?.sha256 ?? object.scenePackageId,
      variables: instance.variables,
      locale: 'en',
    });
    const node = {
      id: object.id,
      transform: {
        translateX: object.transform.x,
        translateY: object.transform.y,
        scaleX: object.transform.scaleX,
        scaleY: object.transform.scaleY,
        rotationDeg: object.transform.rotationDeg ?? 0,
      },
      opacity: object.transform.opacity,
      zIndex: 1000,
    } as VideoFrameNode;
    compositeImage(
      destination,
      manifest.width,
      manifest.height,
      {
        objectId: object.id,
        pixels: captured.rgba,
        width: captured.width,
        height: captured.height,
      },
      node,
    );
  }
}

/** Apply the master grade to source-backed frames without buffering the export. */
async function renderColorGradedVideoToFile(
  basePath: string,
  outputPath: string,
  manifest: RenderManifest,
  frameCount: number,
  colorGrade: RenderBundleV1['visualProject']['colorGrade'],
): Promise<void> {
  const frameStream = (async function* (): AsyncIterable<Uint8Array> {
    let index = 0;
    for await (const frame of streamVideoFrames(basePath, manifest, frameCount)) {
      applyColorGradeToPixels(frame, colorGrade);
      yield frame;
      index++;
    }
    if (index !== frameCount)
      throw new Error(`source-backed export decoded ${index} frames, expected ${frameCount}`);
  })();
  await renderRgbaFrameStream(manifest, frameStream, outputPath);
}

function applyExplicitV2LayerOrder(
  frame: RenderFrameIR,
  visualObjects: Readonly<Record<string, unknown>>,
): RenderFrameIR {
  return {
    ...frame,
    nodes: frame.nodes.map((node) => {
      const candidate = visualObjects[node.id];
      const zIndex =
        candidate !== null && typeof candidate === 'object' && 'zIndex' in candidate
          ? (candidate as { readonly zIndex?: unknown }).zIndex
          : undefined;
      return typeof zIndex === 'number' ? { ...node, zIndex } : node;
    }),
  };
}

interface DecodedImageLayer {
  readonly objectId: string;
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly effects?: readonly EffectInstanceV1[];
}

async function resolveBasicImageLayers(
  bundle: RenderBundleV1,
  resolver: RenderHostMediaResolver,
  allowStaticImageCrop = false,
): Promise<readonly DecodedImageLayer[]> {
  const layers: DecodedImageLayer[] = [];
  for (const object of Object.values(bundle.visualProject.visualObjects)) {
    if (object.kind !== 'image' && object.kind !== 'text') continue;
    const assetId =
      object.kind === 'image'
        ? object.assetId
        : (object as typeof object & { readonly bitmapAssetId?: string }).bitmapAssetId;
    if (assetId === undefined) {
      if (object.kind === 'text') continue; // V1 compatibility; V2 planner rejects this shape.
      throw new Error(`${object.kind} overlay ${object.id} is missing a bitmap binding`);
    }
    const descriptor = bundle.assets[assetId];
    if (descriptor === undefined) throw new Error(`missing required asset descriptor: ${assetId}`);
    const resolved = resolver.require(descriptor.opaqueRef);
    resolver.describe(descriptor.opaqueRef);
    if (resolved.kind !== 'file' || !existsSync(resolved.path))
      throw new Error(`${object.kind} overlay asset is unavailable: ${assetId}`);
    const decoded = decodeImage(resolved.path, assetId);
    const cropped =
      allowStaticImageCrop && object.kind === 'image'
        ? cropDecodedImage(decoded, object.transform.crop)
        : decoded;
    if (object.kind === 'text' && (descriptor as PublishedAssetBinding).textBitmap !== undefined) {
      const expected = (descriptor as PublishedAssetBinding).textBitmap!;
      if (cropped.width !== expected.width || cropped.height !== expected.height)
        throw new Error(`text bitmap dimensions mismatch for ${object.id}`);
    }
    const effects = object.kind === 'image' ? object.effects : undefined;
    if (allowStaticImageCrop && effects !== undefined)
      applyHeadlessEffects(
        cropped.pixels,
        cropped.width,
        cropped.height,
        effects.map((effect) => ({
          id: effect.id,
          kind: effect.effectId,
          enabled: effect.enabled,
          params: Object.fromEntries(
            Object.entries(effect.params).filter(([, value]) => typeof value === 'number'),
          ) as Record<string, number>,
        })),
      );
    layers.push({ objectId: object.id, ...cropped, ...(effects === undefined ? {} : { effects }) });
  }
  return layers;
}

function decodeImage(
  path: string,
  assetId: string,
): {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
} {
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      path,
    ],
    { shell: false, encoding: 'utf8' },
  );
  if (probe.status !== 0) throw new Error(`image overlay could not be decoded: ${assetId}`);
  let width = 0;
  let height = 0;
  try {
    const stream = (
      JSON.parse(probe.stdout) as { streams?: readonly { width?: number; height?: number }[] }
    ).streams?.[0];
    width = stream?.width ?? 0;
    height = stream?.height ?? 0;
  } catch {
    throw new Error(`image overlay probe returned invalid metadata: ${assetId}`);
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error(`image overlay has invalid dimensions: ${assetId}`);
  const decoded = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { shell: false },
  );
  if (decoded.status !== 0 || decoded.stdout.length !== width * height * 4)
    throw new Error(`image overlay could not be decoded: ${assetId}`);
  return { pixels: new Uint8Array(decoded.stdout), width, height };
}

function cropDecodedImage(
  source: { readonly pixels: Uint8Array; readonly width: number; readonly height: number },
  crop: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  },
): typeof source {
  if (crop.left === 0 && crop.top === 0 && crop.right === 0 && crop.bottom === 0) return source;
  const x0 = Math.floor(source.width * crop.left);
  const y0 = Math.floor(source.height * crop.top);
  const x1 = Math.max(x0 + 1, Math.ceil(source.width * (1 - crop.right)));
  const y1 = Math.max(y0 + 1, Math.ceil(source.height * (1 - crop.bottom)));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * source.width + x0) * 4;
    pixels.set(source.pixels.subarray(from, from + width * 4), y * width * 4);
  }
  return { pixels, width, height };
}

async function* streamVideoFrames(
  path: string,
  manifest: RenderManifest,
  frameCount: number,
): AsyncIterable<Uint8Array> {
  const decoder = spawn(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      path,
      '-frames:v',
      String(frameCount),
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${manifest.width}x${manifest.height}`,
      'pipe:1',
    ],
    { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (decoder.stdout === null || decoder.stderr === null)
    throw new Error('source-backed export decoder pipes are unavailable');
  const bytesPerFrame = manifest.width * manifest.height * 4;
  const stderr: Buffer[] = [];
  decoder.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const closed = new Promise<number | null>((resolve) => decoder.once('close', resolve));
  let pending = Buffer.alloc(0);
  let decodedFrames = 0;
  try {
    for await (const chunk of decoder.stdout) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      while (pending.length >= bytesPerFrame) {
        if (decodedFrames >= frameCount) break;
        const frame = pending.subarray(0, bytesPerFrame);
        pending = pending.subarray(bytesPerFrame);
        decodedFrames++;
        yield new Uint8Array(frame);
      }
    }
    const status = await closed;
    if (status !== 0 || pending.length !== 0)
      throw new Error(
        `source-backed export could not decode compositing frames: ${Buffer.concat(stderr).toString()}`,
      );
  } finally {
    if (!decoder.killed) decoder.kill();
  }
}

function compositeBasicVisualFrame(
  base: Uint8Array,
  frame: RenderFrameIR,
  imageLayers: readonly DecodedImageLayer[],
  manifest: RenderManifest,
): Uint8Array {
  const result = new Uint8Array(base);
  const imageById = new Map(imageLayers.map((layer) => [layer.objectId, layer]));
  const ordered = frame.nodes
    .map((node, position) => ({ node, position }))
    .sort((left, right) => left.node.zIndex - right.node.zIndex || left.position - right.position);
  for (const { node } of ordered) {
    if (node.kind === 'video-frame') {
      const layer = imageById.get(node.id);
      if (layer === undefined) continue;
      compositeImage(result, manifest.width, manifest.height, layer, node);
    } else if (node.kind === 'text') {
      const bitmap = imageById.get(node.id);
      if (bitmap === undefined) {
        compositeText(result, manifest.width, manifest.height, node);
      } else {
        compositeImage(
          result,
          manifest.width,
          manifest.height,
          bitmap,
          node as unknown as VideoFrameNode,
        );
      }
    } else if (node.kind !== 'transition') {
      throw new Error(`basic visual export encountered unsupported node ${node.kind}`);
    }
  }
  return result;
}

function compositeImage(
  destination: Uint8Array,
  width: number,
  height: number,
  layer: DecodedImageLayer,
  node: VideoFrameNode,
): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const radians = ((node.transform.rotationDeg ?? 0) * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const dx = x + 0.5 - node.transform.translateX;
      const dy = y + 0.5 - node.transform.translateY;
      const sourceX = Math.floor((cos * dx + sin * dy) / node.transform.scaleX);
      const sourceY = Math.floor((-sin * dx + cos * dy) / node.transform.scaleY);
      if (sourceX < 0 || sourceY < 0 || sourceX >= layer.width || sourceY >= layer.height) continue;
      const source = (sourceY * layer.width + sourceX) * 4;
      const target = (y * width + x) * 4;
      blendPixel(destination, target, layer.pixels, source, node.opacity);
    }
  }
}

function compositeText(
  destination: Uint8Array,
  width: number,
  height: number,
  node: TextNode,
): void {
  const textFrame: RenderFrameIR = {
    version: 1,
    compositionId: 'text-overlay',
    timeUs: 0,
    viewport: { width, height, dpr: 1 },
    background: { r: 0, g: 0, b: 0, a: 0 },
    nodes: [node],
  };
  const rendered = renderHeadlessFrame(textFrame).pixels;
  for (let offset = 0; offset < rendered.length; offset += 4) {
    if (rendered[offset + 3] === 0) continue;
    blendPixel(destination, offset, rendered, offset, 1);
  }
}

function blendPixel(
  destination: Uint8Array,
  target: number,
  source: Uint8Array,
  offset: number,
  opacity: number,
): void {
  blendRgba(
    destination,
    target,
    { r: source[offset]!, g: source[offset + 1]!, b: source[offset + 2]!, a: source[offset + 3]! },
    opacity,
  );
}

function blendRgba(destination: Uint8Array, target: number, source: Rgba, opacity: number): void {
  const alpha = (source.a / 255) * Math.max(0, Math.min(1, opacity));
  if (alpha <= 0) return;
  const inverse = 1 - alpha;
  destination[target] = Math.round(source.r * alpha + destination[target]! * inverse);
  destination[target + 1] = Math.round(source.g * alpha + destination[target + 1]! * inverse);
  destination[target + 2] = Math.round(source.b * alpha + destination[target + 2]! * inverse);
  destination[target + 3] = 255;
}

async function sourceBackedClips(
  bundle: RenderBundleV1,
  resolver: RenderHostMediaResolver,
  allowCaptionBurnIn = false,
  transitions: readonly TransitionV2[] | undefined = undefined,
  allowV2Gaps = false,
  allowNonOneRate = false,
  allowStaticRotation = false,
  allowStaticImageCrop = false,
): Promise<SourceBackedSources> {
  const timeline = bundle.timelineProject.compositions[bundle.timelineProject.rootCompositionId];
  if (timeline === undefined) throw new Error('source-backed export requires a timeline root');
  for (const object of Object.values(bundle.visualProject.visualObjects)) {
    assertBasicTransform(
      object.id,
      object.transform,
      allowStaticRotation,
      allowStaticImageCrop,
      object.kind,
    );
    if (
      object.kind !== 'image' &&
      object.kind !== 'text' &&
      object.kind !== 'html-scene' &&
      object.kind !== 'motion-scene' &&
      object.kind !== 'null' &&
      object.kind !== 'camera'
    )
      throw new Error(`source-backed export is unavailable for ${object.kind} visual objects yet`);
    if (object.kind === 'image' && object.assetId === undefined)
      throw new Error(`image overlay ${object.id} is missing an asset`);
    if (
      object.effects !== undefined &&
      object.effects.length > 0 &&
      !(allowStaticImageCrop && object.kind === 'image')
    )
      throw new Error(
        `source-backed export does not support effects on visual object ${object.id}`,
      );
    if (
      object.animations !== undefined ||
      object.expressions !== undefined ||
      object.spatialPath !== undefined ||
      object.motionBlur !== undefined
    )
      throw new Error(
        `source-backed export supports only static basic visual transforms (${object.id})`,
      );
  }
  if (transitions === undefined && (bundle.visualProject.transitions?.length ?? 0) > 0)
    throw new Error('source-backed export does not support transitions yet');
  if (bundle.visualProject.pluginData[CAPTION_BURN_IN_KEY] === true && !allowCaptionBurnIn)
    throw new Error('source-backed export does not support caption burn-in without a V2 payload');

  const rawClips = timeline.tracks
    .filter((track) => track.enabled)
    .flatMap((track) => track.clips)
    .filter(
      (
        clip,
      ): clip is Extract<(typeof timeline.tracks)[number]['clips'][number], { kind: 'video' }> =>
        clip.kind === 'video',
    )
    .sort((left, right) => left.startUs - right.startUs);
  if (rawClips.length === 0)
    throw new Error('source-backed export requires at least one video clip');

  const audio = bundle.visualProject.audio;
  if (audio !== undefined && audio.effects.length > 0)
    throw new Error('source-backed export does not support audio effects yet');
  const buses: SourceBackedAudioBus[] = (
    audio?.buses?.length
      ? audio.buses
      : [{ id: 'master', name: 'Master', gain: 1, pan: 0, mute: false, solo: false, inputs: [] }]
  ).map((bus) => {
    if (bus.id !== 'master' && bus.id !== 'music')
      throw new Error(`Audio bus "${bus.id}" is not supported for verified delivery.`);
    if (bus.solo) throw new Error('Audio bus solo is not supported for verified delivery.');
    if (
      !Number.isFinite(bus.gain) ||
      bus.gain < 0 ||
      bus.gain > 8 ||
      !Number.isFinite(bus.pan) ||
      bus.pan < -1 ||
      bus.pan > 1
    )
      throw new Error(`Audio bus ${bus.id} mix settings are invalid`);
    return { id: bus.id, gain: bus.gain, pan: bus.pan, mute: bus.mute };
  });
  if (!buses.some((bus) => bus.id === 'master') || buses.length > 2)
    throw new Error('Only master and music audio buses are supported for verified delivery.');

  let cursorUs = 0;
  const soloIds = new Set(
    audio === undefined
      ? []
      : Object.entries(audio.clips)
          .filter(([, config]) => config.solo)
          .map(([clipId]) => clipId),
  );
  const clips: SourceBackedClip[] = [];
  const audioLayers: SourceBackedAudioLayer[] = [];
  const transitionExtensionByClipId = new Map<string, number>();
  for (const transition of transitions ?? [])
    transitionExtensionByClipId.set(transition.rightClipId, transition.durationUs);
  for (const clip of rawClips) {
    if (clip.startUs < cursorUs)
      throw new Error('source-backed export does not support overlapping video clips');
    // A gap is represented by a synthetic black/silent segment below. Dissolve
    // remains deliberately strict: its xfade/acrossfade model requires the
    // original two clips to meet exactly at the junction.
    if (!allowV2Gaps && clip.startUs !== cursorUs)
      throw new Error('source-backed export requires contiguous video clips from timeline start');
    if (transitions !== undefined && clip.startUs !== cursorUs)
      throw new RenderHostTransitionError();
    if (clip.durationUs <= 0 || clip.sourceInUs < 0)
      throw new Error(`invalid source-backed range for clip ${clip.id}`);
    const playbackRate = clip.playbackRate ?? 1;
    if (!Number.isFinite(playbackRate) || playbackRate <= 0 || playbackRate > 8)
      throw new Error(
        `source-backed export does not support playback rate ${playbackRate}× (freeze/invalid rate)`,
      );
    if (!allowNonOneRate && playbackRate !== 1)
      throw new Error('source-backed export supports only 1x playback rate');
    const descriptor = bundle.assets[clip.assetId];
    if (descriptor === undefined)
      throw new Error(`missing required asset descriptor: ${clip.assetId}`);
    const resolved = resolver.require(descriptor.opaqueRef);
    resolver.describe(descriptor.opaqueRef);
    if (resolved.kind !== 'file')
      throw new Error(`source-backed export requires file-backed asset ${clip.assetId}`);
    if (!existsSync(resolved.path))
      throw new Error(`source-backed asset is unavailable: ${clip.assetId}`);
    const source = probeSourceFile(resolved.path);
    if (!source.video)
      throw new Error(`source-backed asset requires decodable video: ${clip.assetId}`);
    const transitionExtensionUs = transitionExtensionByClipId.get(clip.id) ?? 0;
    const inputDurationUs = Math.round((clip.durationUs + transitionExtensionUs) * playbackRate);
    const requiredEndUs = clip.sourceInUs + inputDurationUs;
    const videoDurationUs = source.videoDurationUs ?? source.durationUs;
    if (
      transitionExtensionUs > 0 &&
      (videoDurationUs === undefined || requiredEndUs > videoDurationUs + 50_000)
    )
      throw new RenderHostTransitionError();
    if (source.durationUs !== undefined && requiredEndUs > source.durationUs + 50_000)
      throw new Error(`source-backed range exceeds media duration: ${clip.assetId}`);
    const config = audio?.clips[clip.id];
    if (
      transitionExtensionUs > 0 &&
      source.audio &&
      (source.audioDurationUs === undefined || requiredEndUs > source.audioDurationUs + 50_000)
    )
      throw new RenderHostTransitionError();
    const gain = config?.gain ?? 1;
    const pan = config?.pan ?? 0;
    if (
      !Number.isFinite(gain) ||
      gain < 0 ||
      gain > 8 ||
      !Number.isFinite(pan) ||
      pan < -1 ||
      pan > 1
    )
      throw new Error(`invalid audio mix settings for clip ${clip.id}`);
    clips.push({
      id: clip.id,
      assetId: clip.assetId,
      startUs: clip.startUs,
      durationUs: clip.durationUs,
      inputDurationUs,
      sourceInUs: clip.sourceInUs,
      playbackRate,
      path: resolved.path,
      gain: soloIds.size > 0 && !soloIds.has(clip.id) ? 0 : gain,
      pan,
      mute: config?.mute ?? false,
      nativeAudio: source.audio,
      ...(config?.fadeInUs === undefined ? {} : { fadeInUs: config.fadeInUs }),
      ...(config?.fadeOutUs === undefined ? {} : { fadeOutUs: config.fadeOutUs }),
      ...((config as typeof config & { readonly busId?: string })?.busId === undefined
        ? {}
        : { busId: (config as typeof config & { readonly busId?: string }).busId }),
    });
    cursorUs += clip.durationUs;
  }
  if (cursorUs > timeline.durationUs)
    throw new Error('source-backed video clips exceed the timeline duration');
  if (!allowV2Gaps && cursorUs !== timeline.durationUs)
    throw new Error('source-backed export requires clips to cover the full timeline duration');
  const rawAudioClips = timeline.tracks
    .filter((track) => track.enabled)
    .flatMap((track) => track.clips)
    .filter(
      (
        clip,
      ): clip is Extract<(typeof timeline.tracks)[number]['clips'][number], { kind: 'audio' }> =>
        clip.kind === 'audio',
    )
    .sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id));
  for (const clip of rawAudioClips) {
    if (clip.durationUs <= 0 || clip.sourceInUs < 0)
      throw new Error(`invalid source-backed range for audio clip ${clip.id}`);
    const playbackRate = clip.playbackRate ?? 1;
    if (!Number.isFinite(playbackRate) || playbackRate < 0.1 || playbackRate > 8)
      throw new Error(
        `source-backed audio does not support playback rate ${playbackRate}× (freeze/invalid rate)`,
      );
    if (!allowNonOneRate && playbackRate !== 1)
      throw new Error('source-backed export supports only 1x audio playback rate');
    const descriptor = bundle.assets[clip.assetId];
    if (descriptor === undefined)
      throw new Error(`missing required audio asset descriptor: ${clip.assetId}`);
    const resolved = resolver.require(descriptor.opaqueRef);
    resolver.describe(descriptor.opaqueRef);
    if (resolved.kind !== 'file' || !existsSync(resolved.path))
      throw new Error(`source-backed audio asset is unavailable: ${clip.assetId}`);
    const source = probeSourceFile(resolved.path);
    if (!source.audio)
      throw new Error(`source-backed audio asset is not decodable: ${clip.assetId}`);
    const inputDurationUs = Math.round(clip.durationUs * playbackRate);
    const requiredEndUs = clip.sourceInUs + inputDurationUs;
    if (source.durationUs !== undefined && requiredEndUs > source.durationUs + 50_000)
      throw new Error(`source-backed range exceeds media duration: ${clip.assetId}`);
    const config = audio?.clips[clip.id];
    audioLayers.push({
      id: clip.id,
      assetId: clip.assetId,
      startUs: clip.startUs,
      durationUs: clip.durationUs,
      sourceInUs: clip.sourceInUs,
      playbackRate,
      path: resolved.path,
      gain: config?.gain ?? 1,
      pan: config?.pan ?? 0,
      mute: config?.mute ?? false,
      ...(config?.fadeInUs === undefined ? {} : { fadeInUs: config.fadeInUs }),
      ...(config?.fadeOutUs === undefined ? {} : { fadeOutUs: config.fadeOutUs }),
      ...((config as typeof config & { readonly busId?: string })?.busId === undefined
        ? {}
        : { busId: (config as typeof config & { readonly busId?: string }).busId }),
    });
  }
  return { clips, audio: audioLayers, transitions: transitions ?? [], buses };
}

function assertBasicTransform(
  objectId: string,
  transform: VisualObjectTransformV1,
  allowStaticRotation = false,
  allowStaticImageCrop = false,
  objectKind?: string,
): void {
  if (!allowStaticRotation && transform.rotationDeg !== 0)
    throw new Error(
      `source-backed export does not support rotationDeg on visual object ${objectId}`,
    );
  const crop = transform.crop;
  if (
    (crop.left !== 0 || crop.top !== 0 || crop.right !== 0 || crop.bottom !== 0) &&
    !(allowStaticImageCrop && objectKind === 'image')
  )
    throw new Error(`source-backed export does not support crop on visual object ${objectId}`);
  if (transform.positionZ !== undefined && transform.positionZ !== 0)
    throw new Error(`source-backed export does not support positionZ on visual object ${objectId}`);
}

function sourceBackedFfmpegArgs(
  clips: readonly SourceBackedClip[],
  audioLayers: readonly SourceBackedAudioLayer[],
  manifest: RenderManifest,
  outputPath: string,
  transitions: readonly TransitionV2[] = [],
  buses: readonly SourceBackedAudioBus[] = [{ id: 'master', gain: 1, pan: 0, mute: false }],
  masterLimiter?: MasterLimiterV2,
): readonly string[] {
  const filter: string[] = [];
  const frameRate = Number.isInteger(manifest.frameRate)
    ? String(manifest.frameRate)
    : manifest.frameRate.toFixed(6);
  const dissolve = transitions.length === 1 ? transitions[0] : undefined;
  if (transitions.length > 0 && (dissolve === undefined || clips.length !== 2))
    throw new RenderHostTransitionError();
  const gaps: { readonly startUs: number; readonly durationUs: number }[] = [];
  let cursorUs = 0;
  for (const clip of clips) {
    if (clip.startUs > cursorUs)
      gaps.push({ startUs: cursorUs, durationUs: clip.startUs - cursorUs });
    cursorUs = clip.startUs + clip.durationUs;
  }
  if (cursorUs < manifest.durationUs)
    gaps.push({ startUs: cursorUs, durationUs: manifest.durationUs - cursorUs });
  if (dissolve !== undefined && gaps.length > 0) throw new RenderHostTransitionError();
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index]!;
    const rate = clip.playbackRate;
    const videoTiming =
      dissolve === undefined || rate !== 1
        ? `,setpts=PTS/${rate},trim=duration=${seconds(clip.durationUs)}`
        : '';
    filter.push(
      `[${index}:v]scale=${manifest.width}:${manifest.height}:force_original_aspect_ratio=decrease,pad=${manifest.width}:${manifest.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1${videoTiming},fps=${frameRate},format=yuv420p[v${index}]`,
    );
    const bus = buses.find((item) => item.id === (clip.busId ?? 'master')) ?? buses[0]!;
    const left = (1 - Math.max(-1, Math.min(1, clip.pan + bus.pan))).toFixed(6);
    const right = (1 + Math.max(-1, Math.min(1, clip.pan + bus.pan))).toFixed(6);
    const gain = (clip.mute || bus.mute ? 0 : clip.gain * bus.gain).toFixed(6);
    if (clip.nativeAudio) {
      const fadeIn =
        clip.fadeInUs === undefined ? '' : `,afade=t=in:st=0:d=${seconds(clip.fadeInUs)}`;
      const fadeOut =
        clip.fadeOutUs === undefined
          ? ''
          : `,afade=t=out:st=${seconds(clip.durationUs - clip.fadeOutUs)}:d=${seconds(clip.fadeOutUs)}`;
      filter.push(
        `[${index}:a]aresample=48000,asetpts=PTS-STARTPTS${atempoFilter(rate)},volume=${gain},pan=stereo|c0=${left}*c0|c1=${right}*c1${fadeIn}${fadeOut},aformat=sample_rates=48000:channel_layouts=stereo${dissolve === undefined ? `,adelay=${Math.round(clip.startUs / 1000)}|${Math.round(clip.startUs / 1000)}` : ''}[a${index}]`,
      );
    } else if (dissolve !== undefined) {
      filter.push(
        `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${seconds(clip.durationUs)},asetpts=PTS-STARTPTS[a${index}]`,
      );
    }
  }
  const videoSequence: string[] = [];
  let gapIndex = 0;
  let sequenceCursorUs = 0;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index]!;
    if (clip.startUs > sequenceCursorUs) {
      const gap = gaps[gapIndex++]!;
      filter.push(
        `color=c=black:s=${manifest.width}x${manifest.height}:r=${frameRate}:d=${seconds(gap.durationUs)},format=yuv420p,setpts=PTS-STARTPTS[gap${gapIndex - 1}]`,
      );
      videoSequence.push(`[gap${gapIndex - 1}]`);
    }
    videoSequence.push(`[v${index}]`);
    sequenceCursorUs = clip.startUs + clip.durationUs;
  }
  if (sequenceCursorUs < manifest.durationUs) {
    const gap = gaps[gapIndex++]!;
    filter.push(
      `color=c=black:s=${manifest.width}x${manifest.height}:r=${frameRate}:d=${seconds(gap.durationUs)},format=yuv420p,setpts=PTS-STARTPTS[gap${gapIndex - 1}]`,
    );
    videoSequence.push(`[gap${gapIndex - 1}]`);
  }
  if (dissolve === undefined) {
    filter.push(`${videoSequence.join('')}concat=n=${videoSequence.length}:v=1:a=0[vout]`);
  } else {
    filter.push(
      `[v0][v1]xfade=transition=fade:duration=${seconds(dissolve.durationUs)}:offset=${seconds(clips[0]!.durationUs - dissolve.durationUs)}[vout]`,
    );
  }
  const args: string[] = ['-y', '-nostdin', '-v', 'error'];
  for (const clip of clips) {
    args.push(
      '-ss',
      seconds(clip.sourceInUs),
      '-t',
      seconds(clip.inputDurationUs),
      '-i',
      clip.path,
    );
  }
  for (const layer of audioLayers)
    args.push(
      '-ss',
      seconds(layer.sourceInUs),
      '-t',
      seconds(layer.durationUs * layer.playbackRate),
      '-i',
      layer.path,
    );
  const audioLabels: string[] = [];
  const nativeAudioLabels: string[] = [];
  for (const clip of clips) {
    const native = clips.indexOf(clip);
    if (clip.nativeAudio || dissolve !== undefined) nativeAudioLabels.push(`[a${native}]`);
  }
  if (dissolve !== undefined) {
    filter.push(
      `${nativeAudioLabels.join('')}acrossfade=d=${seconds(dissolve.durationUs)}:c1=tri:c2=tri[transitionAudio]`,
    );
    audioLabels.push('[transitionAudio]');
  } else audioLabels.push(...nativeAudioLabels);
  for (const [index, layer] of audioLayers.entries()) {
    const input = clips.length + index;
    const bus = buses.find((item) => item.id === (layer.busId ?? 'master')) ?? buses[0]!;
    const left = (1 - Math.max(-1, Math.min(1, layer.pan + bus.pan))).toFixed(6);
    const right = (1 + Math.max(-1, Math.min(1, layer.pan + bus.pan))).toFixed(6);
    const gain = (layer.mute || bus.mute ? 0 : layer.gain * bus.gain).toFixed(6);
    const fadeIn =
      layer.fadeInUs === undefined ? '' : `,afade=t=in:st=0:d=${seconds(layer.fadeInUs)}`;
    const fadeOut =
      layer.fadeOutUs === undefined
        ? ''
        : `,afade=t=out:st=${seconds(layer.durationUs - layer.fadeOutUs)}:d=${seconds(layer.fadeOutUs)}`;
    const label = `assetAudio${index}`;
    filter.push(
      `[${input}:a]aresample=48000,atrim=duration=${seconds(layer.durationUs * layer.playbackRate)},asetpts=PTS-STARTPTS${atempoFilter(layer.playbackRate)},volume=${gain},pan=stereo|c0=${left}*c0|c1=${right}*c1${fadeIn}${fadeOut},adelay=${Math.round(layer.startUs / 1000)}|${Math.round(layer.startUs / 1000)}[${label}]`,
    );
    audioLabels.push(`[${label}]`);
  }
  filter.push(
    `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${seconds(manifest.durationUs)}[silence]`,
  );
  const master = buses.find((item) => item.id === 'master');
  const masterMix = `${audioLabels.join('')}[silence]amix=inputs=${audioLabels.length + 1}:duration=longest:dropout_transition=0:normalize=1,atrim=duration=${seconds(manifest.durationUs)},asetpts=PTS-STARTPTS,volume=${((master?.mute ? 0 : master?.gain) ?? 1).toFixed(6)},pan=stereo|c0=${(1 - (master?.pan ?? 0)).toFixed(6)}*c0|c1=${(1 + (master?.pan ?? 0)).toFixed(6)}*c1`;
  const limiter =
    masterLimiter === undefined
      ? ''
      : `,alimiter=limit=${Math.pow(10, masterLimiter.ceilingDb / 20).toFixed(8)}:attack=1:release=${(masterLimiter.releaseUs / 1000).toFixed(3)}:level=disabled`;
  filter.push(`${masterMix}${limiter}[aout]`);
  args.push(
    '-filter_complex',
    filter.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-t',
    seconds(manifest.durationUs),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    outputPath,
  );
  return args;
}

/** FFmpeg atempo accepts [0.5,2] per stage; chaining keeps the schema's
 * 0.1–8× range while preserving pitch as the clip is sped up or slowed down. */
function atempoFilter(rate: number): string {
  if (rate === 1) return '';
  const stages: number[] = [];
  let remaining = rate;
  while (remaining > 2) {
    stages.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    stages.push(0.5);
    remaining /= 0.5;
  }
  stages.push(remaining);
  return stages.map((stage) => `,atempo=${stage.toFixed(8)}`).join('');
}

function probeSourceFile(path: string): {
  readonly video: boolean;
  readonly audio: boolean;
  readonly durationUs?: number;
  readonly videoDurationUs?: number;
  readonly audioDurationUs?: number;
} {
  const result = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,duration:format=duration',
      '-of',
      'json',
      path,
    ],
    { shell: false, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error('source media could not be decoded by ffprobe');
  try {
    const parsed = JSON.parse(result.stdout) as {
      streams?: readonly { readonly codec_type?: string; readonly duration?: string }[];
      format?: { readonly duration?: string };
    };
    const streams = parsed.streams ?? [];
    const videoStream = streams.find((stream) => stream.codec_type === 'video');
    const audioStream = streams.find((stream) => stream.codec_type === 'audio');
    const duration = Number(parsed.format?.duration ?? videoStream?.duration);
    const videoDuration = Number(videoStream?.duration);
    const audioDuration = Number(audioStream?.duration);
    return {
      video: streams.some((stream) => stream.codec_type === 'video'),
      audio: streams.some((stream) => stream.codec_type === 'audio'),
      ...(Number.isFinite(duration) ? { durationUs: Math.round(duration * 1_000_000) } : {}),
      ...(Number.isFinite(videoDuration)
        ? { videoDurationUs: Math.round(videoDuration * 1_000_000) }
        : {}),
      ...(Number.isFinite(audioDuration)
        ? { audioDurationUs: Math.round(audioDuration * 1_000_000) }
        : {}),
    };
  } catch {
    throw new Error('source media probe returned invalid metadata');
  }
}

function seconds(us: number): string {
  return (us / 1_000_000).toFixed(6);
}

export async function* renderBundleFrames(
  bundle: RenderBundleV1,
  frameCount: number,
  manifest: RenderManifest = manifestFromBundle(bundle),
  options?: { readonly mediaResolver?: RenderHostMediaResolver; readonly page?: OfflineRenderPage },
): AsyncIterable<Uint8Array> {
  if (options?.mediaResolver !== undefined) {
    yield* renderResolvedFrameInputs(
      streamFrameInputsForExport({
        bundle,
        mediaResolver: options.mediaResolver,
        frameCount,
        manifest,
        contentCache: createMediaContentCache(),
      }),
      options.page,
    );
    return;
  }
  for (const input of collectPlannedFrames(bundle, frameCount, manifest)) {
    const rendered = renderHeadlessFrame(input.plan.frame);
    yield rendered.pixels;
  }
}

export async function collectFrameInputsForExport(input: {
  readonly bundle: RenderBundleV1;
  readonly mediaResolver: RenderHostMediaResolver;
  readonly frameCount: number;
  readonly manifest?: RenderManifest;
}): Promise<readonly RenderHostFrameInputV1[]> {
  const result: RenderHostFrameInputV1[] = [];
  for await (const frameInput of streamFrameInputsForExport({
    ...input,
    manifest: input.manifest ?? manifestFromBundle(input.bundle),
    contentCache: createMediaContentCache(),
  })) {
    result.push(frameInput);
  }
  return result;
}

async function* streamFrameInputsForExport(input: {
  readonly bundle: RenderBundleV1;
  readonly mediaResolver: RenderHostMediaResolver;
  readonly frameCount: number;
  readonly manifest: RenderManifest;
  readonly contentCache: MediaContentCache;
}): AsyncIterable<RenderHostFrameInputV1> {
  const manifest = input.manifest ?? manifestFromBundle(input.bundle);
  for (const { plan } of iteratePlannedFrames(input.bundle, input.frameCount, manifest)) {
    const blockingFinding = plan.findings.find((finding) => finding.severity === 'error');
    if (blockingFinding !== undefined) throw new Error(blockingFinding.message);
    yield {
      plan,
      videoSamples: await Promise.all(
        plan.videoSamples.map(async (sample) => ({
          ...sample,
          media: await resolveAssetInput(
            input.bundle,
            input.mediaResolver,
            input.contentCache,
            sample.assetId,
          ),
        })),
      ),
      stillBitmaps: await Promise.all(
        plan.captureRequirements
          .filter(
            (requirement) =>
              requirement.kind === 'still-bitmap' && requirement.assetId !== undefined,
          )
          .map(async (requirement) => ({
            ...requirement,
            media: await resolveAssetInput(
              input.bundle,
              input.mediaResolver,
              input.contentCache,
              requirement.assetId!,
            ),
          })),
      ),
      htmlScenes: await Promise.all(
        plan.captureRequirements
          .filter(
            (requirement) => requirement.kind === 'html-scene' && requirement.assetId !== undefined,
          )
          .map(async (requirement) => ({
            ...requirement,
            media: await resolveAssetInput(
              input.bundle,
              input.mediaResolver,
              input.contentCache,
              requirement.assetId!,
            ),
          })),
      ),
      motionScenes: await Promise.all(
        plan.captureRequirements
          .filter(
            (requirement) =>
              requirement.kind === 'motion-scene' && requirement.assetId !== undefined,
          )
          .map(async (requirement) => {
            const motionScene = (
              input.bundle.assets[requirement.assetId!] as unknown as {
                motionScene?: RenderHostResolvedCapture['motionScene'];
              }
            ).motionScene;
            return {
              ...requirement,
              media: await resolveAssetInput(
                input.bundle,
                input.mediaResolver,
                input.contentCache,
                requirement.assetId!,
              ),
              ...(motionScene === undefined ? {} : { motionScene }),
            };
          }),
      ),
      audioSamples: await Promise.all(
        plan.audioSamples.map(async (sample) => ({
          ...sample,
          media: await resolveAssetInput(
            input.bundle,
            input.mediaResolver,
            input.contentCache,
            sample.assetId,
          ),
        })),
      ),
    };
  }
}

function collectPlannedFrames(
  bundle: RenderBundleV1,
  frameCount: number,
  manifest: RenderManifest,
): readonly Pick<RenderHostFrameInputV1, 'plan'>[] {
  return [...iteratePlannedFrames(bundle, frameCount, manifest)];
}

function* iteratePlannedFrames(
  bundle: RenderBundleV1,
  frameCount: number,
  manifest: RenderManifest,
): Iterable<Pick<RenderHostFrameInputV1, 'plan'>> {
  const imageSizesByObjectId = imageSizesForBundle(bundle);
  for (let index = 0; index < frameCount; index++) {
    yield {
      plan: planRenderFrame({
        bundle,
        timeUs: timeUsForFrame(index, manifest.frameRate),
        viewport: { width: manifest.width, height: manifest.height },
        imageSizesByObjectId,
      }),
    };
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

async function* renderResolvedFrameInputs(
  inputs: AsyncIterable<RenderHostFrameInputV1>,
  page?: OfflineRenderPage,
): AsyncIterable<Uint8Array> {
  for await (const input of inputs) {
    const width = input.plan.frame.viewport.width;
    const height = input.plan.frame.viewport.height;
    const pixels =
      page === undefined ? renderHeadlessFrame(input.plan.frame).pixels : await page.paint(input);
    if (pixels.length !== width * height * 4) {
      throw new RangeError(
        `offline render page returned ${pixels.length} bytes for ${width}x${height}`,
      );
    }
    yield applyResolvedMediaCaptures(pixels, width, height, input);
  }
}

async function resolveAssetInput(
  bundle: RenderBundleV1,
  resolver: RenderHostMediaResolver,
  contentCache: MediaContentCache,
  assetId: string,
): Promise<RenderHostResolvedInput> {
  const descriptor = bundle.assets[assetId];
  if (descriptor === undefined) throw new Error(`missing required asset descriptor: ${assetId}`);
  try {
    const resolved = resolver.require(descriptor.opaqueRef);
    resolver.describe(descriptor.opaqueRef);
    return {
      opaqueRef: descriptor.opaqueRef,
      resolved,
      contentSha256: await contentCache.digest(descriptor.opaqueRef, resolved),
    };
  } catch (error) {
    throw new Error(`missing required asset ${assetId}: ${(error as Error).message}`);
  }
}

interface MediaContentCache {
  digest(opaqueRef: string, resolved: RenderHostResolvedInput['resolved']): Promise<string>;
}

function createMediaContentCache(): MediaContentCache {
  const digests = new Map<string, Promise<string>>();
  return {
    digest(opaqueRef, resolved) {
      const key = resolvedMediaCacheKey(opaqueRef, resolved);
      let digest = digests.get(key);
      if (digest === undefined) {
        digest = digestResolvedMediaContent(opaqueRef, resolved);
        digests.set(key, digest);
      }
      return digest;
    },
  };
}

function resolvedMediaCacheKey(
  opaqueRef: string,
  resolved: RenderHostResolvedInput['resolved'],
): string {
  switch (resolved.kind) {
    case 'file':
      return `${opaqueRef}:file:${resolved.path}`;
    case 'html-scene':
      return `${opaqueRef}:html-scene:${resolved.packageId}`;
    case 'stream':
      return `${opaqueRef}:stream`;
  }
}

async function digestResolvedMediaContent(
  opaqueRef: string,
  resolved: RenderHostResolvedInput['resolved'],
): Promise<string> {
  if (resolved.kind === 'html-scene') {
    const scene = findFirstPartyScene(resolved.packageId);
    if (scene === undefined)
      throw new Error(`published HTML scene is unavailable: ${resolved.packageId}`);
    return createHash('sha256').update(scene.source).digest('hex');
  }
  const hash = createHash('sha256');
  try {
    if (resolved.kind === 'file') {
      await stat(resolved.path);
      for await (const chunk of createReadStream(resolved.path, { highWaterMark: 64 * 1024 })) {
        hash.update(chunk);
      }
      return hash.digest('hex');
    }
    for await (const chunk of resolved.open()) {
      hash.update(chunk);
    }
    return hash.digest('hex');
  } catch {
    // Never echo a Worker-local filesystem path into a protocol/user-facing error.
    throw new Error(`resolved media content is unavailable for ${opaqueRef}`);
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
      key: `${sample.media.contentSha256}:${sample.clipId}:${sample.sourceTimeUs}:${sample.role}`,
      x: 0,
      y: 0,
      w: Math.max(1, Math.floor(width / 3)),
      h: Math.max(1, Math.floor(height / 3)),
    })),
    ...input.stillBitmaps.map((sample) => ({
      key: `${sample.media.contentSha256}:${sample.objectId ?? ''}:still`,
      x: Math.floor(width / 3),
      y: Math.floor(height / 3),
      w: Math.max(1, Math.floor(width / 4)),
      h: Math.max(1, Math.floor(height / 4)),
    })),
    ...input.htmlScenes.map((sample) => ({
      key: `${sample.media.contentSha256}:${sample.objectId ?? ''}:${sample.sourceTimeUs ?? 0}`,
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
  for (const capture of input.motionScenes ?? []) {
    if (capture.motionScene === undefined)
      throw new Error(
        `motion scene capture ${capture.objectId ?? capture.id} has no canonical snapshot`,
      );
    const scene = rasterizeStaticMotionScene(capture.motionScene.snapshot);
    const scale = Math.min(width / scene.width, height / scene.height) * 0.5;
    const x = Math.floor((width - scene.width * scale) / 2);
    const y = Math.floor((height - scene.height * scale) / 2);
    for (let dy = 0; dy < Math.max(1, Math.floor(scene.height * scale)); dy++) {
      for (let dx = 0; dx < Math.max(1, Math.floor(scene.width * scale)); dx++) {
        const sx = Math.min(scene.width - 1, Math.floor(dx / scale));
        const sy = Math.min(scene.height - 1, Math.floor(dy / scale));
        const tx = x + dx;
        const ty = y + dy;
        if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
        blendPixel(result, (ty * width + tx) * 4, scene.pixels, (sy * scene.width + sx) * 4, 1);
      }
    }
  }
  return result;
}

/** Pure Node-side static Motion capture. Dynamic/custom-code layers fail closed upstream. */
function rasterizeStaticMotionScene(scene: MotionSceneDocument): {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
} {
  const pixels = new Uint8Array(scene.width * scene.height * 4);
  const bg =
    scene.background.kind === 'solid' ? parseMotionColor(scene.background.color) : undefined;
  for (let i = 0; i < scene.width * scene.height; i++) {
    pixels[i * 4] = bg?.r ?? 0;
    pixels[i * 4 + 1] = bg?.g ?? 0;
    pixels[i * 4 + 2] = bg?.b ?? 0;
    pixels[i * 4 + 3] = bg === undefined ? 0 : 255;
  }
  for (const layer of scene.layers) {
    if (!layer.visible || layer.type !== 'shape' || layer.animations.length > 0) continue;
    const fill = layer.fills.find((item) => item.kind === 'solid');
    if (fill === undefined) continue;
    const color = parseMotionColor(fill.color);
    const alpha = Math.max(0, Math.min(1, fill.opacity * layer.transform.opacity));
    const left = Math.max(0, Math.floor(layer.transform.x));
    const top = Math.max(0, Math.floor(layer.transform.y));
    const right = Math.min(
      scene.width,
      Math.ceil(layer.transform.x + layer.transform.width * layer.transform.scaleX),
    );
    const bottom = Math.min(
      scene.height,
      Math.ceil(layer.transform.y + layer.transform.height * layer.transform.scaleY),
    );
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++)
        blendRgba(pixels, (y * scene.width + x) * 4, { ...color, a: 255 }, alpha);
  }
  return { width: scene.width, height: scene.height, pixels };
}

function parseMotionColor(value: string | undefined): {
  readonly r: number;
  readonly g: number;
  readonly b: number;
} {
  const match = /^#([0-9a-f]{6})$/i.exec(value ?? '');
  if (match === null) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(match[1]!.slice(0, 2), 16),
    g: parseInt(match[1]!.slice(2, 4), 16),
    b: parseInt(match[1]!.slice(4, 6), 16),
  };
}

async function* renderAudioPcm(
  inputs: AsyncIterable<RenderHostFrameInputV1> | Iterable<RenderHostFrameInputV1>,
  manifest: RenderManifest,
): AsyncIterable<Uint8Array> {
  const sampleRate = 48_000;
  let absoluteSample = 0;
  for await (const input of inputs) {
    const samplesThisFrame = Math.max(1, Math.round(sampleRate / manifest.frameRate));
    const chunk = new Uint8Array(samplesThisFrame * 4);
    const view = new DataView(chunk.buffer);
    const audioKey = input.audioSamples
      .map(
        (sample) =>
          `${sample.media.contentSha256}:${sample.sourceTimeUs}:${sample.gain}:${sample.pan}`,
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

export function renderHostAudioPcmForTest(
  inputs: AsyncIterable<RenderHostFrameInputV1> | Iterable<RenderHostFrameInputV1>,
  manifest?: RenderManifest,
): AsyncIterable<Uint8Array> {
  return renderAudioPcm(
    inputs,
    manifest ??
      freezeManifest({
        projectId: 'test',
        revision: 0,
        width: 1,
        height: 1,
        frameRate: 30,
        durationUs: 100_000,
        preset: 'social-h264-aac',
      }),
  );
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
