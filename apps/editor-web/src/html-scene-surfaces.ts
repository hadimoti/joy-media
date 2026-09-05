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

export interface HtmlSceneExportCaptureOptions {
  readonly width: number;
  readonly height: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Current-frame RGBA budget, independent of project duration. */
  readonly maxFrameBytes?: number;
}

function waitForCapture<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(new DOMException('Export cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('HTML scene export timed out'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
    };
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) aborted();
  });
}

export class HtmlSceneSurfaceCache {
  readonly #hosts = new Map<string, ScenePreviewHost>();
  readonly #bitmaps = new Map<string, SceneSurfaceBitmap>();
  #generation = 0;
  #activeCapture: AbortController | undefined;
  #capturedFrames = 0;
  #peakFrameBytes = 0;

  /** Owned RGBA only; browser/GPU allocations are not included. */
  exportMetrics(): {
    capturedFrames: number;
    retainedFrameBytes: number;
    peakFrameBytes: number;
    hosts: number;
  } {
    return {
      capturedFrames: this.#capturedFrames,
      retainedFrameBytes: [...this.#bitmaps.values()].reduce(
        (bytes, bitmap) => bytes + bitmap.data.byteLength,
        0,
      ),
      peakFrameBytes: this.#peakFrameBytes,
      hosts: this.#hosts.size,
    };
  }

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
    options: HtmlSceneExportCaptureOptions,
  ): Promise<HtmlSceneBitmapMap> {
    if (this.#activeCapture !== undefined)
      throw new Error('HTML export capture is already in progress');
    const { width, height } = options;
    const timeoutMs = options.timeoutMs ?? 8_000;
    if (![width, height, timeoutMs].every((value) => Number.isSafeInteger(value) && value > 0))
      throw new RangeError('HTML export dimensions and timeout must be positive safe integers');
    const result = new Map<string, SceneSurfaceBitmap>();
    const htmlScenes = Object.values(objects).filter((object) => object.kind === 'html-scene');
    const frameBytes = width * height * 4 * htmlScenes.length;
    const budget = options.maxFrameBytes ?? 256 * 1024 * 1024;
    if (
      !Number.isSafeInteger(frameBytes) ||
      !Number.isSafeInteger(budget) ||
      budget < 1 ||
      frameBytes > budget
    )
      throw new RangeError('HTML scene export exceeds the current-frame RGBA memory budget');
    const controller = new AbortController();
    this.#activeCapture = controller;
    const abort = () => this.destroy();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    this.#generation += 1;
    // Release the previous frame before allocating this frame's surfaces.
    this.#bitmaps.clear();
    const liveIds = new Set(htmlScenes.map((object) => object.id));
    for (const [id, host] of this.#hosts) {
      if (!liveIds.has(id)) {
        host.destroy();
        this.#hosts.delete(id);
        this.#bitmaps.delete(id);
      }
    }
    try {
      // Bound in-flight rasterization to one scene, not one burst per frame.
      for (const object of htmlScenes) {
        controller.signal.throwIfAborted();
        const packageId = object.scenePackageId;
        const scene = packageId === undefined ? undefined : findFirstPartyScene(packageId);
        if (scene === undefined || packageId === undefined)
          throw new Error(`HTML scene ${object.id} has no available scene package`);
        let host = this.#hosts.get(object.id);
        if (host === undefined) {
          host = createScenePreviewHost({ instanceId: `export-${object.id}`, scene });
          this.#hosts.set(object.id, host);
        }
        await waitForCapture(host.ready, controller.signal, timeoutMs);
        controller.signal.throwIfAborted();
        if (!host.update(timeUs, defaultVariablesForScene(packageId)))
          throw new Error(`HTML scene ${object.id} is suspended`);
        const bitmap = await waitForCapture(
          host.capture(width, height, timeoutMs),
          controller.signal,
          timeoutMs,
        );
        controller.signal.throwIfAborted();
        if (
          bitmap.width !== width ||
          bitmap.height !== height ||
          bitmap.data.byteLength !== width * height * 4
        )
          throw new Error(`HTML scene ${object.id} returned an invalid target-resolution surface`);
        result.set(object.id, bitmap);
        this.#bitmaps.set(object.id, bitmap);
      }
      this.#capturedFrames += 1;
      this.#peakFrameBytes = Math.max(this.#peakFrameBytes, frameBytes);
      return result;
    } catch (error) {
      result.clear();
      this.destroy();
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      this.#activeCapture = undefined;
    }
  }

  destroy(): void {
    this.#activeCapture?.abort();
    this.#generation += 1;
    for (const host of this.#hosts.values()) host.destroy();
    this.#hosts.clear();
    this.#bitmaps.clear();
  }
}
