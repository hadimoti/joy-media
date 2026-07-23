/**
 * Hosts offscreen HTML-scene iframes and caches RGBA bitmaps for Pixi.
 */
import {
  createScenePreviewHost,
  defaultVariablesForScene,
  findFirstPartyScene,
  viewportForScene,
  type ScenePreviewHost,
  type SceneSurfaceBitmap,
} from '@joy-media/html-scene-runtime/browser';
import type { VisualObjectV1 } from '@joy-media/project-schema';

export type HtmlSceneBitmapMap = ReadonlyMap<string, SceneSurfaceBitmap>;

export class HtmlSceneSurfaceCache {
  readonly #hosts = new Map<string, ScenePreviewHost>();
  readonly #bitmaps = new Map<string, SceneSurfaceBitmap>();
  #generation = 0;

  bitmaps(): HtmlSceneBitmapMap {
    return this.#bitmaps;
  }

  async sync(
    objects: Readonly<Record<string, VisualObjectV1>>,
    timeUs: number,
  ): Promise<HtmlSceneBitmapMap> {
    const generation = ++this.#generation;
    const htmlScenes = Object.values(objects).filter((object) => object.kind === 'html-scene');
    const liveIds = new Set(htmlScenes.map((object) => object.id));

    for (const [id, host] of this.#hosts) {
      if (!liveIds.has(id)) {
        host.destroy();
        this.#hosts.delete(id);
        this.#bitmaps.delete(id);
      }
    }

    await Promise.all(
      htmlScenes.map(async (object) => {
        const packageId = object.scenePackageId;
        if (packageId === undefined) return;
        const scene = findFirstPartyScene(packageId);
        if (scene === undefined) return;
        let host = this.#hosts.get(object.id);
        if (host === undefined) {
          host = createScenePreviewHost({ instanceId: object.id, scene });
          this.#hosts.set(object.id, host);
          try {
            await host.ready;
          } catch {
            return;
          }
        }
        if (generation !== this.#generation) return;
        const variables = defaultVariablesForScene(packageId);
        host.update(timeUs, variables);
        const viewport = viewportForScene(packageId);
        // Monitor-scale capture (¼) keeps playhead scrub responsive.
        const width = Math.max(1, Math.round(viewport.width / 4));
        const height = Math.max(1, Math.round(viewport.height / 4));
        try {
          const bitmap = await host.capture(width, height);
          if (generation !== this.#generation) return;
          this.#bitmaps.set(object.id, bitmap);
        } catch {
          // Keep last good frame; failure is non-fatal for Monitor paint.
        }
      }),
    );

    return this.#bitmaps;
  }

  async captureFull(
    objects: Readonly<Record<string, VisualObjectV1>>,
    timeUs: number,
  ): Promise<HtmlSceneBitmapMap> {
    const result = new Map<string, SceneSurfaceBitmap>();
    const htmlScenes = Object.values(objects).filter((object) => object.kind === 'html-scene');
    await Promise.all(
      htmlScenes.map(async (object) => {
        const packageId = object.scenePackageId;
        if (packageId === undefined) return;
        const scene = findFirstPartyScene(packageId);
        if (scene === undefined) return;
        const host = createScenePreviewHost({ instanceId: `export-${object.id}`, scene });
        try {
          await host.ready;
          host.update(timeUs, defaultVariablesForScene(packageId));
          const viewport = viewportForScene(packageId);
          result.set(object.id, await host.capture(viewport.width, viewport.height, 8_000));
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
