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
import { captionCuesAt, layoutTemplatedCaptionNodes } from '@joy-media/captions-core';
import type { NodeBounds, TextNode } from '@joy-media/render-ir';
import type { TimelineQcTextBox } from './qc-sampler.js';
import type { ExportFrameSource } from '../export-frame-source.js';
import { createProjectColorLutResolver } from '../project-color-luts.js';
import { seekUsForSource, type SeekFrameTiming } from '../export-seek-target.js';
import { loadDetachedVideo, seekDetachedVideo } from '../export-preload.js';
import { runExportPreloadStage, EXPORT_PRELOAD_TIMEOUT_MS } from '../export-preload.js';
import { createAnimatedImageFrameSource } from '../animated-image-decoder.js';
import { inspectImageAnimation } from '../animated-image-metadata.js';
import { StickerImageCache } from '../sticker-image-cache.js';
import { HtmlSceneSurfaceCache } from '../html-scene-surfaces.js';
import { hiddenClipIds } from '../timeline-hidden-clips.js';
import {
  applyClipGradesToTransitionBitmaps,
  activeTransitionAt,
  colorGradeForClipAtTime,
  renderFrameOptions,
  transitionClipTimes,
} from '../preview-frame-helpers.js';
import { withCaptionBurnInNodes } from '../caption-burn-in.js';
import { waitForContentFonts } from '../font-readiness.js';
import { effectInstancesForTimelineClip } from '../adjustment-render.js';
import { readClipObjectIdsMap, resolveObjectIdForSelection } from '../sticker-bindings.js';
import { readImageMatteMap } from '../sticker-bindings.js';
import { sourceTimeForTransitionSample } from '../transition-source-time.js';
import {
  flattenRootTimelineVideoClips,
  type RootTimelineVideoClip,
} from '../timeline-nested-playback.js';
import { releaseMediaObjectUrl, revokeDetachedObjectUrl } from '../media-object-url.js';
import { isExportVisualTimelineClip } from '../export-media-readiness.js';
import { readVideoMaskSourceMap } from '../masking.js';
import {
  readTimelineElementKindMap,
  timelineElementKindForClip,
} from '../timeline-element-kind.js';
import type {
  CompositionObservationRequest,
  IsolatedCompositionReadback,
} from './composition-observer.js';
import {
  collectTextLayoutBounds,
  type TextLayoutCandidate,
  type TextLayoutFrameMeasurement,
  type TextLayoutNodeMeasurement,
} from './text-layout-bounds-collect.js';

export type ProjectAssetBlobLoader = (assetId: string) => Promise<Blob | undefined>;

export interface IsolatedCompositionCaptureInput {
  readonly visualProject: JoyProjectV1;
  readonly timelineProject: SpikeProject;
  readonly loadProjectAssetBlob: ProjectAssetBlobLoader;
}

export interface IsolatedCompositionCapture {
  readonly composition: Omit<CompositionObservationRequest, 'outputTimesUs'>;
  readonly collectTextBoxes: (signal?: AbortSignal) => Promise<{
    readonly boxes: readonly TimelineQcTextBox[];
    readonly notMeasured: boolean;
  }>;
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
  const textBoundsByTime = new Map<number, readonly TextLayoutNodeMeasurement[]>();
  let rendererPromise: Promise<BrowserPixiRenderer> | undefined;
  let textBoxesCache:
    | {
        readonly boxes: readonly TimelineQcTextBox[];
        readonly notMeasured: boolean;
      }
    | undefined;
  let closed = false;
  const videoResources = new Map<string, VideoResource>();
  const resourceKeyFor = (clip: RootTimelineVideoClip): string =>
    `${clip.id}@${clip.startUs}@${clip.compositionPath.join('/')}`;
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
          assertOpen(signal);
          font = 'missing';
        }
        assertOpen(signal);
        await colorLutResolver.prepareProjectColorLuts();
        assertOpen(signal);
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
        assertOpen(request.signal);
        const decodedVideos = await decodeFrameVideos(frame, request.outputTimeUs, request.signal);
        assertOpen(request.signal);
        const bitmaps = await capturePrivateBitmaps(
          request.outputTimeUs,
          width,
          height,
          request.signal,
        );
        assertOpen(request.signal);
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
        const textBounds = renderFrame.nodes
          .filter((node): node is TextNode => node.kind === 'text')
          .map((node) => {
            const bounds = renderer.nodeBounds(node.id) as NodeBounds | undefined;
            const emptyText = node.text.trim().length === 0;
            const hasPlate =
              node.background !== undefined &&
              !emptyText &&
              bounds !== undefined &&
              (bounds.width > 0 || bounds.height > 0);
            return {
              id: node.id,
              ...(bounds === undefined ? {} : { bounds }),
              ...(emptyText ? { emptyText: true } : {}),
              textColor: node.color,
              ...(hasPlate ? { plateColor: node.background, plateBounds: bounds } : {}),
            };
          });
        textBoundsByTime.set(request.outputTimeUs, textBounds);
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
      if (assetId === undefined) continue;
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
      if (closed || signal.aborted) {
        stickerCache.clear();
        assertOpen(signal);
      }
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
      assertOpen(signal);
      if (captured.size !== scenes.length) throw new Error('HTML scene capture is incomplete');
      for (const [id, bitmap] of captured) bitmaps.set(id, bitmap);
    }
    return bitmaps;
  }

  async function decodeFrameVideos(frame: RenderFrameIR, timeUs: number, signal: AbortSignal) {
    const nodes = [];
    const clips = activeVideoClips(timelineProject, visualProject, timeUs);
    const transition = activeTransition(visualProject, timelineProject, timeUs);
    const hidden = hiddenClipIds(timelineProject);
    const elementKinds = readTimelineElementKindMap(visualProject);
    const maskSources = readVideoMaskSourceMap(visualProject);
    const candidates = [...clips];
    for (const id of transition === undefined
      ? []
      : [transition.leftClipId, transition.rightClipId]) {
      const clip =
        candidates.find((item) => item.id === id || item.compositionPath?.includes(id)) ??
        flattenRootTimelineVideoClips(timelineProject).find(
          (item) =>
            (item.id === id || item.compositionPath?.includes(id)) &&
            timeUs >= item.startUs - (transition?.durationUs ?? 0) &&
            timeUs < item.startUs + item.durationUs + (transition?.durationUs ?? 0),
        );
      if (
        clip !== undefined &&
        !hidden.has(clip.id) &&
        isExportVisualTimelineClip(
          timelineElementKindForClip(clip, elementKinds),
          visualProject.assets[maskSources[clip.id] ?? clip.assetId]?.kind,
        ) &&
        !candidates.some((item) => resourceKeyFor(item) === resourceKeyFor(clip))
      )
        candidates.push(clip);
    }
    candidates.sort(
      (left, right) =>
        Number(timelineElementKindForClip(left, elementKinds) !== 'video') -
        Number(timelineElementKindForClip(right, elementKinds) !== 'video'),
    );
    const neededKeys = new Set(candidates.map(resourceKeyFor));
    const duplicateClipIds = new Set(
      candidates
        .filter((clip, index) => candidates.findIndex((item) => item.id === clip.id) !== index)
        .map((clip) => clip.id),
    );
    for (const clip of flattenRootTimelineVideoClips(timelineProject)) {
      const key = resourceKeyFor(clip);
      const transitionEndUs = Math.max(
        0,
        ...(visualProject.transitions ?? [])
          .filter(
            (item) =>
              item.leftClipId === clip.id || clip.compositionPath?.includes(item.leftClipId),
          )
          .map((item) => clip.startUs + clip.durationUs + item.durationUs),
      );
      if (
        !neededKeys.has(key) &&
        timeUs > Math.max(clip.startUs + clip.durationUs, transitionEndUs)
      )
        closeVideoResource(videoResources, key);
    }
    const bitmaps = new Map<string, ImageDataLike>();
    for (const clip of candidates) {
      const nodeId = duplicateClipIds.has(clip.id) ? resourceKeyFor(clip) : clip.id;
      signal.throwIfAborted();
      const resource = await videoForClip(clip, signal);
      assertOpen(signal);
      const sourceUs = sourceTimeForTransitionSample(clip, timeUs, transition);
      if (resource.still !== undefined) {
        const bitmap = copyPixels(resource.still);
        bitmaps.set(nodeId, bitmap);
        nodes.push(
          videoFrameNodeFromDecoded(
            {
              ...videoClipSpecAt(
                visualProject,
                timelineProject,
                clip,
                timeUs,
                frame.viewport.height,
              ),
              id: nodeId,
            },
            {
              assetId: maskSources[clip.id] ?? clip.assetId,
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
        bitmaps.set(nodeId, bitmap);
        nodes.push(
          videoFrameNodeFromDecoded(
            {
              ...videoClipSpecAt(
                visualProject,
                timelineProject,
                clip,
                timeUs,
                frame.viewport.height,
              ),
              id: nodeId,
            },
            {
              assetId: maskSources[clip.id] ?? clip.assetId,
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
      assertOpen(signal);
      let activeResource = resource;
      if (decoded === undefined && resource.forward !== undefined) {
        resource.forward.close();
        const key = resourceKeyFor(clip);
        activeResource = { ...resource, forward: undefined };
        videoResources.set(key, activeResource);
        if (
          resource.forward.seekTiming === undefined &&
          fallbackSeekTiming.get(key) === undefined
        ) {
          const timingUrl = URL.createObjectURL(
            await getBlob(readVideoMaskSourceMap(visualProject)[clip.id] ?? clip.assetId, signal),
          );
          try {
            const timing = await import('../export-source-frame.js').then((module) =>
              module.readSourceFrameTimingWithin(timingUrl, signal, EXPORT_PRELOAD_TIMEOUT_MS),
            );
            assertOpen(signal);
            if (timing !== undefined) fallbackSeekTiming.set(key, timing);
          } finally {
            revokeDetachedObjectUrl(timingUrl);
          }
        }
      }
      const frameDecoded = decoded ?? (await activeResource.seek(sourceUs, timeUs, signal));
      assertOpen(signal);
      if (frameDecoded?.bitmap === undefined)
        throw new Error('Visible video frame could not be decoded');
      const bitmap = copyPixels(frameDecoded.bitmap);
      bitmaps.set(nodeId, bitmap);
      const copiedFrame = { ...frameDecoded, bitmap };
      const currentResource = videoResources.get(resourceKeyFor(clip)) ?? resource;
      const intrinsic =
        decoded === undefined
          ? {
              width: currentResource.video?.videoWidth ?? 0,
              height: currentResource.video?.videoHeight ?? 0,
            }
          : resource.forward!.size();
      nodes.push(
        videoFrameNodeFromDecoded(
          {
            ...videoClipSpecAt(visualProject, timelineProject, clip, timeUs, frame.viewport.height),
            id: nodeId,
          },
          copiedFrame,
          intrinsic,
        ),
      );
    }
    return { nodes, bitmaps };
  }

  async function videoForClip(
    clip: RootTimelineVideoClip,
    signal: AbortSignal,
  ): Promise<VideoResource> {
    const key = resourceKeyFor(clip);
    const cached = videoResources.get(key);
    if (cached !== undefined) return cached;
    const assetId = readVideoMaskSourceMap(visualProject)[clip.id] ?? clip.assetId;
    const blob = await getBlob(assetId, signal);
    assertOpen(signal);
    const asset = visualProject.assets[assetId];
    const mimeType = asset?.descriptor?.mimeType ?? '';
    const imageAnimation =
      asset?.kind !== 'image'
        ? undefined
        : (asset.descriptor?.animation ??
          inspectImageAnimation(await blob.arrayBuffer(), mimeType));
    assertOpen(signal);
    if (asset?.kind === 'image' && imageAnimation !== undefined) {
      const animated = await createAnimatedImageFrameSource(blob, imageAnimation);
      if (closed || signal.aborted) {
        animated.dispose();
        assertOpen(signal);
      }
      const resource = {
        forward: undefined,
        video: undefined as unknown as HTMLVideoElement,
        decoder: undefined as never,
        url: '',
        animated,
        seek: async () => undefined,
      } satisfies VideoResource;
      videoResources.set(key, resource);
      return resource;
    }
    if (asset?.kind === 'image') {
      const bitmap = await decodeBlobPixels(blob);
      assertOpen(signal);
      const resource = {
        forward: undefined,
        video: undefined as unknown as HTMLVideoElement,
        decoder: undefined as never,
        url: '',
        still: bitmap,
        seek: async () => undefined,
      } satisfies VideoResource;
      videoResources.set(key, resource);
      return resource;
    }
    let forward: ExportFrameSource | undefined;
    const [{ openExportFrameSource }, timingModule] = await Promise.all([
      import('../export-frame-source.js'),
      import('../export-source-frame.js'),
    ]);
    assertOpen(signal);
    if (clip.reversed !== true && clip.timeRemap?.direction !== 'reverse') {
      let timedOutOrReleased = false;
      const opening = runExportPreloadStage(
        'loading detached video',
        (stageSignal) => {
          const openingResult = openExportFrameSource(blob, assetId, { signal: stageSignal });
          void openingResult.then(
            (late) => {
              if ((timedOutOrReleased || closed) && late !== undefined) late.close();
            },
            () => undefined,
          );
          return openingResult;
        },
        signal,
        EXPORT_PRELOAD_TIMEOUT_MS,
      );
      try {
        forward = await opening;
      } catch {
        timedOutOrReleased = true;
        forward = undefined;
      }
      try {
        assertOpen(signal);
      } catch (error) {
        forward?.close();
        throw error;
      }
    }
    if (forward === undefined) {
      const urlForTiming = URL.createObjectURL(blob);
      try {
        const seekTiming = await timingModule.readSourceFrameTimingWithin(
          urlForTiming,
          signal,
          EXPORT_PRELOAD_TIMEOUT_MS,
        );
        assertOpen(signal);
        if (seekTiming !== undefined) fallbackSeekTiming.set(key, seekTiming);
      } finally {
        revokeDetachedObjectUrl(urlForTiming);
      }
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
          videoResources.set(key, { ...resource, forward: undefined, video, url });
          try {
            await loadDetachedVideo(video, url, seekSignal);
            assertOpen(seekSignal);
            decoder = createHtmlMediaDecoder(video, document.createElement('canvas'));
            videoResources.set(key, { ...resource, forward: undefined, video, decoder, url });
          } catch (error) {
            closeVideoResource(videoResources, key);
            throw error;
          }
        }
        const sourceTimeUs = seekUsForSource(
          sourceUs,
          forward?.seekTiming ?? fallbackSeekTiming.get(key),
        );
        await seekDetachedVideo(video, sourceTimeUs, seekSignal);
        if (video.readyState < 2) throw new Error('Video frame is not ready');
        seekSignal.throwIfAborted();
        const decoded = decoder.captureCurrentFrame(token);
        if (decoded.bitmap === undefined) throw new Error('Video frame could not be captured');
        if (video.readyState < 2) throw new Error('Video frame is not ready');
        return { ...decoded, bitmap: copyPixels(decoded.bitmap) };
      },
    };
    videoResources.set(key, resource);
    return resource;
  }

  const fallbackSeekTiming = new Map<string, SeekFrameTiming>();

  function assertOpen(signal?: AbortSignal): void {
    if (closed) throw new DOMException('Capture session is closed', 'AbortError');
    signal?.throwIfAborted();
  }

  async function getBlob(assetId: string, signal?: AbortSignal): Promise<Blob> {
    assertOpen(signal);
    const existing = assets.get(assetId);
    if (existing !== undefined) return existing;
    const blob = await loader(assetId);
    assertOpen(signal);
    if (blob === undefined) throw new Error('Required project media is unavailable');
    assets.set(assetId, blob);
    return blob;
  }

  return {
    composition,
    async collectTextBoxes(signal = new AbortController().signal) {
      if (textBoxesCache !== undefined) return textBoxesCache;
      const root = visualProject.compositions[visualProject.rootCompositionId];
      if (root === undefined) return (textBoxesCache = { boxes: [], notMeasured: true });
      const revision = visualProject.updatedAt || visualProject.id;
      const hidden = hiddenClipIds(timelineProject);
      const bindingsByClip = readClipObjectIdsMap(visualProject);
      const timelineRoot = timelineProject.compositions[timelineProject.rootCompositionId];
      const timelineClips = timelineRoot?.tracks.flatMap((track) => track.clips) ?? [];
      const titleCandidates: TextLayoutCandidate[] = Object.values(visualProject.visualObjects)
        .filter((object) => object.kind === 'text')
        .flatMap((object) => {
          const bindings = Object.entries(bindingsByClip)
            .filter(([, ids]) => ids.includes(object.id))
            .map(([clipId]) => clipId);
          const clips = timelineClips.filter((clip) => bindings.includes(clip.id));
          if (bindings.length === 0)
            return [
              {
                id: object.id,
                kind: 'title' as const,
                startUs: 0,
                endUs: root.durationUs,
                sampleUs: Math.floor(root.durationUs / 2),
                revision,
              },
            ];
          return clips
            .filter((clip) => !hidden.has(clip.id))
            .map((clip) => ({
              id: `title-occurrence:${object.id.length}:${object.id}:${clip.id}`,
              nodeId: object.id,
              kind: 'title' as const,
              startUs: clip.startUs,
              endUs: clip.startUs + clip.durationUs,
              sampleUs: Math.floor(clip.startUs + clip.durationUs / 2),
              revision,
            }));
        });
      const captionCandidates: TextLayoutCandidate[] = [];
      for (const track of root.tracks) {
        if (track.kind !== 'caption' || !track.enabled) continue;
        for (const clip of track.clips) {
          if (clip.kind !== 'caption') continue;
          const document = visualProject.captionDocuments[clip.captionDocumentId];
          if (document === undefined) continue;
          for (const segment of document.segments) {
            const startUs = clip.startUs + segment.startUs;
            const endUs = Math.min(clip.startUs + clip.durationUs, clip.startUs + segment.endUs);
            if (endUs <= startUs) continue;
            const sampleUs = Math.floor(startUs + (endUs - startUs) / 2);
            const cues = captionCuesAt(
              root,
              visualProject.captionDocuments,
              sampleUs,
              visualProject.propertyAnimations,
            ).filter((cue) => cue.clipId === clip.id && cue.segment.id === segment.id);
            const nodes = layoutTemplatedCaptionNodes(cues, {
              viewportWidth: root.width,
              viewportHeight: root.height,
            });
            for (const node of nodes)
              captionCandidates.push({
                id: node.id,
                kind: 'caption',
                startUs,
                endUs,
                sampleUs,
                revision,
                ...(hidden.has(clip.id) ? { hidden: true } : {}),
              });
          }
        }
      }
      const candidates = [...titleCandidates, ...captionCandidates];
      const cutCount = new Set(
        timelineClips.map((clip) => clip.startUs).filter((timeUs) => timeUs > 0),
      ).size;
      const boxCap = Math.max(0, 48 - 12 - cutCount);
      const frameMeasurements: TextLayoutFrameMeasurement[] = [];
      const times = [
        ...new Set(candidates.filter((item) => !item.hidden).map((item) => item.sampleUs)),
      ]
        .sort((a, b) => a - b)
        .slice(0, boxCap);
      let readiness;
      try {
        readiness = await composition.readiness.check(composition.snapshot, signal);
      } catch {
        return (textBoxesCache = { boxes: [], notMeasured: true });
      }
      if (readiness.font !== 'ready') return (textBoxesCache = { boxes: [], notMeasured: true });
      for (const timeUs of times) {
        signal.throwIfAborted();
        const frame = await composition.evaluator.evaluate(composition.snapshot, timeUs, signal);
        await composition.renderer.renderAndReadback(frame, {
          purpose: 'composition-evidence',
          includeEditorOverlays: false,
          outputTimeUs: timeUs,
          maxPixels: MAX_CAPTURE_PIXELS,
          maxReadbackBytes: MAX_CAPTURE_PIXELS * 4,
          signal,
        });
        frameMeasurements.push({
          timeUs,
          revision,
          composition: { width: frame.viewport.width, height: frame.viewport.height },
          nodes: textBoundsByTime.get(timeUs) ?? [],
        });
        textBoundsByTime.delete(timeUs);
      }
      const collected = collectTextLayoutBounds(candidates, frameMeasurements, boxCap);
      return (textBoxesCache = { boxes: collected.boxes, notMeasured: collected.notMeasured });
    },
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
      textBoundsByTime.clear();
      fallbackSeekTiming.clear();
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
): RootTimelineVideoClip[] {
  const hidden = hiddenClipIds(timeline);
  const kinds = readTimelineElementKindMap(project);
  return flattenRootTimelineVideoClips(timeline).filter(
    (clip) =>
      !hidden.has(clip.id) &&
      isExportVisualTimelineClip(
        timelineElementKindForClip(clip, kinds),
        project.assets[readVideoMaskSourceMap(project)[clip.id] ?? clip.assetId]?.kind,
      ) &&
      timeUs >= clip.startUs &&
      timeUs < clip.startUs + clip.durationUs &&
      project.assets[clip.assetId]?.kind !== 'audio',
  );
}

function closeVideoResource(resources: Map<string, VideoResource>, key: string): void {
  const resource = resources.get(key);
  if (resource === undefined) return;
  resources.delete(key);
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
