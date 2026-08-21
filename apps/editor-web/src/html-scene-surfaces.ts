/**
 * Hosts offscreen HTML-scene iframes and caches RGBA bitmaps for Pixi.
 */
import type { ImageDataLike } from '@joy-media/playback-engine';
import {
  createScenePreviewHost,
  defaultVariablesForScene,
  findFirstPartyScene,
  viewportForScene,
  type ScenePreviewHost,
  type SceneSurfaceBitmap,
} from '@joy-media/html-scene-runtime/browser';
import type { PlannedHtmlSceneCaptureTarget } from './render-plan-capture-targets.js';

export type HtmlSceneBitmapMap = ReadonlyMap<string, SceneSurfaceBitmap>;

export interface DeliverySceneFrameSource {
  captureInto(
    bitmaps: Map<string, ImageDataLike>,
    captureTargets: readonly PlannedHtmlSceneCaptureTarget[],
  ): Promise<void>;
  destroy(): void;
}

const MONITOR_CAPTURE_SCALE = 4;
const DELIVERY_CAPTURE_TIMEOUT_MS = 8_000;

export class HtmlSceneSurfaceCache {
  readonly #hosts = new Map<string, ScenePreviewHost>();
  readonly #bitmaps = new Map<string, SceneSurfaceBitmap>();
  #generation = 0;

  bitmaps(): HtmlSceneBitmapMap {
    return this.#bitmaps;
  }

  async sync(targets: readonly PlannedHtmlSceneCaptureTarget[]): Promise<HtmlSceneBitmapMap> {
    const generation = ++this.#generation;
    const liveIds = new Set(targets.map((target) => target.objectId));

    for (const [id, host] of this.#hosts) {
      if (!liveIds.has(id)) {
        host.destroy();
        this.#hosts.delete(id);
        this.#bitmaps.delete(id);
      }
    }

    await Promise.all(
      targets.map(async (target) => {
        const scene = findFirstPartyScene(target.scenePackageId);
        if (scene === undefined) return;
        let host = this.#hosts.get(target.objectId);
        if (host === undefined) {
          host = createScenePreviewHost({ instanceId: target.objectId, scene });
          this.#hosts.set(target.objectId, host);
          try {
            await host.ready;
          } catch {
            return;
          }
        }
        if (generation !== this.#generation) return;
        const variables = defaultVariablesForScene(target.scenePackageId);
        host.update(target.timeUs, variables);
        const viewport = viewportForScene(target.scenePackageId);
        // Monitor-scale capture (¼) keeps playhead scrub responsive.
        const width = Math.max(1, Math.round(viewport.width / MONITOR_CAPTURE_SCALE));
        const height = Math.max(1, Math.round(viewport.height / MONITOR_CAPTURE_SCALE));
        try {
          const bitmap = await host.capture(width, height);
          if (generation !== this.#generation) return;
          this.#bitmaps.set(target.objectId, bitmap);
        } catch {
          // Keep last good frame; failure is non-fatal for Monitor paint.
        }
      }),
    );

    return this.#bitmaps;
  }

  async captureFull(
    targets: readonly PlannedHtmlSceneCaptureTarget[],
  ): Promise<HtmlSceneBitmapMap> {
    const result = new Map<string, SceneSurfaceBitmap>();
    await Promise.all(
      targets.map(async (target) => {
        const scene = findFirstPartyScene(target.scenePackageId);
        if (scene === undefined) return;
        const host = createScenePreviewHost({
          instanceId: `export-${target.requirementId}`,
          scene,
        });
        try {
          await host.ready;
          host.update(target.timeUs, defaultVariablesForScene(target.scenePackageId));
          const viewport = viewportForScene(target.scenePackageId);
          result.set(
            target.objectId,
            await host.capture(viewport.width, viewport.height, DELIVERY_CAPTURE_TIMEOUT_MS),
          );
        } finally {
          host.destroy();
        }
      }),
    );
    return result;
  }

  destroy(): void {
    this.#generation += 1;
    for (const host of this.#hosts.values()) host.destroy();
    this.#hosts.clear();
    this.#bitmaps.clear();
  }
}

export function createDeliverySceneFrameSource(
  sceneCache: Pick<HtmlSceneSurfaceCache, 'captureFull' | 'destroy'>,
): DeliverySceneFrameSource {
  return {
    async captureInto(bitmaps, captureTargets) {
      if (captureTargets.length === 0) return;
      const scenes = await sceneCache.captureFull(captureTargets);
      for (const [id, bitmap] of scenes) bitmaps.set(id, bitmap);
    },
    destroy() {
      sceneCache.destroy();
    },
  };
}
