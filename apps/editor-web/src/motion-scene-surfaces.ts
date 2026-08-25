/**
 * Browser hydration for published Motion Studio scenes.
 *
 * Motion scenes are stored as versioned documents, not public URLs. The
 * monitor therefore resolves the published document first and only then
 * rasterizes a frame into the same RGBA contract used by HTML scenes and
 * stickers. A missing publication is retained as an explicit diagnostic and
 * never replaced with a fake successful frame.
 */
import type { ImageDataLike } from '@joy-media/playback-engine';
import {
  evaluateMotionScene,
  resolveLayerWorld,
  resolvedLayerOpacity,
  type MotionLayer,
  type MotionSceneDocument,
} from '@joy-media/motion-core';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import { getPublishedMotionScene, type MotionSceneCatalogEntry } from './motion-scene-catalog.js';
import type { PlannedMotionSceneCaptureTarget } from './render-plan-capture-targets.js';

export interface MotionSceneSurfaceDiagnostic {
  readonly objectId: string;
  readonly motionSceneId: string;
  readonly code: 'MOTION_SCENE_NOT_PUBLISHED' | 'MOTION_SCENE_CAPTURE_FAILED';
  readonly message: string;
}

export type MotionSceneSurfaceBitmap = ImageDataLike;

const DEFAULT_CAPTURE_SCALE = 4;

export class MotionSceneSurfaceCache {
  readonly #storage: BrowserKeyValueStore;
  readonly #bitmaps = new Map<string, MotionSceneSurfaceBitmap>();
  readonly #diagnostics = new Map<string, MotionSceneSurfaceDiagnostic>();
  readonly #media = new Map<string, HTMLImageElement | HTMLVideoElement>();

  constructor(storage: BrowserKeyValueStore) {
    this.#storage = storage;
  }

  bitmaps(): ReadonlyMap<string, MotionSceneSurfaceBitmap> {
    return this.#bitmaps;
  }

  diagnostics(): readonly MotionSceneSurfaceDiagnostic[] {
    return [...this.#diagnostics.values()];
  }

  async sync(
    targets: readonly PlannedMotionSceneCaptureTarget[],
    scale = DEFAULT_CAPTURE_SCALE,
  ): Promise<ReadonlyMap<string, MotionSceneSurfaceBitmap>> {
    const liveIds = new Set(targets.map((target) => target.objectId));
    for (const id of this.#bitmaps.keys()) if (!liveIds.has(id)) this.#bitmaps.delete(id);
    for (const id of this.#diagnostics.keys()) if (!liveIds.has(id)) this.#diagnostics.delete(id);
    await Promise.all(targets.map((target) => this.#captureTarget(target, scale)));
    return this.#bitmaps;
  }

  async captureFull(
    targets: readonly PlannedMotionSceneCaptureTarget[],
  ): Promise<ReadonlyMap<string, MotionSceneSurfaceBitmap>> {
    const result = new Map<string, MotionSceneSurfaceBitmap>();
    await Promise.all(
      targets.map(async (target) => {
        const bitmap = await this.#renderTarget(target, 1);
        if (bitmap !== undefined) result.set(target.objectId, bitmap);
      }),
    );
    return result;
  }

  destroy(): void {
    for (const media of this.#media.values()) {
      if (media instanceof HTMLVideoElement) {
        media.pause();
        media.removeAttribute('src');
        media.load();
      } else {
        media.removeAttribute('src');
      }
    }
    this.#media.clear();
    this.#bitmaps.clear();
    this.#diagnostics.clear();
  }

  async #captureTarget(target: PlannedMotionSceneCaptureTarget, scale: number): Promise<void> {
    const bitmap = await this.#renderTarget(target, scale);
    if (bitmap !== undefined) this.#bitmaps.set(target.objectId, bitmap);
  }

  async #renderTarget(
    target: PlannedMotionSceneCaptureTarget,
    scale: number,
  ): Promise<MotionSceneSurfaceBitmap | undefined> {
    const scene = getPublishedMotionScene(this.#storage, target.motionSceneId);
    if (scene === undefined) {
      this.#diagnostics.set(target.objectId, {
        objectId: target.objectId,
        motionSceneId: target.motionSceneId,
        code: 'MOTION_SCENE_NOT_PUBLISHED',
        message: `Motion scene ${target.motionSceneId} is not published and cannot be previewed`,
      });
      this.#bitmaps.delete(target.objectId);
      return undefined;
    }
    try {
      const bitmap = await rasterizeMotionScene(scene, target.timeUs, scale, this.#media);
      this.#diagnostics.delete(target.objectId);
      return bitmap;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#diagnostics.set(target.objectId, {
        objectId: target.objectId,
        motionSceneId: target.motionSceneId,
        code: 'MOTION_SCENE_CAPTURE_FAILED',
        message: `Motion scene ${target.motionSceneId} could not be captured: ${message}`,
      });
      this.#bitmaps.delete(target.objectId);
      return undefined;
    }
  }
}

async function rasterizeMotionScene(
  scene: MotionSceneDocument,
  timeUs: number,
  scale: number,
  media: Map<string, HTMLImageElement | HTMLVideoElement>,
): Promise<MotionSceneSurfaceBitmap> {
  if (typeof document === 'undefined') throw new Error('browser canvas is unavailable');
  const width = Math.max(1, Math.round(scene.width / scale));
  const height = Math.max(1, Math.round(scene.height / scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('2d canvas context is unavailable');
  paintBackground(context, scene, width, height);
  const evaluated = evaluateMotionScene(scene, timeUs / 1000);
  const layersById: Record<string, MotionLayer> = Object.fromEntries(
    scene.layers.map((layer) => [layer.id, layer]),
  );
  for (const layer of scene.layers) {
    if (!layer.visible) continue;
    await hydrateLayerMedia(layer, timeUs, media);
    const world = resolveLayerWorld(layer, evaluated.get(layer.id), layersById).worldTransform;
    const opacity = resolvedLayerOpacity(layer, evaluated.get(layer.id));
    context.save();
    context.globalAlpha = Math.max(0, Math.min(1, opacity));
    context.translate((world.x + world.width / 2) / scale, (world.y + world.height / 2) / scale);
    context.rotate((world.rotationDeg * Math.PI) / 180);
    context.scale(world.scaleX / scale, world.scaleY / scale);
    drawLayer(context, layer, world.width, world.height, media, timeUs);
    context.restore();
  }
  return context.getImageData(0, 0, width, height);
}

async function hydrateLayerMedia(
  layer: MotionLayer,
  timeUs: number,
  media: Map<string, HTMLImageElement | HTMLVideoElement>,
): Promise<void> {
  if ((layer.type !== 'image' && layer.type !== 'video') || layer.assetId === undefined) return;
  let element = media.get(layer.assetId);
  if (element === undefined) {
    const url = `/v1/library/cloud-assets/${encodeURIComponent(layer.assetId)}/content`;
    element =
      layer.type === 'video' ? document.createElement('video') : document.createElement('img');
    element.crossOrigin = 'anonymous';
    element.src = url;
    if (element instanceof HTMLVideoElement) {
      element.muted = true;
      element.playsInline = true;
      element.preload = 'auto';
      await waitForMedia(element, 'loadeddata');
    } else {
      await waitForMedia(element, 'load');
    }
    media.set(layer.assetId, element);
  }
  if (element instanceof HTMLVideoElement) {
    element.currentTime = Math.max(0, timeUs / 1_000_000);
    if (element.readyState < 2) await waitForMedia(element, 'loadeddata');
  }
}

function waitForMedia(
  element: HTMLImageElement | HTMLVideoElement,
  event: 'load' | 'loadeddata',
): Promise<void> {
  if (element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0) {
    return Promise.resolve();
  }
  if (element instanceof HTMLVideoElement && element.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`media ${event} timed out`));
    }, 2_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      element.removeEventListener(event, onLoad);
      element.removeEventListener('error', onError);
    };
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`media ${event} failed`));
    };
    element.addEventListener(event, onLoad, { once: true });
    element.addEventListener('error', onError, { once: true });
  });
}

function paintBackground(
  context: CanvasRenderingContext2D,
  scene: MotionSceneDocument,
  width: number,
  height: number,
): void {
  if (scene.background.kind === 'solid' && scene.background.color !== undefined) {
    context.fillStyle = scene.background.color;
    context.fillRect(0, 0, width, height);
  } else {
    context.clearRect(0, 0, width, height);
  }
}

function drawLayer(
  context: CanvasRenderingContext2D,
  layer: MotionLayer,
  width: number,
  height: number,
  media: Map<string, HTMLImageElement | HTMLVideoElement>,
  timeUs: number,
): void {
  const x = -width / 2;
  const y = -height / 2;
  if (layer.type === 'shape') {
    context.fillStyle = fillColor(layer) ?? '#ffffff';
    context.fillRect(x, y, width, height);
    return;
  }
  if (layer.type === 'text') {
    context.fillStyle = fillColor(layer) ?? '#ffffff';
    context.font = `${layer.typography?.fontSize ?? 40}px ${layer.typography?.fontFamily ?? 'sans-serif'}`;
    context.textBaseline = 'top';
    context.fillText(layer.text ?? '', x, y, width);
    return;
  }
  if ((layer.type === 'image' || layer.type === 'video') && layer.assetId !== undefined) {
    const element = media.get(layer.assetId);
    if (element !== undefined && element instanceof HTMLVideoElement) {
      element.currentTime = Math.max(0, timeUs / 1_000_000);
    }
    if (element !== undefined) context.drawImage(element, x, y, width, height);
    else {
      context.fillStyle = '#253047';
      context.fillRect(x, y, width, height);
    }
    return;
  }
  context.fillStyle = 'rgba(255,255,255,0.12)';
  context.fillRect(x, y, width, height);
}

function fillColor(layer: MotionLayer): string | undefined {
  const fill = layer.fills[0];
  if (fill?.kind === 'solid') return fill.color;
  if (fill?.kind === 'gradient') return fill.gradient.stops[0]?.color;
  return undefined;
}

export function motionSceneTargetFromCatalog(
  entry: MotionSceneCatalogEntry,
  objectId: string,
  timeUs: number,
): PlannedMotionSceneCaptureTarget {
  return {
    requirementId: `motion-scene:${objectId}`,
    objectId,
    assetId: `motion-scene:${entry.id}`,
    motionSceneId: entry.id,
    timeUs,
  };
}
