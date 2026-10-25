/**
 * Hosts offscreen HTML-scene iframes and caches RGBA bitmaps for Pixi.
 */
import {
  createScenePreviewHost,
  defaultVariablesForScene,
  findFirstPartyScene,
  viewportForScene,
  type ScenePreviewHost,
  type ScenePreviewFontFace,
  type SceneSurfaceBitmap,
} from '@joy-media/html-scene-runtime/browser';
import type { VisualObjectV1 } from '@joy-media/project-schema';
import type {
  JoyProjectV1,
  JsonValue,
  SpikeProject,
  TitleInstanceV1,
} from '@joy-media/project-schema';
import { normalizeUniversalTimeline } from '@joy-media/project-schema';
import { buildTitleSceneFrame } from '@joy-media/motion-core';
import type { ScenePaintFrameV1 } from '@joy-media/project-schema';
import { scenePaintFontDescriptors } from '../../../packages/html-scene-runtime/src/font-descriptors.js';
import { p0TitleFontFaces } from './p0-title-fonts.js';

export type HtmlSceneBitmapMap = ReadonlyMap<string, SceneSurfaceBitmap>;

export interface HtmlSceneProjectContext {
  readonly visual: JoyProjectV1;
  readonly timeline: SpikeProject;
}

function activeTitleFrames(
  context: HtmlSceneProjectContext,
  timeUs: number,
): ReadonlyMap<
  string,
  { instance: TitleInstanceV1; instanceId: string; durationUs: number; localTimeUs: number }
> {
  const plugin = context.visual.pluginData['joy.contentTemplates'];
  const instances =
    plugin !== null && typeof plugin === 'object' && !Array.isArray(plugin) && 'instances' in plugin
      ? plugin.instances
      : undefined;
  const clipObjectValue = context.visual.pluginData['joy.clipObjects'];
  const clipObjects: Readonly<Record<string, JsonValue>> =
    clipObjectValue !== null &&
    typeof clipObjectValue === 'object' &&
    !Array.isArray(clipObjectValue)
      ? (clipObjectValue as Readonly<Record<string, JsonValue>>)
      : {};
  const normalized = normalizeUniversalTimeline(context.visual);
  const objects = new Map(
    Object.values(context.visual.visualObjects).map((object) => [object.id, object]),
  );
  const result = new Map<
    string,
    { instance: TitleInstanceV1; instanceId: string; durationUs: number; localTimeUs: number }
  >();
  if (
    instances === undefined ||
    instances === null ||
    typeof instances !== 'object' ||
    Array.isArray(instances)
  )
    return result;
  for (const item of normalized.items) {
    if (!item.trackEnabled || timeUs < item.startUs || timeUs - item.startUs >= item.durationUs)
      continue;
    const objectId = item.source.kind === 'object' ? item.source.id : clipObjects[item.id];
    if (typeof objectId !== 'string') continue;
    const object = objects.get(objectId);
    if (object?.kind !== 'html-scene' || !object.scenePackageId?.startsWith('joy.p0.')) continue;
    const found = Object.entries(instances).find(
      ([, value]) =>
        value !== null &&
        typeof value === 'object' &&
        'objectId' in value &&
        value.objectId === objectId,
    );
    if (found === undefined) continue;
    result.set(objectId, {
      instance: found[1] as TitleInstanceV1,
      instanceId: found[0],
      durationUs: item.durationUs,
      localTimeUs: timeUs - item.startUs,
    });
  }
  return result;
}

function activeHtmlSceneIds(context: HtmlSceneProjectContext, timeUs: number): ReadonlySet<string> {
  const plugin = context.visual.pluginData['joy.clipObjects'];
  const clipObjects: Readonly<Record<string, JsonValue>> =
    plugin !== null && typeof plugin === 'object' && !Array.isArray(plugin)
      ? (plugin as Readonly<Record<string, JsonValue>>)
      : {};
  const objects = context.visual.visualObjects;
  const ids = new Set<string>();
  for (const item of normalizeUniversalTimeline(context.visual).items) {
    if (!item.trackEnabled || timeUs < item.startUs || timeUs - item.startUs >= item.durationUs)
      continue;
    const objectId = item.source.kind === 'object' ? item.source.id : clipObjects[item.id];
    if (typeof objectId === 'string' && objects[objectId]?.kind === 'html-scene') ids.add(objectId);
  }
  return ids;
}

function isProjectContext(
  input: Readonly<Record<string, VisualObjectV1>> | HtmlSceneProjectContext,
): input is HtmlSceneProjectContext {
  return 'visual' in input && 'timeline' in input && typeof input.visual === 'object';
}

function p0Scene(id: string, width: number, height: number) {
  return {
    id: id as 'joy.firstparty.title',
    name: 'JOY P0 title',
    previewFocus: { x: 0, y: 0, w: 1, h: 1 },
    manifest: {
      formatVersion: 1 as const,
      id,
      version: '1.0.0',
      runtime: 'joy-html-scene-1' as const,
      entry: 'dist/index.js',
      viewport: { width, height },
      transparent: true,
      durationUs: Number.MAX_SAFE_INTEGER,
      permissions: { network: [], storage: 'none' as const },
      determinism: { seededRandom: true, wallClock: false },
    },
    variableSchema: {},
    source: `globalThis.__joyScene = function(ctx) { var v=ctx.variables; return React.createElement('div',{style:{position:'absolute',inset:0,background:'transparent'}},React.createElement('div',{style:{position:'absolute',left:v.x+'px',top:v.y+'px',width:v.width+'px',fontFamily:'Noto Sans Arabic',fontWeight:v.weight,direction:v.direction,textAlign:v.align,color:'#fff',opacity:v.opacity}},React.createElement('div',null,v.primary),React.createElement('div',null,v.secondary))); };`,
  };
}

async function verifyScenePaintFontBytes(
  frame: ScenePaintFrameV1,
  browserFaces: readonly ScenePreviewFontFace[],
): Promise<void> {
  for (const descriptor of frame.fonts) {
    const face = browserFaces.find(
      (candidate) =>
        candidate.family === descriptor.family &&
        candidate.weight === descriptor.weight &&
        candidate.subset === descriptor.subset,
    );
    if (face === undefined)
      throw new Error(`Fetched P0 font is missing: ${descriptor.subset} ${descriptor.weight}`);
    const binary = atob(face.bytesBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    if (bytes.byteLength !== descriptor.length)
      throw new Error(`Fetched P0 font length mismatch: ${descriptor.subset} ${descriptor.weight}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
    const sha256 = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    if (sha256 !== descriptor.sha256)
      throw new Error(
        `Fetched P0 font integrity mismatch: ${descriptor.subset} ${descriptor.weight}`,
      );
  }
}

export interface HtmlSceneExportCaptureOptions {
  readonly width: number;
  readonly height: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Current-frame RGBA budget, independent of project duration. */
  readonly maxFrameBytes?: number;
}

interface HostOwnership {
  readonly key: string;
  readonly created: Promise<ScenePreviewHost>;
  host?: ScenePreviewHost;
  serial: Promise<void>;
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
  readonly #hosts = new Map<string, HostOwnership>();
  readonly #bitmaps = new Map<string, SceneSurfaceBitmap>();
  #generation = 0;
  #activeCapture: AbortController | undefined;
  #capturedFrames = 0;
  #peakFrameBytes = 0;
  #captureDone: Promise<void> | undefined;

  #acquireHost(
    id: string,
    key: string,
    create: () => ScenePreviewHost | Promise<ScenePreviewHost>,
  ): HostOwnership {
    const current = this.#hosts.get(id);
    if (current?.key === key) return current;
    if (current !== undefined) this.#retireHost(id, current);
    let resolveCreated!: (host: ScenePreviewHost) => void;
    let rejectCreated!: (error: unknown) => void;
    const created = new Promise<ScenePreviewHost>((resolve, reject) => {
      resolveCreated = resolve;
      rejectCreated = reject;
    });
    void created.catch(() => undefined);
    const ownership: HostOwnership = { key, created, serial: Promise.resolve() };
    // Publish the slot before running a factory that may itself await fonts.
    this.#hosts.set(id, ownership);
    let creation: ScenePreviewHost | Promise<ScenePreviewHost>;
    try {
      creation = create();
    } catch (error) {
      if (this.#hosts.get(id) === ownership) this.#hosts.delete(id);
      rejectCreated(error);
      return ownership;
    }
    Promise.resolve(creation).then(
      (host) => {
        if (this.#hosts.get(id) !== ownership) host.destroy();
        else ownership.host = host;
        resolveCreated(host);
      },
      (error: unknown) => {
        if (this.#hosts.get(id) === ownership) this.#hosts.delete(id);
        rejectCreated(error);
      },
    );
    return ownership;
  }

  #retireHost(id: string, ownership: HostOwnership): void {
    if (this.#hosts.get(id) !== ownership) return;
    this.#hosts.delete(id);
    this.#bitmaps.delete(id);
    ownership.host?.destroy();
  }

  #withHost<T>(
    ownership: HostOwnership,
    operation: (host: ScenePreviewHost) => Promise<T>,
  ): Promise<T> {
    const result = ownership.serial.then(async () => operation(await ownership.created));
    ownership.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #owns(id: string, ownership: HostOwnership, generation: number): boolean {
    return generation === this.#generation && this.#hosts.get(id) === ownership;
  }

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
      hosts: [...this.#hosts.values()].filter((entry) => entry.host !== undefined).length,
    };
  }

  bitmaps(): HtmlSceneBitmapMap {
    return this.#bitmaps;
  }

  async sync(
    input: Readonly<Record<string, VisualObjectV1>> | HtmlSceneProjectContext,
    timeUs: number,
  ): Promise<HtmlSceneBitmapMap> {
    if (this.#captureDone !== undefined) await this.#captureDone;
    const generation = ++this.#generation;
    const context = isProjectContext(input) ? input : undefined;
    const objects: Readonly<Record<string, VisualObjectV1>> =
      context === undefined
        ? (input as Readonly<Record<string, VisualObjectV1>>)
        : context.visual.visualObjects;
    const titles = context === undefined ? new Map() : activeTitleFrames(context, timeUs);
    const activeIds = context === undefined ? undefined : activeHtmlSceneIds(context, timeUs);
    const htmlScenes = Object.values(objects).filter((object) => object.kind === 'html-scene');
    const liveIds = new Set(
      htmlScenes
        .filter(
          (object) =>
            (activeIds === undefined || activeIds.has(object.id)) &&
            (!object.scenePackageId?.startsWith('joy.p0.') || titles.has(object.id)),
        )
        .map((object) => object.id),
    );

    for (const [id, ownership] of this.#hosts)
      if (!liveIds.has(id)) this.#retireHost(id, ownership);

    await Promise.all(
      htmlScenes
        .filter((object) => liveIds.has(object.id))
        .map(async (object) => {
          const packageId = object.scenePackageId;
          if (packageId === undefined) return;
          const title = titles.get(object.id);
          if (packageId.startsWith('joy.p0.')) {
            if (title === undefined) return;
            const composition = context?.visual.compositions[context.visual.rootCompositionId];
            if (composition === undefined) return;
            const fontIdentity = JSON.stringify(scenePaintFontDescriptors());
            const key = `${packageId}:${composition.width}x${composition.height}:${fontIdentity}`;
            const fontPromise = p0TitleFontFaces();
            const ownership = this.#acquireHost(object.id, key, async () =>
              createScenePreviewHost({
                instanceId: object.id,
                scene: p0Scene(packageId, composition.width, composition.height) as never,
                fontFaces: await fontPromise,
              }),
            );
            const fontFaces = await fontPromise;
            if (!this.#owns(object.id, ownership, generation)) return;
            const frame = buildTitleSceneFrame(
              title.instance,
              title.instanceId,
              title.durationUs,
              title.localTimeUs,
              {
                widthPx: composition.width,
                heightPx: composition.height,
                fontFaces: scenePaintFontDescriptors(),
                frameRate: composition.frameRate,
                locale: context?.visual.settings.defaultLocale ?? 'en',
              },
            );
            await verifyScenePaintFontBytes(frame.paint, fontFaces);
            if (!this.#owns(object.id, ownership, generation)) return;
            await this.#withHost(ownership, async (host) => {
              await host.ready;
              if (!this.#owns(object.id, ownership, generation)) return;
              await document.fonts.ready;
              if (!this.#owns(object.id, ownership, generation)) return;
              host.update(title.localTimeUs, frame.variables);
              const bitmap = await host.capture(
                composition.width,
                composition.height,
                2_500,
                undefined,
                false,
                frame.paint,
              );
              if (!this.#owns(object.id, ownership, generation)) return;
              this.#bitmaps.set(object.id, bitmap);
            });
            return;
          }
          const scene = findFirstPartyScene(packageId);
          if (scene === undefined) return;
          const viewport = viewportForScene(packageId);
          const ownership = this.#acquireHost(
            object.id,
            `${packageId}:${viewport.width}x${viewport.height}:no-fonts`,
            () => createScenePreviewHost({ instanceId: object.id, scene }),
          );
          const variables = defaultVariablesForScene(packageId);
          // Monitor-scale capture (¼) keeps playhead scrub responsive.
          const width = Math.max(1, Math.round(viewport.width / 4));
          const height = Math.max(1, Math.round(viewport.height / 4));
          try {
            await this.#withHost(ownership, async (host) => {
              await host.ready;
              if (!this.#owns(object.id, ownership, generation)) return;
              host.update(timeUs, variables);
              const bitmap = await host.capture(width, height);
              if (!this.#owns(object.id, ownership, generation)) return;
              this.#bitmaps.set(object.id, bitmap);
            });
          } catch {
            // Keep last good frame; failure is non-fatal for Monitor paint.
          }
        }),
    );

    return this.#bitmaps;
  }

  async captureFull(
    input: Readonly<Record<string, VisualObjectV1>> | HtmlSceneProjectContext,
    timeUs: number,
    options: HtmlSceneExportCaptureOptions,
  ): Promise<HtmlSceneBitmapMap> {
    if (this.#activeCapture !== undefined)
      throw new Error('HTML export capture is already in progress');
    const { width, height } = options;
    const context = isProjectContext(input) ? input : undefined;
    const objects: Readonly<Record<string, VisualObjectV1>> =
      context === undefined
        ? (input as Readonly<Record<string, VisualObjectV1>>)
        : context.visual.visualObjects;
    const titles = context === undefined ? new Map() : activeTitleFrames(context, timeUs);
    const activeIds = context === undefined ? undefined : activeHtmlSceneIds(context, timeUs);
    const timeoutMs = options.timeoutMs ?? 8_000;
    if (![width, height, timeoutMs].every((value) => Number.isSafeInteger(value) && value > 0))
      throw new RangeError('HTML export dimensions and timeout must be positive safe integers');
    const result = new Map<string, SceneSurfaceBitmap>();
    const htmlScenes = Object.values(objects).filter((object) => object.kind === 'html-scene');
    const liveScenes = htmlScenes.filter(
      (object) =>
        (activeIds === undefined || activeIds.has(object.id)) &&
        (!object.scenePackageId?.startsWith('joy.p0.') || titles.has(object.id)),
    );
    const frameBytes = width * height * 4 * liveScenes.length;
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
    let finishCapture!: () => void;
    this.#captureDone = new Promise<void>((resolve) => {
      finishCapture = resolve;
    });
    const abort = () => this.destroy();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const generation = ++this.#generation;
    // Release the previous frame before allocating this frame's surfaces.
    this.#bitmaps.clear();
    const liveIds = new Set(liveScenes.map((object) => object.id));
    for (const [id, ownership] of this.#hosts)
      if (!liveIds.has(id)) this.#retireHost(id, ownership);
    try {
      // Bound in-flight rasterization to one scene, not one burst per frame.
      for (const object of liveScenes) {
        controller.signal.throwIfAborted();
        const packageId = object.scenePackageId;
        if (packageId?.startsWith('joy.p0.')) {
          const title = titles.get(object.id);
          if (title === undefined) continue;
          const composition = context?.visual.compositions[context.visual.rootCompositionId];
          if (composition === undefined)
            throw new Error(`P0 title composition missing for ${title.instanceId}`);
          const fontIdentity = JSON.stringify(scenePaintFontDescriptors());
          const key = `${packageId}:${composition.width}x${composition.height}:${fontIdentity}`;
          const fontPromise = p0TitleFontFaces();
          const ownership = this.#acquireHost(object.id, key, async () =>
            createScenePreviewHost({
              instanceId: `export-${object.id}`,
              scene: p0Scene(packageId, composition.width, composition.height) as never,
              fontFaces: await fontPromise,
            }),
          );
          const fontFaces = await fontPromise;
          if (!this.#owns(object.id, ownership, generation)) continue;
          const frame = buildTitleSceneFrame(
            title.instance,
            title.instanceId,
            title.durationUs,
            title.localTimeUs,
            {
              widthPx: composition.width,
              heightPx: composition.height,
              fontFaces: scenePaintFontDescriptors(),
              frameRate: composition.frameRate,
              locale: context?.visual.settings.defaultLocale ?? 'en',
            },
          );
          await verifyScenePaintFontBytes(frame.paint, fontFaces);
          if (!this.#owns(object.id, ownership, generation)) continue;
          const bitmap = await this.#withHost(ownership, async (host) => {
            await waitForCapture(host.ready, controller.signal, timeoutMs);
            if (!this.#owns(object.id, ownership, generation)) return undefined;
            await waitForCapture(
              document.fonts.ready.then(() => undefined),
              controller.signal,
              timeoutMs,
            );
            if (!this.#owns(object.id, ownership, generation)) return undefined;
            controller.signal.throwIfAborted();
            if (!host.update(title.localTimeUs, frame.variables))
              throw new Error(`HTML scene ${object.id} is suspended`);
            const captured = await waitForCapture(
              host.capture(width, height, timeoutMs, undefined, false, frame.paint),
              controller.signal,
              timeoutMs,
            );
            if (!this.#owns(object.id, ownership, generation)) return undefined;
            return captured;
          });
          if (bitmap === undefined) continue;
          controller.signal.throwIfAborted();
          if (!this.#owns(object.id, ownership, generation)) continue;
          if (
            bitmap.width !== width ||
            bitmap.height !== height ||
            bitmap.data.byteLength !== width * height * 4
          )
            throw new Error(
              `HTML scene ${object.id} returned an invalid target-resolution surface`,
            );
          result.set(object.id, bitmap);
          this.#bitmaps.set(object.id, bitmap);
          continue;
        }
        const scene = packageId === undefined ? undefined : findFirstPartyScene(packageId);
        if (scene === undefined || packageId === undefined)
          throw new Error(`HTML scene ${object.id} has no available scene package`);
        const viewport = viewportForScene(packageId);
        const ownership = this.#acquireHost(
          object.id,
          `${packageId}:${viewport.width}x${viewport.height}:no-fonts`,
          () => createScenePreviewHost({ instanceId: `export-${object.id}`, scene }),
        );
        const bitmap = await this.#withHost(ownership, async (host) => {
          await waitForCapture(host.ready, controller.signal, timeoutMs);
          if (!this.#owns(object.id, ownership, generation)) return undefined;
          controller.signal.throwIfAborted();
          if (!host.update(timeUs, defaultVariablesForScene(packageId)))
            throw new Error(`HTML scene ${object.id} is suspended`);
          const captured = await waitForCapture(
            host.capture(width, height, timeoutMs),
            controller.signal,
            timeoutMs,
          );
          if (!this.#owns(object.id, ownership, generation)) return undefined;
          return captured;
        });
        if (bitmap === undefined) continue;
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
      this.#captureDone = undefined;
      finishCapture();
    }
  }

  destroy(): void {
    this.#activeCapture?.abort();
    this.#generation += 1;
    for (const [id, ownership] of this.#hosts) this.#retireHost(id, ownership);
    this.#hosts.clear();
    this.#bitmaps.clear();
  }
}
