import type { ColorGradeIR, EffectInstanceIR, RenderFrameIR } from '@joy-media/render-ir';
import { evaluateCameraExpressionTransform } from '@joy-media/evaluator';
import {
  buildRenderFrameIR,
  evaluateEffectInstances,
  isBoundObjectActive,
  transformToRenderTransform,
  type ResolvedObject,
} from '@joy-media/visual-object-renderer';
import {
  createHtmlMediaDecoder,
  videoFrameNodeFromDecoded,
  withVideoFrameNodes,
  type DecodedFrame,
  type VideoClipSpec,
} from '@joy-media/playback-engine';
import type {
  JoyProjectV1,
  SpikeProject,
  VideoClip,
  VisualObjectV1,
} from '@joy-media/project-schema';
import {
  createBrowserPixiRenderer,
  type BrowserPixiRenderer,
  type BrowserVideoFrameBitmap,
} from '@joy-media/renderer-pixi/browser';
import type { ImageDataLike } from '@joy-media/playback-engine';
import type { ExportFrameSource } from '../export-frame-source.js';
import { createProjectColorLutResolver } from '../project-color-luts.js';
import { seekUsForSource } from '../export-seek-target.js';
import { loadDetachedVideo, seekDetachedVideo } from '../export-preload.js';
import { createAnimatedImageFrameSource } from '../animated-image-decoder.js';
import { inspectImageAnimation } from '../animated-image-metadata.js';
import { StickerImageCache } from '../sticker-image-cache.js';
import { HtmlSceneSurfaceCache } from '../html-scene-surfaces.js';
import { hiddenClipIds } from '../timeline-hidden-clips.js';
import {
  applyClipGradesToTransitionBitmaps,
  activeTransitionAt,
  colorGradeForClipAtTime,
  findVideoClipById,
  renderFrameOptions,
  transitionClipTimes,
} from '../preview-frame-helpers.js';
import { withCaptionBurnInNodes } from '../caption-burn-in.js';
import { waitForContentFonts } from '../font-readiness.js';
import { effectInstancesForTimelineClip } from '../adjustment-render.js';
import { resolveObjectIdForSelection } from '../sticker-bindings.js';
import { readImageMatteMap } from '../sticker-bindings.js';
import { sourceTimeForTransitionSample } from '../transition-source-time.js';
import { flattenRootTimelineVideoClips } from '../timeline-nested-playback.js';
import { releaseMediaObjectUrl } from '../media-object-url.js';
import {
  readTimelineElementKindMap,
  timelineElementKindForClip,
} from '../timeline-element-kind.js';
import type {
  CompositionObservationRequest,
  IsolatedCompositionReadback,
} from './composition-observer.js';

export type ProjectAssetBlobLoader = (assetId: string) => Promise<Blob | undefined>;

export interface IsolatedCompositionCaptureInput {
  readonly visualProject: JoyProjectV1;
  readonly timelineProject: SpikeProject;
  readonly loadProjectAssetBlob: ProjectAssetBlobLoader;
}

export interface IsolatedCompositionCapture {
  readonly composition: Omit<CompositionObservationRequest, 'outputTimesUs'>;
  readonly release: () => void;
}

interface VideoResource {
  readonly forward: ExportFrameSource | undefined;
  readonly video?: HTMLVideoElement;
  readonly decoder?: ReturnType<typeof createHtmlMediaDecoder>;
  readonly url?: string;
  readonly still?: ImageDataLike;
  readonly animated?: ReturnType<typeof createAnimatedImageFrameSource> extends Promise<infer T>
    ? T
    : never;
  readonly seek: (
    sourceUs: number,
    token: number,
    signal: AbortSignal,
  ) => Promise<DecodedFrame | undefined>;
}

const MAX_CAPTURE_PIXELS = 1_920 * 1_080;

/** Builds one saved-project capture session. The renderer is opened on the first sample. */
export function createIsolatedCompositionCapture(
  input: IsolatedCompositionCaptureInput,
): IsolatedCompositionCapture {
  const visualProject = cloneProject(input.visualProject);
  const timelineProject = cloneProject(input.timelineProject);
  const loader = input.loadProjectAssetBlob;
  const assets = new Map<string, Blob>();
  const stickerCache = new StickerImageCache();
  const sceneCache = new HtmlSceneSurfaceCache();
  const objectSizes: Record<string, { width: number; height: number }> = {};
  let rendererPromise: Promise<BrowserPixiRenderer> | undefined;
  let closed = false;
  const videoResources = new Map<string, VideoResource>();
  const colorLutResolver = createProjectColorLutResolver({
    project: visualProject,
    loadProjectAssetBlob: loader,
  });

  const composition: Omit<CompositionObservationRequest, 'outputTimesUs'> = {
    snapshot: {
      kind: 'canonical',
      compositionId: visualProject.rootCompositionId,
      projectRevision: visualProject.updatedAt || visualProject.id,
      rendererVersion: 'pixi-browser-v1',
      evaluatorVersion: 'joy-frame-evaluator-v1',
      dependencyDigests: [],
      state: { projectId: visualProject.id, revision: visualProject.updatedAt || visualProject.id },
    },
    readiness: {
      check: async (_snapshot, signal) => {
        signal.throwIfAborted();
        let font: 'ready' | 'missing' = 'ready';
        try {
          await waitForContentFonts(requiredFonts(visualProject));
        } catch {
          signal.throwIfAborted();
          font = 'missing';
        }
        await colorLutResolver.prepareProjectColorLuts();
        signal.throwIfAborted();
        return { asset: 'ready', font, scene: 'ready', shader: 'ready' };
      },
    },
    evaluator: {
      version: 'joy-frame-evaluator-v1',
      evaluate: async (_snapshot, timeUs, signal) => {
        signal.throwIfAborted();
        const root = visualProject.compositions[visualProject.rootCompositionId];
        if (root === undefined) throw new Error('Root composition is unavailable');
        if (root.width * root.height > MAX_CAPTURE_PIXELS)
          throw new Error('Capture frame exceeds limit');
        await prepareImages(timeUs, signal);
        return buildFrame(timeUs, root.width, root.height);
      },
    },
    renderer: {
      version: 'pixi-browser-v1',
      renderAndReadback: async (frame, request) => {
        if (closed) throw new Error('Capture session is closed');
        request.signal.throwIfAborted();
        const { width, height } = frame.viewport;
        const renderer = await (rendererPromise ??= createBrowserPixiRenderer({
          width,
          height,
          resolution: 1,
          resolveColorLut: colorLutResolver.resolveColorLut,
        }));
        const decodedVideos = await decodeFrameVideos(frame, request.outputTimeUs, request.signal);
        request.signal.throwIfAborted();
        const bitmaps = await capturePrivateBitmaps(
          request.outputTimeUs,
          width,
          height,
          request.signal,
        );
        for (const [id, bitmap] of decodedVideos.bitmaps) bitmaps.set(id, bitmap);
        applyClipGradesToTransitionBitmaps(
          visualProject,
          activeTransition(visualProject, timelineProject, request.outputTimeUs),
          request.outputTimeUs,
          bitmaps,
          colorLutResolver.resolveColorLut,
        );
        const renderFrame = withVideoFrameNodes(frame, decodedVideos.nodes);
        for (const node of renderFrame.nodes) {
          if (node.kind === 'video-frame' && !bitmaps.has(node.id))
            throw new Error('Visible image frame could not be captured');
        }
        renderer.render(renderFrame, bitmaps);
        const pixels = renderer.readPixels(width, height);
        if (pixels === undefined || pixels.width !== width || pixels.height !== height)
          throw new Error('Capture readback is unavailable');
        return {
          width: pixels.width,
          height: pixels.height,
          data: pixels.data,
        } satisfies IsolatedCompositionReadback;
      },
    },
  };

  function buildFrame(timeUs: number, width: number, height: number): RenderFrameIR {
    const cameraId = visualProject.compositions[visualProject.rootCompositionId]?.activeCameraId;
    const objectsById = visualProject.visualObjects as Readonly<Record<string, VisualObjectV1>>;
    const hidden = hiddenClipIds(timelineProject);
    const resolved: ResolvedObject[] = Object.values(objectsById)
      .filter((object) => isBoundObjectActive(visualProject, object.id, timeUs, hidden))
      .map((object) => ({
        object,
        transform: evaluateCameraExpressionTransform(
          object.id,
          cameraId,
          objectsById,
          timeUs,
          height,
        ).transform,
      }));
    return withCaptionBurnInNodes(
      buildRenderFrameIR(
        visualProject.rootCompositionId,
        timeUs,
        width,
        height,
        resolved,
        renderFrameOptions(visualProject, timelineProject, timeUs, objectSizes),
      ),
      visualProject,
    );
  }

  async function prepareImages(timeUs: number, signal: AbortSignal): Promise<void> {
    const hidden = hiddenClipIds(timelineProject);
    const mattes = readImageMatteMap(visualProject);
    const images = Object.values(visualProject.visualObjects).filter(
      (object) =>
        object.kind === 'image' && isBoundObjectActive(visualProject, object.id, timeUs, hidden),
    );
    for (const object of images) {
      signal.throwIfAborted();
      const assetId = object.assetId;
      if (assetId === undefined) throw new Error('Image asset is unavailable');
      const asset = visualProject.assets[assetId];
      const bitmap = await stickerCache.syncObject({
        objectId: object.id,
        assetId,
        ...(mattes[object.id] === undefined ? {} : { matteAssetId: mattes[object.id] }),
        crop: object.transform.crop,
        ...(asset?.descriptor?.animation === undefined
          ? {}
          : { animation: asset.descriptor.animation }),
        ...(asset?.descriptor?.mimeType === undefined
          ? {}
          : { mimeType: asset.descriptor.mimeType }),
        loadBlob: getBlob,
      });
      if (bitmap === undefined) throw new Error('Image decode failed');
      objectSizes[object.id] = { width: bitmap.width, height: bitmap.height };
    }
  }

  async function capturePrivateBitmaps(
    timeUs: number,
    width: number,
    height: number,
    signal: AbortSignal,
  ) {
    const bitmaps = new Map<string, BrowserVideoFrameBitmap>();
    const hidden = hiddenClipIds(timelineProject);
    const activeObjectIds = new Set(
      Object.values(visualProject.visualObjects)
        .filter((object) => isBoundObjectActive(visualProject, object.id, timeUs, hidden))
        .map((object) => object.id),
    );
    for (const [id, bitmap] of stickerCache.bitmaps(timeUs)) {
      if (activeObjectIds.has(id)) bitmaps.set(id, bitmap);
    }
    const scenes = Object.values(visualProject.visualObjects).filter(
      (object) =>
        object.kind === 'html-scene' &&
        isBoundObjectActive(visualProject, object.id, timeUs, hidden),
    );
    if (scenes.length > 0) {
      const activeScenes = Object.fromEntries(scenes.map((object) => [object.id, object]));
      const captured = await sceneCache.captureFull(activeScenes, timeUs, {
        width,
        height,
        signal,
      });
      if (captured.size !== scenes.length) throw new Error('HTML scene capture is incomplete');
      for (const [id, bitmap] of captured) bitmaps.set(id, bitmap);
    }
    return bitmaps;
  }

  async function decodeFrameVideos(frame: RenderFrameIR, timeUs: number, signal: AbortSignal) {
    const nodes = [];
    for (const clip of flattenRootTimelineVideoClips(timelineProject)) {
      if (timeUs > clip.startUs + clip.durationUs + 1_000_000)
        closeVideoResource(videoResources, clip.id);
    }
    const clips = activeVideoClips(timelineProject, visualProject, timeUs);
    const transition = activeTransition(visualProject, timelineProject, timeUs);
    const hidden = hiddenClipIds(timelineProject);
    const elementKinds = readTimelineElementKindMap(visualProject);
    const candidates = [...clips];
    for (const id of transition === undefined
      ? []
      : [transition.leftClipId, transition.rightClipId]) {
      const clip = findVideoClipById(timelineProject, id);
      if (
        clip !== undefined &&
        !hidden.has(clip.id) &&
        timelineElementKindForClip(clip, elementKinds) === 'video' &&
        !candidates.some((item) => item.id === clip.id)
      )
        candidates.push(clip);
    }
    const bitmaps = new Map<string, ImageDataLike>();
    for (const clip of candidates) {
      signal.throwIfAborted();
      const resource = await videoForClip(clip, signal);
      const sourceUs = sourceTimeForTransitionSample(clip, timeUs, transition);
      if (resource.still !== undefined) {
        const bitmap = copyPixels(resource.still);
        bitmaps.set(clip.id, bitmap);
        nodes.push(
          videoFrameNodeFromDecoded(
            videoClipSpecAt(visualProject, timelineProject, clip, timeUs, frame.viewport.height),
            {
              assetId: clip.assetId,
              bitmap,
              sourceTimeUs: clip.sourceInUs,
              token: `still:${clip.assetId}`,
            },
            { width: bitmap.width, height: bitmap.height },
          ),
        );
        continue;
      }
      if (resource.animated !== undefined) {
        const image = resource.animated.frameAt(sourceUs - clip.sourceInUs);
        const bitmap = copyPixels(image.bitmap);
        bitmaps.set(clip.id, bitmap);
        nodes.push(
          videoFrameNodeFromDecoded(
            videoClipSpecAt(visualProject, timelineProject, clip, timeUs, frame.viewport.height),
            {
              assetId: clip.assetId,
              bitmap,
              sourceTimeUs: sourceUs,
              token: `animated:${clip.assetId}:${image.startUs}`,
            },
            { width: bitmap.width, height: bitmap.height },
          ),
        );
        continue;
      }
      const decoded =
        resource.forward === undefined
          ? undefined
          : await resource.forward.frameAt(sourceUs, timeUs, signal);
      const frameDecoded = decoded ?? (await resource.seek(sourceUs, timeUs, signal));
      if (frameDecoded?.bitmap === undefined)
        throw new Error('Visible video frame could not be decoded');
      const bitmap = copyPixels(frameDecoded.bitmap);
      bitmaps.set(clip.id, bitmap);
      const copiedFrame = { ...frameDecoded, bitmap };
      const currentResource = videoResources.get(clip.id) ?? resource;
      const intrinsic =
        decoded === undefined
          ? {
              width: currentResource.video?.videoWidth ?? 0,
              height: currentResource.video?.videoHeight ?? 0,
            }
          : resource.forward!.size();
      nodes.push(
        videoFrameNodeFromDecoded(
          videoClipSpecAt(visualProject, timelineProject, clip, timeUs, frame.viewport.height),
          copiedFrame,
          intrinsic,
        ),
      );
    }
    return { nodes, bitmaps };
  }

  async function videoForClip(clip: VideoClip, signal: AbortSignal): Promise<VideoResource> {
    const cached = videoResources.get(clip.id);
    if (cached !== undefined) return cached;
    const blob = await getBlob(clip.assetId);
    const asset = visualProject.assets[clip.assetId];
    const mimeType = asset?.descriptor?.mimeType ?? '';
    const imageAnimation =
      asset?.kind !== 'image'
        ? undefined
        : (asset.descriptor?.animation ??
          inspectImageAnimation(await blob.arrayBuffer(), mimeType));
    if (asset?.kind === 'image' && imageAnimation !== undefined) {
      const animated = await createAnimatedImageFrameSource(blob, imageAnimation);
      const resource = {
        forward: undefined,
        video: undefined as unknown as HTMLVideoElement,
        decoder: undefined as never,
        url: '',
        animated,
        seek: async () => undefined,
      } satisfies VideoResource;
      videoResources.set(clip.id, resource);
      return resource;
    }
    if (asset?.kind === 'image') {
      const bitmap = await decodeBlobPixels(blob);
      const resource = {
        forward: undefined,
        video: undefined as unknown as HTMLVideoElement,
        decoder: undefined as never,
        url: '',
        still: bitmap,
        seek: async () => undefined,
      } satisfies VideoResource;
      videoResources.set(clip.id, resource);
      return resource;
    }
    let forward: ExportFrameSource | undefined;
    if (clip.reversed !== true && clip.timeRemap?.direction !== 'reverse') {
      const { openExportFrameSource } = await import('../export-frame-source.js');
      forward = await openExportFrameSource(blob, clip.assetId, { signal });
    }
    let video: HTMLVideoElement | undefined;
    let decoder: ReturnType<typeof createHtmlMediaDecoder> | undefined;
    let url: string | undefined;
    const resource: VideoResource = {
      forward,
      seek: async (sourceUs, token, seekSignal) => {
        seekSignal.throwIfAborted();
        if (video === undefined || decoder === undefined) {
          video = document.createElement('video');
          url = URL.createObjectURL(blob);
          video.muted = true;
          videoResources.set(clip.id, { ...resource, video, url });
          try {
            await loadDetachedVideo(video, url, seekSignal);
            decoder = createHtmlMediaDecoder(video, document.createElement('canvas'));
            videoResources.set(clip.id, { ...resource, video, decoder, url });
          } catch (error) {
            closeVideoResource(videoResources, clip.id);
            throw error;
          }
        }
        const sourceTimeUs = seekUsForSource(sourceUs, forward?.seekTiming);
        await seekDetachedVideo(video, sourceTimeUs, seekSignal);
        if (video.readyState < 2) throw new Error('Video frame is not ready');
        seekSignal.throwIfAborted();
        const decoded = decoder.captureCurrentFrame(token);
        if (decoded.bitmap === undefined) throw new Error('Video frame could not be captured');
        if (video.readyState < 2) throw new Error('Video frame is not ready');
        return { ...decoded, bitmap: copyPixels(decoded.bitmap) };
      },
    };
    videoResources.set(clip.id, resource);
    return resource;
  }

  async function getBlob(assetId: string): Promise<Blob> {
    const existing = assets.get(assetId);
    if (existing !== undefined) return existing;
    const blob = await loader(assetId);
    if (blob === undefined) throw new Error('Required project media is unavailable');
    assets.set(assetId, blob);
    return blob;
  }

  return {
    composition,
    release() {
      if (closed) return;
      closed = true;
      void rendererPromise?.then(
        (renderer) => renderer.destroy(),
        () => undefined,
      );
      for (const id of videoResources.keys()) closeVideoResource(videoResources, id);
      stickerCache.clear();
      sceneCache.destroy();
      assets.clear();
    },
  };
}

/** Kept as a tested copy of App.tsx's private videoClipSpecAt glue. */
export function videoClipSpecAt(
  project: JoyProjectV1,
  timeline: SpikeProject,
  clip: VideoClip,
  timeUs: number,
  height: number,
): VideoClipSpec {
  const colorGrade = colorGradeForClipAtTime(project, clip, timeUs);
  const objectId = resolveObjectIdForSelection(project, [clip.id]);
  const object = objectId === undefined ? undefined : project.visualObjects[objectId];
  const effectInstances = effectInstancesForTimelineClip(project, timeline, clip.id, timeUs);
  const effects = evaluateEffectInstances(effectInstances, timeUs, project.propertyAnimations);
  if (object === undefined) return baseVideoClipSpec(clip, undefined, 1, colorGrade, effects);
  const evaluated = evaluateCameraExpressionTransform(
    object.id,
    project.compositions[project.rootCompositionId]?.activeCameraId,
    project.visualObjects,
    timeUs,
    height,
  ).transform;
  return baseVideoClipSpec(
    clip,
    transformToRenderTransform(evaluated),
    evaluated.opacity,
    colorGrade,
    effects,
  );
}

function baseVideoClipSpec(
  clip: VideoClip,
  transform: VideoClipSpec['transform'] | undefined,
  opacity: number,
  colorGrade: ColorGradeIR | undefined,
  effects: readonly EffectInstanceIR[] | undefined,
): VideoClipSpec {
  return {
    id: clip.id,
    originalToken: clip.assetId,
    startUs: clip.startUs,
    durationUs: clip.durationUs,
    sourceInUs: clip.sourceInUs,
    transform: transform ?? { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
    opacity,
    zIndex: 0,
    ...(colorGrade === undefined ? {} : { colorGrade }),
    ...(effects === undefined ? {} : { effects }),
  };
}

function activeVideoClips(
  timeline: SpikeProject,
  project: JoyProjectV1,
  timeUs: number,
): VideoClip[] {
  const hidden = hiddenClipIds(timeline);
  const kinds = readTimelineElementKindMap(project);
  return flattenRootTimelineVideoClips(timeline).filter(
    (clip) =>
      !hidden.has(clip.id) &&
      timelineElementKindForClip(clip, kinds) === 'video' &&
      timeUs >= clip.startUs &&
      timeUs < clip.startUs + clip.durationUs &&
      project.assets[clip.assetId]?.kind !== 'audio',
  );
}

function closeVideoResource(resources: Map<string, VideoResource>, clipId: string): void {
  const resource = resources.get(clipId);
  if (resource === undefined) return;
  resources.delete(clipId);
  resource.forward?.close();
  resource.animated?.dispose();
  if (resource.video !== undefined && resource.url !== undefined)
    releaseMediaObjectUrl(resource.video, resource.url);
}

function activeTransition(project: JoyProjectV1, timeline: SpikeProject, timeUs: number) {
  return activeTransitionAt(project, timeUs, transitionClipTimes(timeline));
}

function requiredFonts(project: JoyProjectV1): string[] {
  return [
    ...new Set(
      Object.values(project.visualObjects)
        .flatMap((object) =>
          object.kind !== 'text'
            ? []
            : [
                object.textStyle?.fontFamily ?? '',
                ...(object.textDocument?.blocks ?? []).flatMap((block) =>
                  block.runs.map((run) => run.style?.fontFamily ?? ''),
                ),
              ],
        )
        .filter(Boolean),
    ),
  ];
}

async function decodeBlobPixels(blob: Blob): Promise<ImageDataLike> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('Image surface is unavailable');
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

function copyPixels(bitmap: ImageDataLike): ImageDataLike {
  return {
    width: bitmap.width,
    height: bitmap.height,
    data: new Uint8ClampedArray(bitmap.data),
  };
}

function cloneProject<T>(value: T): T {
  return structuredClone(value);
}
