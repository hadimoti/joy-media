# Review package: 4c5a2a1..4eba6f9

## Commits
4eba6f9 fix(motion): close placement undo and scene media hydration

## Files changed
 apps/editor-web/src/App.tsx                        |  94 ++++++-
 apps/editor-web/src/motion-scene-surfaces.test.ts  |  31 +++
 apps/editor-web/src/motion-scene-surfaces.ts       | 294 +++++++++++++++++++++
 .../src/motion-studio/MotionStudioCanvas.test.tsx  |   3 +
 .../src/motion-studio/MotionStudioCanvas.tsx       |  47 +++-
 .../src/motion-studio/MotionStudioShell.tsx        |   1 +
 .../src/render-plan-capture-targets.test.ts        |  36 +++
 apps/editor-web/src/render-plan-capture-targets.ts |  42 +++
 apps/render-host/src/index.ts                      |  23 ++
 apps/render-host/src/protocol.ts                   |   4 +
 apps/worker/src/worker-media-resolver.test.ts      |  27 +-
 apps/worker/src/worker-media-resolver.ts           |  13 +
 12 files changed, 604 insertions(+), 11 deletions(-)

## Diff
diff --git a/apps/editor-web/src/App.tsx b/apps/editor-web/src/App.tsx
index 6a402ac..a7bc980 100644
--- a/apps/editor-web/src/App.tsx
+++ b/apps/editor-web/src/App.tsx
@@ -31,21 +31,24 @@ import type {
   CommandTransaction,
   GraphTransaction,
   ArtifactStore,
   ArtifactTransaction,
 } from '@joy-media/commands';
 import type { EditorContext } from '@joy-media/agent-tools';
 import { buildEditorContext } from '@joy-media/agent-tools';
 import type { HistoryEntry } from './editor-session.js';
 import type { JoyProjectV1, SpikeProject, VideoClip } from '@joy-media/project-schema';
 import { normalizePlaybackRate } from '@joy-media/project-schema';
-import type { VisualObjectTransaction } from '@joy-media/property-system';
+import {
+  applyVisualObjectProjectTransaction,
+  type VisualObjectTransaction,
+} from '@joy-media/property-system';
 import { registerBuiltins, effectRegistry } from '@joy-media/visual-effects';
 import type { ProductionRunAuthority } from '@joy-media/workflow-engine';
 
 registerBuiltins();
 
 const CLIP_FRAME_CACHE_LIMIT = 120;
 
 import {
   createBrowserPixiRenderer,
   type BrowserPixiRenderer,
@@ -95,22 +98,24 @@ import {
 } from './control-plane-client.js';
 import { AudioPanel } from './AudioPanel.js';
 import { EffectsPanel } from './EffectsPanel.js';
 import { ColorPanel } from './ColorPanel.js';
 import { TransitionsPanel } from './TransitionsPanel.js';
 import { bindClipToObject, resolveObjectIdForSelection } from './sticker-bindings.js';
 import { isSingleVideoClipSelected } from './effects-apply-state.js';
 import { StickerImageCache } from './sticker-image-cache.js';
 import {
   htmlSceneCaptureTargetsForRequirements,
+  plannedMotionSceneCaptureTargets,
   plannedStillBitmapTargets,
 } from './render-plan-capture-targets.js';
+import { MotionSceneSurfaceCache } from './motion-scene-surfaces.js';
 import { openOpfsOriginalAssetCache } from './opfs-original-asset-cache.js';
 import { openOpfsDerivativeCache } from './opfs-asset-cache.js';
 import { createMediaSessionPlayableAssetResolver } from './media-session.js';
 import {
   MonitorMediaElementBinding,
   disposeInactiveMonitorPlayback,
   monitorVideoClipSpecToken,
   releaseMonitorMediaSources,
   resolveReadyMonitorMediaSources,
   resolveMonitorMediaSource,
@@ -766,29 +771,40 @@ function EditorWorkspace({
     if (cache.has(clipId)) cache.delete(clipId);
     cache.set(clipId, bitmap);
     if (cache.size > CLIP_FRAME_CACHE_LIMIT) {
       const oldest = cache.keys().next().value as string | undefined;
       if (oldest !== undefined) cache.delete(oldest);
     }
     setClipFrameTick((tick) => tick + 1);
   }, []);
 
   const resolveClipMonitorMediaSource = useCallback(
-    async (clip: VideoClip): Promise<MonitorMediaSource> =>
-      resolveMonitorMediaSource({
+    async (clip: VideoClip): Promise<MonitorMediaSource> => {
+      if (clip.assetId.startsWith('motion-scene:')) {
+        return {
+          state: 'unavailable',
+          clipId: clip.id,
+          assetId: clip.assetId,
+          message:
+            'Motion Studio scene media is not a browser video source; the published scene is hydrated as an RGBA surface and must be rendered by the Worker for delivery.',
+          action: { kind: 'wait', label: 'Render scene media' },
+        };
+      }
+      return resolveMonitorMediaSource({
         projectId: controlPlaneProject.controlPlaneProjectId,
         clip,
         asset:
           monitorAssetCatalog.assets[clip.assetId] ?? session.visualProject.assets[clip.assetId],
         derivatives: monitorAssetCatalog.derivativesByAssetId[clip.assetId] ?? [],
         resolver: await playableAssetResolver,
-      }),
+      });
+    },
     [
       controlPlaneProject.controlPlaneProjectId,
       monitorAssetCatalog,
       playableAssetResolver,
       session,
     ],
   );
 
   const ensurePartnerDecoder = useCallback((): {
     video: HTMLVideoElement;
@@ -1411,25 +1427,33 @@ function EditorWorkspace({
       const composition = session.timelineProject.compositions.root;
       if (composition === undefined) return;
       const plan = buildMotionScenePlacementPlan({
         composition,
         visualProject: session.visualProject,
         selectedClipId: state.selectedIds[0],
         motionSceneId,
         nowMs: Date.now(),
       });
       if (plan === undefined) return;
-      session.dispatchVisualObjects(plan.visualTransaction);
-      session.dispatchTimeline(plan.timelineTransaction);
-      session.replaceVisualProject(
-        bindClipToObject(session.visualProject, plan.clipId, plan.objectId),
+      // A placed scene changes both lenses. Apply the object command first as
+      // a pure calculation, bind the new object to its clip, then commit both
+      // slices through the session's compound snapshot. This keeps Place
+      // Motion Scene to one durable undo step (and avoids a dangling binding
+      // if a later timeline command rejects).
+      const created = applyVisualObjectProjectTransaction(
+        session.visualProject,
+        plan.visualTransaction,
       );
+      session.dispatchCompound(`Place Motion scene ${motionSceneId}`, {
+        document: bindClipToObject(created, plan.clipId, plan.objectId),
+        timeline: plan.timelineTransaction,
+      });
       setState((current) => ({ ...current, selectedIds: [plan.clipId] }));
       setRevision((revision) => revision + 1);
     },
     [session, state.selectedIds],
   );
 
   const setAudioState = useCallback(
     (next: AudioState) => {
       setAudioStateRaw(next);
       saveAudioState(projectId, next);
@@ -2098,20 +2122,21 @@ function EditorWorkspace({
       const mixedChannel = mixedAudioBuffer.getChannelData(0);
       for (let i = 0; i < mixedAudio.length; i++) mixedChannel[i] = mixedAudio[i]!;
       const mixedAudioSource = audioContext.createBufferSource();
       mixedAudioSource.buffer = mixedAudioBuffer;
       mixedAudioSource.connect(audioDestination);
       const exportAudioTrack = audioDestination.stream.getAudioTracks()[0];
       if (exportAudioTrack === undefined)
         throw new Error('Export audio mix did not produce a track');
       const renderer = await createBrowserPixiRenderer({ width, height, resolution: 1 });
       const sceneFrameSource = createDeliverySceneFrameSource(new HtmlSceneSurfaceCache());
+      const motionSceneFrameSource = new MotionSceneSurfaceCache(window.localStorage);
       const startTimers: number[] = [];
       const audioSources: AudioBufferSourceNode[] = [];
       try {
         await audioContext.resume();
         setExportStatus(`Encoding ${totalFrames} preview-equivalent H.264/AAC frames…`);
         const exportResult: BrowserExportResult = await downloadBrowserMp4({
           manifest,
           frameCount: totalFrames,
           canvas: renderer.canvas,
           audioTrack: exportAudioTrack,
@@ -2173,20 +2198,28 @@ function EditorWorkspace({
               if (bitmaps.has(sample.clipId)) continue;
               await captureExportSample(sample);
             }
             await sceneFrameSource.captureInto(
               bitmaps,
               htmlSceneCaptureTargetsForRequirements(
                 session.visualProject,
                 plan.captureRequirements,
               ),
             );
+            const motionSceneTargets = plannedMotionSceneCaptureTargets(
+              session.visualProject,
+              plan.captureRequirements,
+            );
+            const motionSceneBitmaps = await motionSceneFrameSource.captureFull(motionSceneTargets);
+            const motionSceneDiagnostic = motionSceneFrameSource.diagnostics()[0];
+            if (motionSceneDiagnostic !== undefined) throw new Error(motionSceneDiagnostic.message);
+            for (const [objectId, bitmap] of motionSceneBitmaps) bitmaps.set(objectId, bitmap);
             for (const target of plannedStillBitmapTargets(
               session.visualProject,
               plan.captureRequirements,
             )) {
               const bitmap = stickerImageCache.get(target.objectId);
               if (bitmap !== undefined) bitmaps.set(target.objectId, bitmap);
             }
             renderer.render(withVideoFrameNode(plan.frame, node), bitmaps);
           },
           onProgress: (completed, total) => {
@@ -2224,20 +2257,21 @@ function EditorWorkspace({
           setExportProgress(undefined);
         }, 450);
       } finally {
         for (const timer of startTimers) window.clearTimeout(timer);
         for (const source of audioSources) source.stop();
         for (const media of exportMedia) {
           media.video.pause();
           media.source.release();
         }
         sceneFrameSource.destroy();
+        motionSceneFrameSource.destroy();
         renderer.destroy();
         await audioContext.close();
       }
     } catch (error) {
       const message = error instanceof Error ? error.message : String(error);
       setExportStatus(`Export failed: ${message}`);
       recordExportEntry({
         id: entryId,
         filename: exportFilename,
         status: 'failed',
@@ -3535,20 +3569,21 @@ function MonitorPanel() {
     togglePlayback,
     seek,
     dispatchProject,
     showToast,
   } = context;
   const containerRef = useRef<HTMLDivElement | null>(null);
   const [monitorDragOver, setMonitorDragOver] = useState(false);
   const rendererRef = useRef<BrowserPixiRenderer | null>(null);
   const paintRef = useRef<() => void>(() => {});
   const sceneCacheRef = useRef(new HtmlSceneSurfaceCache());
+  const motionSceneCacheRef = useRef(new MotionSceneSurfaceCache(window.localStorage));
   const [sceneTick, setSceneTick] = useState(0);
   const [error, setError] = useState<string | undefined>(undefined);
   const [viewerZoom, setViewerZoom] = useState<'fit' | '50' | '100' | '200'>('fit');
   const [fullscreen, setFullscreen] = useState(false);
   const [zoomDrawerOpen, setZoomDrawerOpen] = useState(false);
   const panelRef = useRef<HTMLElement | null>(null);
   const transportRef = useRef<HTMLDivElement | null>(null);
   const zoomDrawerRef = useRef<HTMLDivElement | null>(null);
 
   useAccessibleDialog({
@@ -3623,20 +3658,27 @@ function MonitorPanel() {
     if (previewVideoFrame !== undefined) {
       videoBitmaps.set(previewVideoFrame.node.id, previewVideoFrame.bitmap);
     }
     for (const target of htmlSceneCaptureTargetsForRequirements(
       visualProject,
       plan.captureRequirements,
     )) {
       const bitmap = sceneCacheRef.current.bitmaps().get(target.objectId);
       if (bitmap !== undefined) videoBitmaps.set(target.objectId, bitmap);
     }
+    for (const target of plannedMotionSceneCaptureTargets(
+      visualProject,
+      plan.captureRequirements,
+    )) {
+      const bitmap = motionSceneCacheRef.current.bitmaps().get(target.objectId);
+      if (bitmap !== undefined) videoBitmaps.set(target.objectId, bitmap);
+    }
     for (const target of plannedStillBitmapTargets(visualProject, plan.captureRequirements)) {
       const bitmap = stickerImageCache.get(target.objectId);
       if (bitmap !== undefined) videoBitmaps.set(target.objectId, bitmap);
     }
     renderer.render(frame, videoBitmaps);
   };
 
   useEffect(() => {
     const container = containerRef.current;
     if (container === null) return;
@@ -3677,21 +3719,55 @@ function MonitorPanel() {
       .sync(htmlSceneCaptureTargetsForRequirements(visualProject, plan.captureRequirements))
       .then(() => {
         if (cancelled) return;
         setSceneTick((value) => value + 1);
       });
     return () => {
       cancelled = true;
     };
   }, [state.playheadUs, timelineProject, visualProject]);
 
-  useEffect(() => () => sceneCacheRef.current.destroy(), []);
+  useEffect(() => {
+    let cancelled = false;
+    const plan = planRenderFrame({
+      bundle: createRenderBundle({
+        timelineProject,
+        visualProject,
+        seed: `preview:${visualProject.id}`,
+      }),
+      timeUs: state.playheadUs,
+      imageSizesByObjectId: imageSizesFromCache(),
+    });
+    void motionSceneCacheRef.current
+      .sync(plannedMotionSceneCaptureTargets(visualProject, plan.captureRequirements))
+      .then(() => {
+        if (cancelled) return;
+        const diagnostic = motionSceneCacheRef.current.diagnostics()[0];
+        setError(diagnostic?.message);
+        setSceneTick((value) => value + 1);
+      })
+      .catch((reason: unknown) => {
+        if (cancelled) return;
+        setError(reason instanceof Error ? reason.message : String(reason));
+      });
+    return () => {
+      cancelled = true;
+    };
+  }, [state.playheadUs, timelineProject, visualProject]);
+
+  useEffect(
+    () => () => {
+      sceneCacheRef.current.destroy();
+      motionSceneCacheRef.current.destroy();
+    },
+    [],
+  );
 
   useEffect(() => {
     paintRef.current();
   }, [
     clipFrameCache,
     clipFrameTick,
     previewVideoFrame,
     state.playheadUs,
     visualProject,
     sceneTick,
diff --git a/apps/editor-web/src/motion-scene-surfaces.test.ts b/apps/editor-web/src/motion-scene-surfaces.test.ts
new file mode 100644
index 0000000..dc57bb1
--- /dev/null
+++ b/apps/editor-web/src/motion-scene-surfaces.test.ts
@@ -0,0 +1,31 @@
+import { describe, expect, it } from 'vitest';
+import { MotionSceneSurfaceCache } from './motion-scene-surfaces.js';
+
+describe('MotionSceneSurfaceCache', () => {
+  it('records explicit evidence instead of painting an unresolved scene as success', async () => {
+    const cache = new MotionSceneSurfaceCache({
+      getItem: () => null,
+      setItem: () => undefined,
+    });
+
+    await cache.sync([
+      {
+        requirementId: 'motion-scene:object-a',
+        objectId: 'object-a',
+        assetId: 'motion-scene:missing-doc',
+        motionSceneId: 'missing-doc',
+        timeUs: 0,
+      },
+    ]);
+
+    expect(cache.bitmaps().has('object-a')).toBe(false);
+    expect(cache.diagnostics()).toEqual([
+      {
+        objectId: 'object-a',
+        motionSceneId: 'missing-doc',
+        code: 'MOTION_SCENE_NOT_PUBLISHED',
+        message: 'Motion scene missing-doc is not published and cannot be previewed',
+      },
+    ]);
+  });
+});
diff --git a/apps/editor-web/src/motion-scene-surfaces.ts b/apps/editor-web/src/motion-scene-surfaces.ts
new file mode 100644
index 0000000..cee422e
--- /dev/null
+++ b/apps/editor-web/src/motion-scene-surfaces.ts
@@ -0,0 +1,294 @@
+/**
+ * Browser hydration for published Motion Studio scenes.
+ *
+ * Motion scenes are stored as versioned documents, not public URLs. The
+ * monitor therefore resolves the published document first and only then
+ * rasterizes a frame into the same RGBA contract used by HTML scenes and
+ * stickers. A missing publication is retained as an explicit diagnostic and
+ * never replaced with a fake successful frame.
+ */
+import type { ImageDataLike } from '@joy-media/playback-engine';
+import {
+  evaluateMotionScene,
+  resolveLayerWorld,
+  resolvedLayerOpacity,
+  type MotionLayer,
+  type MotionSceneDocument,
+} from '@joy-media/motion-core';
+import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
+import {
+  getPublishedMotionScene,
+  type MotionSceneCatalogEntry,
+} from './motion-scene-catalog.js';
+import type { PlannedMotionSceneCaptureTarget } from './render-plan-capture-targets.js';
+
+export interface MotionSceneSurfaceDiagnostic {
+  readonly objectId: string;
+  readonly motionSceneId: string;
+  readonly code: 'MOTION_SCENE_NOT_PUBLISHED' | 'MOTION_SCENE_CAPTURE_FAILED';
+  readonly message: string;
+}
+
+export type MotionSceneSurfaceBitmap = ImageDataLike;
+
+const DEFAULT_CAPTURE_SCALE = 4;
+
+export class MotionSceneSurfaceCache {
+  readonly #storage: BrowserKeyValueStore;
+  readonly #bitmaps = new Map<string, MotionSceneSurfaceBitmap>();
+  readonly #diagnostics = new Map<string, MotionSceneSurfaceDiagnostic>();
+  readonly #media = new Map<string, HTMLImageElement | HTMLVideoElement>();
+
+  constructor(storage: BrowserKeyValueStore) {
+    this.#storage = storage;
+  }
+
+  bitmaps(): ReadonlyMap<string, MotionSceneSurfaceBitmap> {
+    return this.#bitmaps;
+  }
+
+  diagnostics(): readonly MotionSceneSurfaceDiagnostic[] {
+    return [...this.#diagnostics.values()];
+  }
+
+  async sync(
+    targets: readonly PlannedMotionSceneCaptureTarget[],
+    scale = DEFAULT_CAPTURE_SCALE,
+  ): Promise<ReadonlyMap<string, MotionSceneSurfaceBitmap>> {
+    const liveIds = new Set(targets.map((target) => target.objectId));
+    for (const id of this.#bitmaps.keys()) if (!liveIds.has(id)) this.#bitmaps.delete(id);
+    for (const id of this.#diagnostics.keys()) if (!liveIds.has(id)) this.#diagnostics.delete(id);
+    await Promise.all(targets.map((target) => this.#captureTarget(target, scale)));
+    return this.#bitmaps;
+  }
+
+  async captureFull(
+    targets: readonly PlannedMotionSceneCaptureTarget[],
+  ): Promise<ReadonlyMap<string, MotionSceneSurfaceBitmap>> {
+    const result = new Map<string, MotionSceneSurfaceBitmap>();
+    await Promise.all(
+      targets.map(async (target) => {
+        const bitmap = await this.#renderTarget(target, 1);
+        if (bitmap !== undefined) result.set(target.objectId, bitmap);
+      }),
+    );
+    return result;
+  }
+
+  destroy(): void {
+    for (const media of this.#media.values()) {
+      if (media instanceof HTMLVideoElement) {
+        media.pause();
+        media.removeAttribute('src');
+        media.load();
+      } else {
+        media.removeAttribute('src');
+      }
+    }
+    this.#media.clear();
+    this.#bitmaps.clear();
+    this.#diagnostics.clear();
+  }
+
+  async #captureTarget(target: PlannedMotionSceneCaptureTarget, scale: number): Promise<void> {
+    const bitmap = await this.#renderTarget(target, scale);
+    if (bitmap !== undefined) this.#bitmaps.set(target.objectId, bitmap);
+  }
+
+  async #renderTarget(
+    target: PlannedMotionSceneCaptureTarget,
+    scale: number,
+  ): Promise<MotionSceneSurfaceBitmap | undefined> {
+    const scene = getPublishedMotionScene(this.#storage, target.motionSceneId);
+    if (scene === undefined) {
+      this.#diagnostics.set(target.objectId, {
+        objectId: target.objectId,
+        motionSceneId: target.motionSceneId,
+        code: 'MOTION_SCENE_NOT_PUBLISHED',
+        message: `Motion scene ${target.motionSceneId} is not published and cannot be previewed`,
+      });
+      this.#bitmaps.delete(target.objectId);
+      return undefined;
+    }
+    try {
+      const bitmap = await rasterizeMotionScene(scene, target.timeUs, scale, this.#media);
+      this.#diagnostics.delete(target.objectId);
+      return bitmap;
+    } catch (error) {
+      const message = error instanceof Error ? error.message : String(error);
+      this.#diagnostics.set(target.objectId, {
+        objectId: target.objectId,
+        motionSceneId: target.motionSceneId,
+        code: 'MOTION_SCENE_CAPTURE_FAILED',
+        message: `Motion scene ${target.motionSceneId} could not be captured: ${message}`,
+      });
+      this.#bitmaps.delete(target.objectId);
+      return undefined;
+    }
+  }
+}
+
+async function rasterizeMotionScene(
+  scene: MotionSceneDocument,
+  timeUs: number,
+  scale: number,
+  media: Map<string, HTMLImageElement | HTMLVideoElement>,
+): Promise<MotionSceneSurfaceBitmap> {
+  if (typeof document === 'undefined') throw new Error('browser canvas is unavailable');
+  const width = Math.max(1, Math.round(scene.width / scale));
+  const height = Math.max(1, Math.round(scene.height / scale));
+  const canvas = document.createElement('canvas');
+  canvas.width = width;
+  canvas.height = height;
+  const context = canvas.getContext('2d', { willReadFrequently: true });
+  if (context === null) throw new Error('2d canvas context is unavailable');
+  paintBackground(context, scene, width, height);
+  const evaluated = evaluateMotionScene(scene, timeUs / 1000);
+  const layersById: Record<string, MotionLayer> = Object.fromEntries(
+    scene.layers.map((layer) => [layer.id, layer]),
+  );
+  for (const layer of scene.layers) {
+    if (!layer.visible) continue;
+    await hydrateLayerMedia(layer, timeUs, media);
+    const world = resolveLayerWorld(layer, evaluated.get(layer.id), layersById).worldTransform;
+    const opacity = resolvedLayerOpacity(layer, evaluated.get(layer.id));
+    context.save();
+    context.globalAlpha = Math.max(0, Math.min(1, opacity));
+    context.translate((world.x + world.width / 2) / scale, (world.y + world.height / 2) / scale);
+    context.rotate((world.rotationDeg * Math.PI) / 180);
+    context.scale(world.scaleX / scale, world.scaleY / scale);
+    drawLayer(context, layer, world.width, world.height, media, timeUs);
+    context.restore();
+  }
+  return context.getImageData(0, 0, width, height);
+}
+
+async function hydrateLayerMedia(
+  layer: MotionLayer,
+  timeUs: number,
+  media: Map<string, HTMLImageElement | HTMLVideoElement>,
+): Promise<void> {
+  if ((layer.type !== 'image' && layer.type !== 'video') || layer.assetId === undefined) return;
+  let element = media.get(layer.assetId);
+  if (element === undefined) {
+    const url = `/v1/library/cloud-assets/${encodeURIComponent(layer.assetId)}/content`;
+    element = layer.type === 'video' ? document.createElement('video') : document.createElement('img');
+    element.crossOrigin = 'anonymous';
+    element.src = url;
+    if (element instanceof HTMLVideoElement) {
+      element.muted = true;
+      element.playsInline = true;
+      element.preload = 'auto';
+      await waitForMedia(element, 'loadeddata');
+    } else {
+      await waitForMedia(element, 'load');
+    }
+    media.set(layer.assetId, element);
+  }
+  if (element instanceof HTMLVideoElement) {
+    element.currentTime = Math.max(0, timeUs / 1_000_000);
+    if (element.readyState < 2) await waitForMedia(element, 'loadeddata');
+  }
+}
+
+function waitForMedia(element: HTMLImageElement | HTMLVideoElement, event: 'load' | 'loadeddata'):
+  Promise<void> {
+  if (element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0) {
+    return Promise.resolve();
+  }
+  if (element instanceof HTMLVideoElement && element.readyState >= 2) return Promise.resolve();
+  return new Promise((resolve, reject) => {
+    const timeout = window.setTimeout(() => {
+      cleanup();
+      reject(new Error(`media ${event} timed out`));
+    }, 2_000);
+    const cleanup = () => {
+      window.clearTimeout(timeout);
+      element.removeEventListener(event, onLoad);
+      element.removeEventListener('error', onError);
+    };
+    const onLoad = () => {
+      cleanup();
+      resolve();
+    };
+    const onError = () => {
+      cleanup();
+      reject(new Error(`media ${event} failed`));
+    };
+    element.addEventListener(event, onLoad, { once: true });
+    element.addEventListener('error', onError, { once: true });
+  });
+}
+
+function paintBackground(
+  context: CanvasRenderingContext2D,
+  scene: MotionSceneDocument,
+  width: number,
+  height: number,
+): void {
+  if (scene.background.kind === 'solid' && scene.background.color !== undefined) {
+    context.fillStyle = scene.background.color;
+    context.fillRect(0, 0, width, height);
+  } else {
+    context.clearRect(0, 0, width, height);
+  }
+}
+
+function drawLayer(
+  context: CanvasRenderingContext2D,
+  layer: MotionLayer,
+  width: number,
+  height: number,
+  media: Map<string, HTMLImageElement | HTMLVideoElement>,
+  timeUs: number,
+): void {
+  const x = -width / 2;
+  const y = -height / 2;
+  if (layer.type === 'shape') {
+    context.fillStyle = fillColor(layer) ?? '#ffffff';
+    context.fillRect(x, y, width, height);
+    return;
+  }
+  if (layer.type === 'text') {
+    context.fillStyle = fillColor(layer) ?? '#ffffff';
+    context.font = `${layer.typography?.fontSize ?? 40}px ${layer.typography?.fontFamily ?? 'sans-serif'}`;
+    context.textBaseline = 'top';
+    context.fillText(layer.text ?? '', x, y, width);
+    return;
+  }
+  if ((layer.type === 'image' || layer.type === 'video') && layer.assetId !== undefined) {
+    const element = media.get(layer.assetId);
+    if (element !== undefined && element instanceof HTMLVideoElement) {
+      element.currentTime = Math.max(0, timeUs / 1_000_000);
+    }
+    if (element !== undefined) context.drawImage(element, x, y, width, height);
+    else {
+      context.fillStyle = '#253047';
+      context.fillRect(x, y, width, height);
+    }
+    return;
+  }
+  context.fillStyle = 'rgba(255,255,255,0.12)';
+  context.fillRect(x, y, width, height);
+}
+
+function fillColor(layer: MotionLayer): string | undefined {
+  const fill = layer.fills[0];
+  if (fill?.kind === 'solid') return fill.color;
+  if (fill?.kind === 'gradient') return fill.gradient.stops[0]?.color;
+  return undefined;
+}
+
+export function motionSceneTargetFromCatalog(
+  entry: MotionSceneCatalogEntry,
+  objectId: string,
+  timeUs: number,
+): PlannedMotionSceneCaptureTarget {
+  return {
+    requirementId: `motion-scene:${objectId}`,
+    objectId,
+    assetId: `motion-scene:${entry.id}`,
+    motionSceneId: entry.id,
+    timeUs,
+  };
+}
diff --git a/apps/editor-web/src/motion-studio/MotionStudioCanvas.test.tsx b/apps/editor-web/src/motion-studio/MotionStudioCanvas.test.tsx
index b1fff38..b525ad8 100644
--- a/apps/editor-web/src/motion-studio/MotionStudioCanvas.test.tsx
+++ b/apps/editor-web/src/motion-studio/MotionStudioCanvas.test.tsx
@@ -47,13 +47,16 @@ describe('MotionStudioCanvas media surface', () => {
         onAddTextLayer={noop}
         onAddRectangleLayer={noop}
         onAddEllipseLayer={noop}
         onAddImageLayer={noop}
         onAddVideoLayer={noop}
       />,
     );
 
     expect(markup).toContain('/v1/library/cloud-assets/asset-image-1/content');
     expect(markup).toContain('/v1/library/cloud-assets/asset-video-1/content');
+    expect(markup).toContain('<video');
+    expect(markup).toContain('playsInline');
+    expect(markup).not.toContain('src="/v1/library/cloud-assets/asset-video-1/content" alt=');
     expect(markup).toContain(svgContentToDataUrl(svg.svgContent));
   });
 });
diff --git a/apps/editor-web/src/motion-studio/MotionStudioCanvas.tsx b/apps/editor-web/src/motion-studio/MotionStudioCanvas.tsx
index 62f763c..ff4f463 100644
--- a/apps/editor-web/src/motion-studio/MotionStudioCanvas.tsx
+++ b/apps/editor-web/src/motion-studio/MotionStudioCanvas.tsx
@@ -20,20 +20,22 @@ interface LayerElementProps {
   readonly layer: MotionLayer;
   readonly evaluation: import('@joy-media/motion-core').LayerEvaluation | undefined;
   readonly world: import('@joy-media/motion-core').LayerWorldEvaluation | undefined;
   readonly isSelected: boolean;
   readonly editingText: boolean;
   readonly onPointerDown: (e: React.PointerEvent, layerId: MotionLayerId) => void;
   readonly onDoubleClick: (e: React.MouseEvent, layerId: MotionLayerId) => void;
   readonly onContextMenu: (e: React.MouseEvent, layerId: MotionLayerId) => void;
   readonly onTextChange: (layerId: MotionLayerId, text: string) => void;
   readonly onTextEditEnd: (layerId: MotionLayerId) => void;
+  readonly playheadMs: number;
+  readonly playing: boolean;
 }
 
 export function motionStudioAssetUrl(assetId: string | undefined): string {
   if (!assetId) return '';
   return `/v1/library/cloud-assets/${encodeURIComponent(assetId)}/content`;
 }
 
 export function svgContentToDataUrl(svgContent: string | undefined): string {
   if (svgContent === undefined || svgContent.trim().length === 0) return '';
   return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`;
@@ -70,21 +72,24 @@ function LayerElement({
   layer,
   evaluation,
   world,
   isSelected,
   editingText,
   onPointerDown,
   onDoubleClick,
   onContextMenu,
   onTextChange,
   onTextEditEnd,
+  playheadMs,
+  playing,
 }: LayerElementProps) {
+  const videoRef = useRef<HTMLVideoElement | null>(null);
   const local = resolvedLayerTransform(layer, evaluation);
   const opacity = resolvedLayerOpacity(layer, evaluation);
   const t = world?.worldTransform ?? local;
   const style: React.CSSProperties = {
     position: 'absolute',
     left: t.x,
     top: t.y,
     width: t.width || undefined,
     height: t.height || undefined,
     transform: `rotate(${t.rotationDeg}deg) scale(${t.scaleX}, ${t.scaleY})`,
@@ -114,20 +119,31 @@ function LayerElement({
         e.currentTarget.blur();
       }
     },
     [onTextEditEnd],
   );
 
   const handleBlur = useCallback(() => {
     onTextEditEnd(layer.id);
   }, [layer.id, onTextEditEnd]);
 
+  useEffect(() => {
+    if (layer.type !== 'video' || videoRef.current === null) return;
+    const video = videoRef.current;
+    // Motion Studio's playhead is the source of truth. Seeking here keeps a
+    // paused scrub deterministic while play() lets the browser present real
+    // decoded frames during preview playback.
+    if (Number.isFinite(playheadMs)) video.currentTime = Math.max(0, playheadMs / 1000);
+    if (playing) void video.play().catch(() => undefined);
+    else video.pause();
+  }, [layer.type, playheadMs, playing]);
+
   const commonProps = {
     'data-layer-id': layer.id,
     className: `ms-layer${isSelected ? ' ms-layer-selected' : ''}`,
     style,
     onPointerDown: (e: React.PointerEvent) => onPointerDown(e, layer.id),
     onDoubleClick: (e: React.MouseEvent) => onDoubleClick(e, layer.id),
     onContextMenu: (e: React.MouseEvent) => onContextMenu(e, layer.id),
   };
 
   if (layer.type === 'text') {
@@ -196,39 +212,64 @@ function LayerElement({
             background: fill ? fillToCSS(fill) : 'transparent',
             border: stroke ? `${stroke.width}px solid ${stroke.color}` : 'none',
             borderRadius: `${layer.borderRadius[0] ?? 0}px ${layer.borderRadius[1] ?? 0}px ${layer.borderRadius[2] ?? 0}px ${layer.borderRadius[3] ?? 0}px`,
             pointerEvents: 'none',
           }}
         />
       </div>
     );
   }
 
-  if (layer.type === 'image' || layer.type === 'video') {
+  if (layer.type === 'image') {
     return (
       <div {...commonProps}>
         {layer.assetId ? (
           <img
             src={motionStudioAssetUrl(layer.assetId)}
             alt={layer.name}
             style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
             draggable={false}
           />
         ) : (
           <div
             style={{ width: '100%', height: '100%', background: '#333', pointerEvents: 'none' }}
           />
         )}
       </div>
     );
   }
 
+  if (layer.type === 'video') {
+    return (
+      <div {...commonProps}>
+        {layer.assetId ? (
+          <video
+            ref={videoRef}
+            src={motionStudioAssetUrl(layer.assetId)}
+            aria-label={layer.name}
+            style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
+            autoPlay={playing}
+            controls={false}
+            loop
+            muted
+            playsInline
+            preload="auto"
+          />
+        ) : (
+          <div
+            style={{ width: '100%', height: '100%', background: '#333', pointerEvents: 'none' }}
+          />
+        )}
+      </div>
+    );
+  }
+
   if (layer.type === 'svg') {
     return (
       <div {...commonProps}>
         {layer.svgContent ? (
           <img
             src={svgContentToDataUrl(layer.svgContent)}
             alt={layer.name}
             style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
             draggable={false}
           />
@@ -277,20 +318,21 @@ export interface MotionStudioCanvasProps {
   readonly onSendToBack: () => void;
   readonly onGroupSelected: () => void;
   readonly onUngroupSelected: () => void;
   readonly onAddTextLayer: () => void;
   readonly onAddRectangleLayer: () => void;
   readonly onAddEllipseLayer: () => void;
   readonly onAddImageLayer: () => void;
   readonly onAddVideoLayer: () => void;
   readonly canvasScale?: number;
   readonly playheadMs?: number;
+  readonly playing?: boolean;
 }
 
 interface GuideLine {
   readonly orientation: 'vertical' | 'horizontal';
   readonly position: number;
 }
 
 interface ContextMenuState {
   readonly x: number;
   readonly y: number;
@@ -348,20 +390,21 @@ export function MotionStudioCanvas({
   onSendToBack,
   onGroupSelected,
   onUngroupSelected,
   onAddTextLayer,
   onAddRectangleLayer,
   onAddEllipseLayer,
   onAddImageLayer,
   onAddVideoLayer,
   canvasScale = 1,
   playheadMs = 0,
+  playing = false,
 }: MotionStudioCanvasProps) {
   const stageRef = useRef<HTMLDivElement | null>(null);
   const [editingTextLayerId, setEditingTextLayerId] = useState<MotionLayerId | null>(null);
   const evaluated = useMemo(
     () => evaluateMotionScene(document, playheadMs),
     [document, playheadMs],
   );
   const layersById = useMemo(() => {
     const map: Record<string, MotionLayer> = {};
     for (const layer of document.layers) map[layer.id] = layer;
@@ -1063,20 +1106,22 @@ export function MotionStudioCanvas({
               layer={layer}
               evaluation={evaluated.get(layer.id)}
               world={world.get(layer.id)}
               isSelected={selectedLayerIds.includes(layer.id)}
               editingText={editingTextLayerId === layer.id}
               onPointerDown={handleLayerPointerDown}
               onDoubleClick={handleLayerDoubleClick}
               onContextMenu={handleLayerContextMenu}
               onTextChange={handleTextChange}
               onTextEditEnd={handleTextEditEnd}
+              playheadMs={playheadMs}
+              playing={playing}
             />
           ))}
 
           {singleSelectedLayer && !editingTextLayerId && (
             <SelectionOverlay
               layer={singleSelectedLayer}
               canvasScale={canvasScale}
               onHandlePointerDown={handleHandlePointerDown}
             />
           )}
diff --git a/apps/editor-web/src/motion-studio/MotionStudioShell.tsx b/apps/editor-web/src/motion-studio/MotionStudioShell.tsx
index 60cf297..99d60c5 100644
--- a/apps/editor-web/src/motion-studio/MotionStudioShell.tsx
+++ b/apps/editor-web/src/motion-studio/MotionStudioShell.tsx
@@ -480,20 +480,21 @@ export function MotionStudioShell({ sceneId, onClose }: MotionStudioShellProps)
               onSendToBack={sendToBack}
               onGroupSelected={groupSelected}
               onUngroupSelected={ungroupSelected}
               onAddTextLayer={handleAddTextLayer}
               onAddRectangleLayer={handleAddRectangleLayer}
               onAddEllipseLayer={handleAddEllipseLayer}
               onAddImageLayer={handleAddImageLayer}
               onAddVideoLayer={handleAddVideoLayer}
               canvasScale={canvasScale}
               playheadMs={playheadMs}
+              playing={playing}
             />
           ) : (
             <div className="ms-code" aria-label="Code editor">
               <div className="ms-code-placeholder">
                 <textarea
                   className="ms-code-textarea"
                   placeholder="// HTML / CSS / JavaScript&#10;// The visual editor generates code here.&#10;// Switch back to Visual Edit to use the canvas."
                   readOnly
                 />
               </div>
diff --git a/apps/editor-web/src/render-plan-capture-targets.test.ts b/apps/editor-web/src/render-plan-capture-targets.test.ts
index e24e1f0..db99dc0 100644
--- a/apps/editor-web/src/render-plan-capture-targets.test.ts
+++ b/apps/editor-web/src/render-plan-capture-targets.test.ts
@@ -1,16 +1,17 @@
 import { describe, expect, it } from 'vitest';
 import type { JoyProjectV1, VisualObjectTransformV1 } from '@joy-media/project-schema';
 import type { PlannedCaptureRequirement } from '@joy-media/render-planner';
 import { IMAGE_MATTE_PLUGIN_KEY } from './sticker-bindings.js';
 import {
   htmlSceneCaptureTargetsForRequirements,
+  plannedMotionSceneCaptureTargets,
   plannedHtmlSceneCaptureTargets,
   plannedStillBitmapTargets,
   requiredCaptureObjectIds,
 } from './render-plan-capture-targets.js';
 
 describe('render plan capture targets', () => {
   it('derives html-scene targets from planner capture requirements and keeps planner timeUs', () => {
     const project = visualProject();
     const targets = plannedHtmlSceneCaptureTargets(project, [
       {
@@ -43,20 +44,54 @@ describe('render plan capture targets', () => {
         assetId: 'html-scene:scene.package.b',
         sourceTimeUs: 345_678,
       },
     ];
 
     expect(htmlSceneCaptureTargetsForRequirements(project, requirements)).toEqual(
       plannedHtmlSceneCaptureTargets(project, requirements),
     );
   });
 
+  it('derives published Motion Studio capture targets only from matching object ids', () => {
+    const project = {
+      ...visualProject(),
+      visualObjects: {
+        ...visualProject().visualObjects,
+        'motion-a': {
+          id: 'motion-a',
+          kind: 'motion-scene' as const,
+          motionSceneId: 'motion-doc-a',
+          transform: transform(),
+        },
+      },
+    };
+    expect(
+      plannedMotionSceneCaptureTargets(project, [
+        {
+          id: 'motion-scene:motion-a',
+          kind: 'motion-scene',
+          objectId: 'motion-a',
+          assetId: 'motion-scene:motion-doc-a',
+          sourceTimeUs: 456_789,
+        },
+      ]),
+    ).toEqual([
+      {
+        requirementId: 'motion-scene:motion-a',
+        objectId: 'motion-a',
+        assetId: 'motion-scene:motion-doc-a',
+        motionSceneId: 'motion-doc-a',
+        timeUs: 456_789,
+      },
+    ]);
+  });
+
   it('derives still targets only for planner-requested objects and preserves matte/crop data', () => {
     const project = visualProject();
     const targets = plannedStillBitmapTargets(project, [
       {
         id: 'still:still-a',
         kind: 'still-bitmap',
         objectId: 'still-a',
         assetId: 'image-a',
       },
     ]);
@@ -137,20 +172,21 @@ function visualProject(): JoyProjectV1 {
         scenePackageId: 'scene.package.a',
         transform: transform(),
       },
       'scene-b': {
         id: 'scene-b',
         kind: 'html-scene',
         scenePackageId: 'scene.package.b',
         transform: transform(),
       },
     },
+    captionDocuments: {},
     pluginData: { [IMAGE_MATTE_PLUGIN_KEY]: { 'still-a': 'matte-a' } },
   };
 }
 
 function transform(
   crop: VisualObjectTransformV1['crop'] = { left: 0, top: 0, right: 0, bottom: 0 },
 ): VisualObjectTransformV1 {
   return {
     x: 0,
     y: 0,
diff --git a/apps/editor-web/src/render-plan-capture-targets.ts b/apps/editor-web/src/render-plan-capture-targets.ts
index 902405d..4221b8b 100644
--- a/apps/editor-web/src/render-plan-capture-targets.ts
+++ b/apps/editor-web/src/render-plan-capture-targets.ts
@@ -12,20 +12,28 @@ export interface PlannedStillBitmapTarget {
 }
 
 export interface PlannedHtmlSceneCaptureTarget {
   readonly requirementId: string;
   readonly objectId: string;
   readonly assetId: string;
   readonly scenePackageId: string;
   readonly timeUs: number;
 }
 
+export interface PlannedMotionSceneCaptureTarget {
+  readonly requirementId: string;
+  readonly objectId: string;
+  readonly assetId: string;
+  readonly motionSceneId: string;
+  readonly timeUs: number;
+}
+
 export function plannedStillBitmapTargets(
   project: JoyProjectV1,
   requirements: readonly PlannedCaptureRequirement[],
 ): readonly PlannedStillBitmapTarget[] {
   const mattes = readImageMatteMap(project);
   return requirements.flatMap((requirement): readonly PlannedStillBitmapTarget[] => {
     if (
       requirement.kind !== 'still-bitmap' ||
       requirement.objectId === undefined ||
       requirement.assetId === undefined
@@ -72,26 +80,60 @@ export function plannedHtmlSceneCaptureTargets(
         assetId: requirement.assetId,
         scenePackageId,
         timeUs: requirement.sourceTimeUs,
       },
     ];
   });
 }
 
 export const htmlSceneCaptureTargetsForRequirements = plannedHtmlSceneCaptureTargets;
 
+export function plannedMotionSceneCaptureTargets(
+  project: JoyProjectV1,
+  requirements: readonly PlannedCaptureRequirement[],
+): readonly PlannedMotionSceneCaptureTarget[] {
+  return requirements.flatMap((requirement): readonly PlannedMotionSceneCaptureTarget[] => {
+    if (
+      requirement.kind !== 'motion-scene' ||
+      requirement.objectId === undefined ||
+      requirement.assetId === undefined ||
+      requirement.sourceTimeUs === undefined
+    ) {
+      return [];
+    }
+    const object = project.visualObjects[requirement.objectId];
+    if (object?.kind !== 'motion-scene' || object.motionSceneId === undefined) return [];
+    const motionSceneId = parseMotionSceneId(requirement.assetId);
+    if (motionSceneId === undefined || motionSceneId !== object.motionSceneId) return [];
+    return [
+      {
+        requirementId: requirement.id,
+        objectId: requirement.objectId,
+        assetId: requirement.assetId,
+        motionSceneId,
+        timeUs: requirement.sourceTimeUs,
+      },
+    ];
+  });
+}
+
 export function requiredCaptureObjectIds(
   requirements: readonly PlannedCaptureRequirement[],
   kind: 'still-bitmap' | 'html-scene',
 ): ReadonlySet<string> {
   const ids = new Set<string>();
   for (const requirement of requirements) {
     if (requirement.kind !== kind || requirement.objectId === undefined) continue;
     ids.add(requirement.objectId);
   }
   return ids;
 }
 
 function parseHtmlScenePackageId(assetId: string): string | undefined {
   const prefix = 'html-scene:';
   return assetId.startsWith(prefix) ? assetId.slice(prefix.length) : undefined;
 }
+
+function parseMotionSceneId(assetId: string): string | undefined {
+  const prefix = 'motion-scene:';
+  return assetId.startsWith(prefix) ? assetId.slice(prefix.length) : undefined;
+}
diff --git a/apps/render-host/src/index.ts b/apps/render-host/src/index.ts
index ba93035..9736924 100644
--- a/apps/render-host/src/index.ts
+++ b/apps/render-host/src/index.ts
@@ -191,20 +191,36 @@ async function* streamFrameInputsForExport(input: {
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
+      motionScenes: await Promise.all(
+        plan.captureRequirements
+          .filter(
+            (requirement) =>
+              requirement.kind === 'motion-scene' && requirement.assetId !== undefined,
+          )
+          .map(async (requirement) => ({
+            ...requirement,
+            media: await resolveAssetInput(
+              input.bundle,
+              input.mediaResolver,
+              input.contentCache,
+              requirement.assetId!,
+            ),
+          })),
+      ),
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
@@ -375,20 +391,27 @@ function applyResolvedMediaCaptures(
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
+    ...(input.motionScenes ?? []).map((sample) => ({
+      key: `${sample.media.contentSha256}:${sample.objectId ?? ''}:${sample.sourceTimeUs ?? 0}:motion`,
+      x: Math.floor(width / 2),
+      y: Math.floor(height / 4),
+      w: Math.max(1, Math.floor(width / 3)),
+      h: Math.max(1, Math.floor(height / 3)),
+    })),
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
diff --git a/apps/render-host/src/protocol.ts b/apps/render-host/src/protocol.ts
index 60b32ae..fd4bb86 100644
--- a/apps/render-host/src/protocol.ts
+++ b/apps/render-host/src/protocol.ts
@@ -40,20 +40,24 @@ export interface RenderHostResolvedAudioSample extends PlannedAudioSample {
 
 export interface RenderHostResolvedCapture extends PlannedCaptureRequirement {
   readonly media: RenderHostResolvedInput;
 }
 
 export interface RenderHostFrameInputV1 {
   readonly plan: RenderFramePlan;
   readonly videoSamples: readonly RenderHostResolvedVideoSample[];
   readonly stillBitmaps: readonly RenderHostResolvedCapture[];
   readonly htmlScenes: readonly RenderHostResolvedCapture[];
+  /** Published Motion Studio captures. Optional for protocol-v1 consumers that
+   * only render legacy bundles; when planned, the host resolves every item or
+   * fails closed before painting the frame. */
+  readonly motionScenes?: readonly RenderHostResolvedCapture[];
   readonly audioSamples: readonly RenderHostResolvedAudioSample[];
 }
 
 export interface RenderHostExportRequestV1 {
   readonly protocolVersion: typeof RENDER_HOST_PROTOCOL_VERSION;
   readonly bundle: RenderBundleV1;
   readonly outputPath: string;
   readonly mediaResolver: RenderHostMediaResolver;
   readonly frameLimit?: number;
 }
diff --git a/apps/worker/src/worker-media-resolver.test.ts b/apps/worker/src/worker-media-resolver.test.ts
index 38a16b2..b60d455 100644
--- a/apps/worker/src/worker-media-resolver.test.ts
+++ b/apps/worker/src/worker-media-resolver.test.ts
@@ -1,24 +1,49 @@
 import { mkdtempSync, writeFileSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { describe, expect, it } from 'vitest';
-import { StaticWorkerMediaResolver } from './worker-media-resolver.js';
+import {
+  StaticWorkerMediaResolver,
+  mediaResolverFromAssetSourceRegistry,
+} from './worker-media-resolver.js';
 
 describe('Worker media resolver', () => {
   it('resolves opaque refs to Worker-private paths without exposing those paths', () => {
     const directory = mkdtempSync(join(tmpdir(), 'joy-media-worker-resolver-'));
     const localPath = join(directory, 'clip.mp4');
     writeFileSync(localPath, 'private media');
     const resolver = new StaticWorkerMediaResolver({ 'asset:clip-a': localPath });
 
     expect(resolver.require('asset:clip-a')).toEqual({ kind: 'file', path: localPath });
     expect(resolver.describe('asset:clip-a')).toEqual({ opaqueRef: 'asset:clip-a' });
     expect(JSON.stringify(resolver.describe('asset:clip-a'))).not.toContain(localPath);
   });
 
   it('refuses missing required opaque refs', () => {
     const resolver = new StaticWorkerMediaResolver({});
 
     expect(() => resolver.require('asset:missing')).toThrow(/asset:missing/);
   });
+
+  it('resolves published Motion Studio media through the private source registry', () => {
+    const directory = mkdtempSync(join(tmpdir(), 'joy-media-worker-motion-resolver-'));
+    const localPath = join(directory, 'motion-doc-1.mp4');
+    writeFileSync(localPath, 'published motion media');
+    const resolver = mediaResolverFromAssetSourceRegistry({
+      resolve: (assetId) => (assetId === 'motion-scene:motion-doc-1' ? localPath : undefined),
+    });
+
+    expect(resolver.require('motion-scene:motion-doc-1')).toEqual({
+      kind: 'file',
+      path: localPath,
+    });
+  });
+
+  it('fails closed with evidence when Motion Studio media is not published', () => {
+    const resolver = mediaResolverFromAssetSourceRegistry({ resolve: () => undefined });
+
+    expect(() => resolver.require('motion-scene:missing-scene')).toThrow(
+      /motion scene media is unavailable.*publish or render/i,
+    );
+  });
 });
diff --git a/apps/worker/src/worker-media-resolver.ts b/apps/worker/src/worker-media-resolver.ts
index 9aadb63..49ebed6 100644
--- a/apps/worker/src/worker-media-resolver.ts
+++ b/apps/worker/src/worker-media-resolver.ts
@@ -34,20 +34,33 @@ export class StaticWorkerMediaResolver implements WorkerMediaResolver {
 }
 
 export function mediaResolverFromAssetSourceRegistry(source: {
   readonly resolve: (assetId: string) => string | undefined;
 }): WorkerMediaResolver {
   return {
     require(opaqueRef) {
       if (opaqueRef.startsWith('html-scene:')) {
         return { kind: 'html-scene', packageId: opaqueRef.slice('html-scene:'.length) };
       }
+      if (opaqueRef.startsWith('motion-scene:')) {
+        // Motion Studio scenes are published as renderable media before a
+        // Worker can consume them. The source registry owns the private path;
+        // do not silently turn an unresolved scene into a placeholder frame.
+        const sceneId = opaqueRef.slice('motion-scene:'.length);
+        const path = source.resolve(opaqueRef) ?? source.resolve(sceneId);
+        if (path === undefined || !existsSync(path)) {
+          throw new Error(
+            `required Worker motion scene media is unavailable: ${opaqueRef}; publish or render the scene first`,
+          );
+        }
+        return { kind: 'file', path };
+      }
       if (!opaqueRef.startsWith('asset:')) {
         throw new Error(`required Worker media is unavailable: ${opaqueRef}`);
       }
       const assetId = opaqueRef.slice('asset:'.length);
       const path = source.resolve(assetId);
       if (path === undefined || !existsSync(path)) {
         throw new Error(`required Worker media is unavailable: ${opaqueRef}`);
       }
       return { kind: 'file', path };
     },
