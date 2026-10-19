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
  type ScenePaintLine,
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

function paintLines(
  title: TitleInstanceV1,
  timeUs: number,
  durationUs: number,
): readonly ScenePaintLine[] {
  const primary = title.layout.primaryLines;
  const secondary = title.layout.secondaryLines;
  const fadeIn =
    title.motion.presetId === 'hold' || title.motion.inUs <= 0
      ? 1
      : Math.min(1, timeUs / title.motion.inUs);
  const exitStart = durationUs - title.motion.outUs;
  const opacity = Math.max(
    0,
    Math.min(
      1,
      fadeIn *
        (title.motion.outUs <= 0 || timeUs <= exitStart
          ? 1
          : 1 - (timeUs - exitStart) / title.motion.outUs),
    ),
  );
  const rows = [
    ...primary.map((text) => ({
      text,
      size: title.layout.fontSizePx,
      height: title.layout.lineHeightPx,
    })),
    ...secondary.map((text) => ({
      text,
      size: title.layout.secondarySizePx,
      height: Math.round(title.layout.secondarySizePx * 1.25),
    })),
  ];
  let y = title.placement.yPx + (title.motion.presetId === 'joy-slide-up' ? 80 * (1 - fadeIn) : 0);
  return rows.map((row) => {
    const line: ScenePaintLine = {
      text: row.text,
      x: title.placement.xPx,
      y: y + row.height,
      height: row.height,
      font: `${title.font.weight} ${row.size}px "Noto Sans Arabic"`,
      color: '#ffffff',
      direction: title.direction === 'rtl' ? 'rtl' : 'ltr',
      align:
        title.templateId === 'joy.p0.title'
          ? 'center'
          : title.direction === 'rtl'
            ? 'right'
            : 'left',
      opacity,
    };
    y += row.height;
    return line;
  });
}

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
    input: Readonly<Record<string, VisualObjectV1>> | HtmlSceneProjectContext,
    timeUs: number,
  ): Promise<HtmlSceneBitmapMap> {
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

    for (const [id, host] of this.#hosts) {
      if (!liveIds.has(id)) {
        host.destroy();
        this.#hosts.delete(id);
        this.#bitmaps.delete(id);
      }
    }

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
            const frame = buildTitleSceneFrame(
              title.instance,
              title.instanceId,
              title.durationUs,
              title.localTimeUs,
              {
                widthPx: composition.width,
                heightPx: composition.height,
                frameRate: composition.frameRate,
                locale: context?.visual.settings.defaultLocale ?? 'en',
              },
            );
            let host = this.#hosts.get(object.id);
            if (host === undefined) {
              host = createScenePreviewHost({
                instanceId: object.id,
                scene: p0Scene(packageId, composition.width, composition.height) as never,
                fontFaces: await p0TitleFontFaces(),
              });
              this.#hosts.set(object.id, host);
            }
            await host.ready;
            if (generation !== this.#generation) return;
            await document.fonts.ready;
            host.update(title.localTimeUs, frame.variables);
            const bitmap = await host.capture(
              Math.max(1, Math.round(composition.width / 4)),
              Math.max(1, Math.round(composition.height / 4)),
              2_500,
              paintLines(title.instance, title.localTimeUs, title.durationUs),
            );
            if (generation === this.#generation) this.#bitmaps.set(object.id, bitmap);
            return;
          }
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
    const abort = () => this.destroy();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    this.#generation += 1;
    // Release the previous frame before allocating this frame's surfaces.
    this.#bitmaps.clear();
    const liveIds = new Set(liveScenes.map((object) => object.id));
    for (const [id, host] of this.#hosts) {
      if (!liveIds.has(id)) {
        host.destroy();
        this.#hosts.delete(id);
        this.#bitmaps.delete(id);
      }
    }
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
          const frame = buildTitleSceneFrame(
            title.instance,
            title.instanceId,
            title.durationUs,
            title.localTimeUs,
            {
              widthPx: composition.width,
              heightPx: composition.height,
              frameRate: composition.frameRate,
              locale: context?.visual.settings.defaultLocale ?? 'en',
            },
          );
          let host = this.#hosts.get(object.id);
          if (host === undefined) {
            host = createScenePreviewHost({
              instanceId: `export-${object.id}`,
              scene: p0Scene(packageId, composition.width, composition.height) as never,
              fontFaces: await p0TitleFontFaces(),
            });
            this.#hosts.set(object.id, host);
          }
          await waitForCapture(host.ready, controller.signal, timeoutMs);
          await waitForCapture(
            document.fonts.ready.then(() => undefined),
            controller.signal,
            timeoutMs,
          );
          controller.signal.throwIfAborted();
          if (!host.update(title.localTimeUs, frame.variables))
            throw new Error(`HTML scene ${object.id} is suspended`);
          const bitmap = await waitForCapture(
            host.capture(
              width,
              height,
              timeoutMs,
              paintLines(title.instance, title.localTimeUs, title.durationUs),
            ),
            controller.signal,
            timeoutMs,
          );
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
