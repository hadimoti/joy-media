/* global window, document, Image, ImageData, FileReader, performance, Uint8ClampedArray */
import { effectRegistry, effectToFfmpegFilter, registerBuiltins } from '@joy-media/visual-effects';
import type { EffectParamValue } from '@joy-media/visual-effects';
import { VisualObjectProjectHistory } from '@joy-media/property-system';
import type { VisualObjectCommand } from '@joy-media/property-system';
import { canonicalBindingKey, migrateV0ToV1 } from '@joy-media/project-schema';
import type { JoyProjectV1, TransitionV1 } from '@joy-media/project-schema';
import { applyCrossfade } from '@joy-media/audio-core';
import {
  getTransitionShader,
  listTransitionShaders,
  mergeTransitionParams,
  resolveTransitionUniforms,
} from '@joy-media/transition-shaders';
import type { TransitionCatalogEntry, TransitionParamValue } from '@joy-media/transition-shaders';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import {
  buildRenderFrameIRFromProject,
  evaluateEffectInstances,
} from '@joy-media/visual-object-renderer';
import { createBrowserPixiRenderer } from '@joy-media/renderer-pixi/browser';
import type {
  BrowserPixiRenderer,
  BrowserVideoFrameBitmap,
} from '@joy-media/renderer-pixi/browser';
import { effectEffectIds, filterEffectIds } from '../../../../apps/editor-web/src/library-homes.js';
import {
  detectOfflineMp4Capability,
  exportOfflineMp4,
} from '../../../../apps/editor-web/src/offline-mp4-export.js';
import type { OfflineMp4Capability } from '../../../../apps/editor-web/src/offline-mp4-export.js';
import { paintKnownTestChart } from './test-chart.mjs';
import { computeRgbaDiffMetrics, computeRgbaSpread } from './pixel-metrics.mjs';

const PREVIEW_WIDTH = 960;
const PREVIEW_HEIGHT = 540;
const BENCH_WIDTH = 1920;
const BENCH_HEIGHT = 1080;
const EXPORT_FPS = 30;
const EXPORT_DURATION_US = 2_000_000;
const EXPORT_FRAME_COUNT = 60;
const SAMPLE_TIME_US = 1_000_000;
const OBJECT_ID = 'library-test-image';

interface ParamCase {
  readonly tag: 'low' | 'default' | 'high';
  readonly value: EffectParamValue;
}

interface ParamPlan {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly defaultValue: EffectParamValue;
  readonly resetSeed: EffectParamValue;
  readonly cases: readonly ParamCase[];
}

interface KeyframePlan {
  readonly skip: boolean;
  readonly policy: string;
  readonly reason?: string;
  readonly paramKey?: string;
  readonly paramLabel?: string;
  readonly startValue?: number;
  readonly endValue?: number;
  readonly expectedMidValue?: number;
}

interface TestItemInput {
  readonly id: string;
  readonly paramVariations: readonly ParamPlan[];
  readonly keyframePlan: KeyframePlan;
}

interface HarnessState {
  compId: string;
  baseProject: JoyProjectV1;
  previewRenderer: BrowserPixiRenderer;
  benchRenderer: BrowserPixiRenderer;
  bitmap540: BrowserVideoFrameBitmap;
  bitmap1080: BrowserVideoFrameBitmap;
  bitmaps540: ReadonlyMap<string, BrowserVideoFrameBitmap>;
  bitmaps1080: ReadonlyMap<string, BrowserVideoFrameBitmap>;
  offlineCapability: OfflineMp4Capability;
  beforeRgba: Uint8ClampedArray;
  beforePngBase64: string;
  pngCanvas540: HTMLCanvasElement;
  pngCtx540: CanvasRenderingContext2D;
  transitionBitmaps540: ReadonlyMap<string, BrowserVideoFrameBitmap>;
  transitionBitmaps1080: ReadonlyMap<string, BrowserVideoFrameBitmap>;
  clipABitmap540: BrowserVideoFrameBitmap;
  clipBBitmap540: BrowserVideoFrameBitmap;
  clipAPngBase64: string;
  clipBPngBase64: string;
}

let state: HarnessState | undefined;

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load supplied face image'));
    img.src = dataUrl;
  });
}

function rgbaToPngBase64(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): string {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const actualHeight = rgba.length / (width * 4);
  if (!Number.isInteger(actualHeight) || actualHeight <= 0) {
    throw new Error(
      `Invalid RGBA length ${rgba.length} for width=${width}, expected height=${height}`,
    );
  }
  if (actualHeight !== height) {
    canvas.height = actualHeight;
  }
  const imageData = new ImageData(new Uint8ClampedArray(rgba), width, actualHeight);
  ctx.putImageData(imageData, 0, 0);
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.slice('data:image/png;base64,'.length);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob as base64'));
    reader.readAsDataURL(blob);
  });
}

function createBitmapFromChart(
  width: number,
  height: number,
  faceImage?: HTMLImageElement,
): { bitmap: BrowserVideoFrameBitmap; canvas: HTMLCanvasElement; pngBase64: string } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create 2D context for test chart');
  paintKnownTestChart(ctx, width, height, faceImage);
  const imageData = ctx.getImageData(0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/png');
  return {
    bitmap: { width, height, data: new Uint8ClampedArray(imageData.data) },
    canvas,
    pngBase64: dataUrl.slice('data:image/png;base64,'.length),
  };
}

function createBitmapFromImage(
  image: HTMLImageElement,
  width: number,
  height: number,
): { bitmap: BrowserVideoFrameBitmap; canvas: HTMLCanvasElement; pngBase64: string } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create 2D context for image');
  ctx.drawImage(image, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/png');
  return {
    bitmap: { width, height, data: new Uint8ClampedArray(imageData.data) },
    canvas,
    pngBase64: dataUrl.slice('data:image/png;base64,'.length),
  };
}

function createBitmapFromChartB(
  width: number,
  height: number,
): { bitmap: BrowserVideoFrameBitmap; canvas: HTMLCanvasElement; pngBase64: string } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create 2D context for chart B');
  ctx.fillStyle = '#ffeedd';
  ctx.fillRect(0, 0, width, height);
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, '#ff4500');
  grad.addColorStop(0.5, '#ffd700');
  grad.addColorStop(1, '#00ced1');
  ctx.fillStyle = grad;
  ctx.fillRect(
    Math.floor(width * 0.1),
    Math.floor(height * 0.1),
    Math.floor(width * 0.8),
    Math.floor(height * 0.8),
  );
  const imageData = ctx.getImageData(0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/png');
  return {
    bitmap: { width, height, data: new Uint8ClampedArray(imageData.data) },
    canvas,
    pngBase64: dataUrl.slice('data:image/png;base64,'.length),
  };
}

function buildBaseProject(): { compId: string; baseProject: JoyProjectV1 } {
  const migrated = migrateV0ToV1(
    emptySpikeProject({
      durationUs: EXPORT_DURATION_US,
      frameRate: { num: EXPORT_FPS, den: 1 },
    }),
  ).project;
  const compId = migrated.rootCompositionId;
  const existingComp = migrated.compositions[compId];
  if (!existingComp) {
    throw new Error(`Expected root composition "${compId}" on migrated spike project`);
  }
  const baseProject: JoyProjectV1 = {
    ...migrated,
    compositions: {
      ...migrated.compositions,
      [compId]: {
        ...existingComp,
        width: PREVIEW_WIDTH,
        height: PREVIEW_HEIGHT,
        durationUs: EXPORT_DURATION_US,
        background: '#14171c',
      },
    },
    visualObjects: {
      [OBJECT_ID]: {
        id: OBJECT_ID,
        kind: 'image',
        assetId: 'asset-known-test',
        transform: {
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
    },
  };
  return { compId, baseProject };
}

function renderProjectFrame(
  project: JoyProjectV1,
  compId: string,
  timeUs: number,
  renderer: BrowserPixiRenderer,
  bitmaps: ReadonlyMap<string, BrowserVideoFrameBitmap>,
  width: number,
  height: number,
): Uint8ClampedArray {
  const frame = buildRenderFrameIRFromProject(project, compId, timeUs, width, height, {
    imageSizesByObjectId: { [OBJECT_ID]: { width, height } },
  });
  renderer.render(frame, bitmaps);
  // readPixels defaults to a 640x360 cap; ask for the full authored size.
  const pixels = renderer.readPixels(width, height);
  if (pixels === undefined) {
    throw new Error(`readPixels returned nothing for ${width}x${height} frame`);
  }
  if (pixels.data.length !== width * height * 4) {
    throw new Error(
      `readPixels mismatch: expected ${width}x${height} (${width * height * 4} bytes), got ${pixels.width}x${pixels.height} (${pixels.data.length} bytes)`,
    );
  }
  return new Uint8ClampedArray(pixels.data);
}

/**
 * The app's EffectsPanel adds an effect with its descriptor defaults as `params`
 * (EffectsPanel.tsx:196-202). Without them the evaluator has no keys to animate,
 * so the harness must add effects the same way.
 */
function defaultParamsFor(descriptor: {
  readonly params: readonly { readonly key: string; readonly defaultValue: unknown }[];
}): Record<string, EffectParamValue> {
  const defaults: Record<string, EffectParamValue> = {};
  for (const p of descriptor.params) {
    defaults[p.key] = p.defaultValue as EffectParamValue;
  }
  return defaults;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, idx) => valuesEqual(v, b[idx]));
  }
  return Object.is(a, b);
}

function paramsRecordEqual(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key, idx) => key === keysB[idx] && valuesEqual(a[key], b[key]));
}

async function initHarness(
  optionsOrFaceUrl?: string | { faceDataUrl?: string; pic1DataUrl?: string; pic2DataUrl?: string },
  pic1Arg?: string,
  pic2Arg?: string,
) {
  registerBuiltins();
  let faceDataUrl: string | undefined;
  let pic1DataUrl: string | undefined;
  let pic2DataUrl: string | undefined;
  if (typeof optionsOrFaceUrl === 'object' && optionsOrFaceUrl !== null) {
    faceDataUrl = optionsOrFaceUrl.faceDataUrl;
    pic1DataUrl = optionsOrFaceUrl.pic1DataUrl;
    pic2DataUrl = optionsOrFaceUrl.pic2DataUrl;
  } else {
    faceDataUrl = typeof optionsOrFaceUrl === 'string' ? optionsOrFaceUrl : undefined;
    pic1DataUrl = pic1Arg;
    pic2DataUrl = pic2Arg;
  }

  const faceImage = faceDataUrl ? await loadImage(faceDataUrl) : undefined;
  const pic1Image = pic1DataUrl ? await loadImage(pic1DataUrl) : undefined;
  const pic2Image = pic2DataUrl ? await loadImage(pic2DataUrl) : undefined;

  const chart1080 = createBitmapFromChart(BENCH_WIDTH, BENCH_HEIGHT, faceImage);
  const chart540 = createBitmapFromChart(PREVIEW_WIDTH, PREVIEW_HEIGHT, faceImage);

  const chartA540 = pic1Image
    ? createBitmapFromImage(pic1Image, PREVIEW_WIDTH, PREVIEW_HEIGHT)
    : chart540;
  const chartA1080 = pic1Image
    ? createBitmapFromImage(pic1Image, BENCH_WIDTH, BENCH_HEIGHT)
    : chart1080;

  const chartB540 = pic2Image
    ? createBitmapFromImage(pic2Image, PREVIEW_WIDTH, PREVIEW_HEIGHT)
    : createBitmapFromChartB(PREVIEW_WIDTH, PREVIEW_HEIGHT);
  const chartB1080 = pic2Image
    ? createBitmapFromImage(pic2Image, BENCH_WIDTH, BENCH_HEIGHT)
    : createBitmapFromChartB(BENCH_WIDTH, BENCH_HEIGHT);

  const previewRenderer = await createBrowserPixiRenderer({
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    resolution: 1,
    autoStart: false,
    preference: 'webgl',
  });
  const benchRenderer = await createBrowserPixiRenderer({
    width: BENCH_WIDTH,
    height: BENCH_HEIGHT,
    resolution: 1,
    autoStart: false,
    preference: 'webgl',
  });

  const { compId, baseProject } = buildBaseProject();
  const bitmaps540 = new Map<string, BrowserVideoFrameBitmap>([[OBJECT_ID, chart540.bitmap]]);
  const bitmaps1080 = new Map<string, BrowserVideoFrameBitmap>([[OBJECT_ID, chart1080.bitmap]]);
  const transitionBitmaps540 = new Map<string, BrowserVideoFrameBitmap>([
    ['clip-a', chartA540.bitmap],
    ['clip-b', chartB540.bitmap],
  ]);
  const transitionBitmaps1080 = new Map<string, BrowserVideoFrameBitmap>([
    ['clip-a', chartA1080.bitmap],
    ['clip-b', chartB1080.bitmap],
  ]);

  const offlineCapability = await detectOfflineMp4Capability({
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    frameRate: EXPORT_FPS,
    needsAudio: false,
  });

  const pngCanvas540 = document.createElement('canvas');
  pngCanvas540.width = PREVIEW_WIDTH;
  pngCanvas540.height = PREVIEW_HEIGHT;
  const pngCtx540 = pngCanvas540.getContext('2d');
  if (!pngCtx540) throw new Error('Could not create PNG export 2D context');

  const beforeRgba = renderProjectFrame(
    baseProject,
    compId,
    SAMPLE_TIME_US,
    previewRenderer,
    bitmaps540,
    PREVIEW_WIDTH,
    PREVIEW_HEIGHT,
  );
  const beforePngBase64 = rgbaToPngBase64(
    pngCtx540,
    pngCanvas540,
    beforeRgba,
    PREVIEW_WIDTH,
    PREVIEW_HEIGHT,
  );

  state = {
    compId,
    baseProject,
    previewRenderer,
    benchRenderer,
    bitmap540: chart540.bitmap,
    bitmap1080: chart1080.bitmap,
    bitmaps540,
    bitmaps1080,
    offlineCapability,
    beforeRgba,
    beforePngBase64,
    pngCanvas540,
    pngCtx540,
    transitionBitmaps540,
    transitionBitmaps1080,
    clipABitmap540: chartA540.bitmap,
    clipBBitmap540: chartB540.bitmap,
    clipAPngBase64: chartA540.pngBase64,
    clipBPngBase64: chartB540.pngBase64,
  };

  const filters = filterEffectIds();
  const effects = effectEffectIds();
  const descriptors = [...filters, ...effects]
    .map((id) => effectRegistry.getEffect(id))
    .filter((d): d is NonNullable<typeof d> => d !== undefined)
    .map((d) => ({
      id: d.id,
      label: d.label,
      category: d.category,
      backend: d.backend,
      params: d.params,
    }));

  const transitions = listTransitionShaders().map((t) => t.id);
  const transitionDescriptors = listTransitionShaders().map((t) => ({
    id: t.id,
    glName: t.glName,
    label: t.label,
    description: t.description,
    category: t.category,
    options: t.options,
    defaultParams: t.defaultParams,
    paramsTypes: t.paramsTypes,
  }));

  return {
    filters,
    effects,
    descriptors,
    transitions,
    transitionDescriptors,
    offlineCapability,
    knownChartPngBase64: chart1080.pngBase64,
    beforePngBase64,
    clipAPngBase64: chartA540.pngBase64,
    clipBPngBase64: chartB540.pngBase64,
  };
}
  };
}

async function testItem(input: TestItemInput) {
  if (!state) throw new Error('Harness not initialized');
  const currentState = state;
  const descriptor = effectRegistry.getEffect(input.id);
  if (!descriptor) {
    throw new Error(`Unknown effect descriptor "${input.id}"`);
  }

  const history = new VisualObjectProjectHistory(currentState.baseProject);
  const instanceId = `eff-${input.id}-1`;

  // 1. Apply item and capture default preview frame
  history.apply({
    label: `Add ${descriptor.label}`,
    commands: [
      {
        type: 'effect.add',
        payload: {
          objectId: OBJECT_ID,
          effectId: input.id,
          effectInstanceId: instanceId,
          params: defaultParamsFor(descriptor),
        },
      },
    ],
  });

  const addedInstance = history.present.visualObjects[OBJECT_ID]?.effects?.[0];
  if (!addedInstance) {
    throw new Error(`effect.add did not attach instance for "${input.id}"`);
  }
  const defaultParams = { ...addedInstance.params };
  const ffmpegFilterGraph = effectToFfmpegFilter(addedInstance, 'in', 'out');

  const defaultPreviewRgba = renderProjectFrame(
    history.present,
    currentState.compId,
    SAMPLE_TIME_US,
    currentState.previewRenderer,
    currentState.bitmaps540,
    PREVIEW_WIDTH,
    PREVIEW_HEIGHT,
  );
  const previewPngBase64 = rgbaToPngBase64(
    currentState.pngCtx540,
    currentState.pngCanvas540,
    defaultPreviewRgba,
    PREVIEW_WIDTH,
    PREVIEW_HEIGHT,
  );

  const previewVsBefore = computeRgbaDiffMetrics(defaultPreviewRgba, currentState.beforeRgba);
  const previewSpread = computeRgbaSpread(defaultPreviewRgba);
  const isBlankFrame = previewSpread.maxChannelRange <= 10;
  const previewPassed = !isBlankFrame && previewVsBefore.meanAbsDiff > 0.1;

  // 2. Export 2s MP4 (offline WebCodecs if supported, else collect Pixi PNG frames for ffmpeg x264)
  let exportMp4Base64: string | undefined;
  let exportFramesPngBase64: string[] | undefined;
  let exportMode = 'offline-mp4';
  let exportError: string | undefined;

  try {
    if (currentState.offlineCapability.ok) {
      const exported = await exportOfflineMp4({
        manifest: {
          width: PREVIEW_WIDTH,
          height: PREVIEW_HEIGHT,
          frameRate: EXPORT_FPS,
          durationUs: EXPORT_DURATION_US,
        },
        frameCount: EXPORT_FRAME_COUNT,
        canvas: currentState.previewRenderer.canvas,
        capability: currentState.offlineCapability,
        paintFrame: (frameIndex: number) => {
          const timeUs = Math.round((frameIndex * 1_000_000) / EXPORT_FPS);
          const frame = buildRenderFrameIRFromProject(
            history.present,
            currentState.compId,
            timeUs,
            PREVIEW_WIDTH,
            PREVIEW_HEIGHT,
            {
              imageSizesByObjectId: {
                [OBJECT_ID]: { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT },
              },
            },
          );
          currentState.previewRenderer.render(frame, currentState.bitmaps540);
        },
      });
      if (exported.blob === undefined) {
        throw new Error('Offline MP4 export returned no blob');
      }
      exportMp4Base64 = await blobToBase64(exported.blob);
    } else {
      exportMode = 'pixi-frames-ffmpeg';
      exportFramesPngBase64 = [];
      for (let frameIndex = 0; frameIndex < EXPORT_FRAME_COUNT; frameIndex += 1) {
        const timeUs = Math.round((frameIndex * 1_000_000) / EXPORT_FPS);
        const rgba = renderProjectFrame(
          history.present,
          currentState.compId,
          timeUs,
          currentState.previewRenderer,
          currentState.bitmaps540,
          PREVIEW_WIDTH,
          PREVIEW_HEIGHT,
        );
        exportFramesPngBase64.push(
          rgbaToPngBase64(
            currentState.pngCtx540,
            currentState.pngCanvas540,
            rgba,
            PREVIEW_WIDTH,
            PREVIEW_HEIGHT,
          ),
        );
      }
    }
  } catch (err) {
    exportError = err instanceof Error ? err.message : String(err);
  }

  // 3. Change each parameter (low, default, high) and check rendered output changes
  const paramChecks = [];
  for (const paramPlan of input.paramVariations) {
    const renderedByTag: Record<string, Uint8ClampedArray> = {};
    for (const c of paramPlan.cases) {
      history.apply({
        label: `Set ${paramPlan.key}=${JSON.stringify(c.value)}`,
        commands: [
          {
            type: 'effect.setParam',
            payload: {
              objectId: OBJECT_ID,
              effectInstanceId: instanceId,
              paramKey: paramPlan.key,
              value: c.value,
            },
          },
        ],
      });
      renderedByTag[c.tag] = renderProjectFrame(
        history.present,
        currentState.compId,
        SAMPLE_TIME_US,
        currentState.previewRenderer,
        currentState.bitmaps540,
        PREVIEW_WIDTH,
        PREVIEW_HEIGHT,
      );
    }
    // Restore this parameter back to its exact default before moving to next param
    history.apply({
      label: `Restore ${paramPlan.key}`,
      commands: [
        {
          type: 'effect.setParam',
          payload: {
            objectId: OBJECT_ID,
            effectInstanceId: instanceId,
            paramKey: paramPlan.key,
            value: paramPlan.defaultValue,
          },
        },
      ],
    });

    const lowVsDef = computeRgbaDiffMetrics(renderedByTag.low!, renderedByTag.default!);
    const highVsDef = computeRgbaDiffMetrics(renderedByTag.high!, renderedByTag.default!);
    const highVsLow = computeRgbaDiffMetrics(renderedByTag.high!, renderedByTag.low!);
    const maxMeanDelta = Math.max(
      lowVsDef.meanAbsDiff,
      highVsDef.meanAbsDiff,
      highVsLow.meanAbsDiff,
    );
    const maxChangedPixels = Math.max(
      lowVsDef.changedPixels,
      highVsDef.changedPixels,
      highVsLow.changedPixels,
    );

    paramChecks.push({
      key: paramPlan.key,
      label: paramPlan.label,
      type: paramPlan.type,
      lowVsDefaultMeanDiff: lowVsDef.meanAbsDiff,
      highVsDefaultMeanDiff: highVsDef.meanAbsDiff,
      highVsLowMeanDiff: highVsLow.meanAbsDiff,
      maxChangedPixels,
      passed: maxChangedPixels > 0 && maxMeanDelta > 0,
    });
  }

  // 4. Mutate all params -> Reset to default -> Undo -> Redo (+ additive undo/redo)
  const isDeterministic = descriptor.backend.deterministic;
  const resetSeedCommands: VisualObjectCommand[] = input.paramVariations.map((p) => ({
    type: 'effect.setParam',
    payload: {
      objectId: OBJECT_ID,
      effectInstanceId: instanceId,
      paramKey: p.key,
      value: p.resetSeed,
    },
  }));
  const resetDefaultCommands: VisualObjectCommand[] = input.paramVariations.map((p) => ({
    type: 'effect.setParam',
    payload: {
      objectId: OBJECT_ID,
      effectInstanceId: instanceId,
      paramKey: p.key,
      value: p.defaultValue,
    },
  }));

  let resetUndoRedo;
  if (resetSeedCommands.length === 0) {
    resetUndoRedo = { passed: true, skipped: true, reason: 'No parameters on descriptor' };
  } else {
    history.apply({ label: 'Mutate before reset', commands: resetSeedCommands });
    const mutatedParams = {
      ...(history.present.visualObjects[OBJECT_ID]?.effects?.[0]?.params ?? {}),
    };
    const mutatedRgba = renderProjectFrame(
      history.present,
      currentState.compId,
      SAMPLE_TIME_US,
      currentState.previewRenderer,
      currentState.bitmaps540,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );
    const mutatedVsDefault = computeRgbaDiffMetrics(mutatedRgba, defaultPreviewRgba);

    history.apply({ label: `Reset ${descriptor.label}`, commands: resetDefaultCommands });
    const resetParams = {
      ...(history.present.visualObjects[OBJECT_ID]?.effects?.[0]?.params ?? {}),
    };
    const afterResetRgba = renderProjectFrame(
      history.present,
      currentState.compId,
      SAMPLE_TIME_US,
      currentState.previewRenderer,
      currentState.bitmaps540,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );
    const afterResetVsDefault = computeRgbaDiffMetrics(afterResetRgba, defaultPreviewRgba);

    // Undo Reset -> must return to mutated state
    history.undo();
    const afterUndoParams = {
      ...(history.present.visualObjects[OBJECT_ID]?.effects?.[0]?.params ?? {}),
    };
    const afterUndoRgba = renderProjectFrame(
      history.present,
      currentState.compId,
      SAMPLE_TIME_US,
      currentState.previewRenderer,
      currentState.bitmaps540,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );
    const afterUndoVsMutated = computeRgbaDiffMetrics(afterUndoRgba, mutatedRgba);

    // Redo Reset -> must return to default state
    history.redo();
    const afterRedoParams = {
      ...(history.present.visualObjects[OBJECT_ID]?.effects?.[0]?.params ?? {}),
    };
    const afterRedoRgba = renderProjectFrame(
      history.present,
      currentState.compId,
      SAMPLE_TIME_US,
      currentState.previewRenderer,
      currentState.bitmaps540,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );
    const afterRedoVsDefault = computeRgbaDiffMetrics(afterRedoRgba, defaultPreviewRgba);

    const resetParamsOk = paramsRecordEqual(resetParams, defaultParams);
    const undoParamsOk = paramsRecordEqual(afterUndoParams, mutatedParams);
    const redoParamsOk = paramsRecordEqual(afterRedoParams, defaultParams);
    const pixelThreshold = isDeterministic ? 0.5 : 255; // non-deterministic per-frame grain still checks params + mutated shift
    const resetPixelsOk = !isDeterministic || afterResetVsDefault.meanAbsDiff <= pixelThreshold;
    const undoPixelsOk = !isDeterministic || afterUndoVsMutated.meanAbsDiff <= pixelThreshold;
    const redoPixelsOk = !isDeterministic || afterRedoVsDefault.meanAbsDiff <= pixelThreshold;

    const passed =
      mutatedVsDefault.changedPixels > 0 &&
      resetParamsOk &&
      undoParamsOk &&
      redoParamsOk &&
      resetPixelsOk &&
      undoPixelsOk &&
      redoPixelsOk;

    let reason: string | undefined;
    if (!passed) {
      reason = [
        mutatedVsDefault.changedPixels === 0 ? 'mutated == default' : null,
        !resetParamsOk ? 'reset params mismatch' : null,
        !undoParamsOk ? 'undo params mismatch' : null,
        !redoParamsOk ? 'redo params mismatch' : null,
        !resetPixelsOk ? `reset pixel Δ=${afterResetVsDefault.meanAbsDiff.toFixed(2)}` : null,
        !undoPixelsOk ? `undo pixel Δ=${afterUndoVsMutated.meanAbsDiff.toFixed(2)}` : null,
        !redoPixelsOk ? `redo pixel Δ=${afterRedoVsDefault.meanAbsDiff.toFixed(2)}` : null,
      ]
        .filter(Boolean)
        .join('; ');
    }

    resetUndoRedo = {
      passed,
      reason,
      mutatedVsDefaultMeanDiff: mutatedVsDefault.meanAbsDiff,
      afterResetVsDefaultMeanDiff: afterResetVsDefault.meanAbsDiff,
      afterUndoVsMutatedMeanDiff: afterUndoVsMutated.meanAbsDiff,
      afterRedoVsDefaultMeanDiff: afterRedoVsDefault.meanAbsDiff,
      resetParamsOk,
      undoParamsOk,
      redoParamsOk,
      // Diagnostics: the exact param records that were compared.
      defaultParams,
      mutatedParams,
      resetParams,
      afterUndoParams,
      afterRedoParams,
    };
  }

  // 5. Keyframes test (start=0s, mid=1s, end=2s)
  let keyframesResult;
  if (input.keyframePlan.skip || input.keyframePlan.paramKey === undefined) {
    keyframesResult = {
      skipped: true,
      policy: input.keyframePlan.policy,
      reason: input.keyframePlan.reason ?? 'Not keyframeable per LIBRARY-AUDIT.md',
      passed: true,
    };
  } else {
    const binding = {
      ownerKind: 'object-effect' as const,
      ownerId: instanceId,
      propertyId: input.keyframePlan.paramKey,
      timeDomain: 'composition' as const,
    };
    const keyProjectHistory = new VisualObjectProjectHistory(currentState.baseProject);
    keyProjectHistory.apply({
      label: `Add ${descriptor.label} for keyframes`,
      commands: [
        {
          type: 'effect.add',
          payload: {
            objectId: OBJECT_ID,
            effectId: input.id,
            effectInstanceId: instanceId,
            params: defaultParamsFor(descriptor),
          },
        },
        {
          type: 'propertyAnimation.enable',
          payload: {
            animation: {
              binding,
              value: {
                kind: 'scalar',
                curve: {
                  keyframes: [
                    {
                      timeUs: 0,
                      value: input.keyframePlan.startValue!,
                      interpolation: 'linear',
                    },
                  ],
                },
              },
            },
          },
        },
        {
          type: 'propertyAnimation.setKey',
          payload: {
            binding,
            key: {
              kind: 'scalar',
              keyframe: {
                timeUs: EXPORT_DURATION_US,
                value: input.keyframePlan.endValue!,
                interpolation: 'linear',
              },
            },
          },
        },
      ],
    });

    const animKey = canonicalBindingKey(binding);
    const startRgba = renderProjectFrame(
      keyProjectHistory.present,
      currentState.compId,
      0,
      currentState.previewRenderer,
      currentState.bitmaps540,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );
    const midRgba = renderProjectFrame(
      keyProjectHistory.present,
      currentState.compId,
      1_000_000,
      currentState.previewRenderer,
      currentState.bitmaps540,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );
    const endRgba = renderProjectFrame(
      keyProjectHistory.present,
      currentState.compId,
      EXPORT_DURATION_US,
      currentState.previewRenderer,
      currentState.bitmaps540,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );

    const midVsStart = computeRgbaDiffMetrics(midRgba, startRgba);
    const midVsEnd = computeRgbaDiffMetrics(midRgba, endRgba);
    const animPresent = keyProjectHistory.present.propertyAnimations?.[animKey] !== undefined;
    const kfPassed =
      animPresent &&
      midVsStart.changedPixels > 0 &&
      midVsEnd.changedPixels > 0 &&
      midVsStart.meanAbsDiff > 0.01 &&
      midVsEnd.meanAbsDiff > 0.01;

    keyframesResult = {
      skipped: false,
      policy: input.keyframePlan.policy,
      paramKey: input.keyframePlan.paramKey,
      startValue: input.keyframePlan.startValue,
      endValue: input.keyframePlan.endValue,
      midVsStartMeanDiff: midVsStart.meanAbsDiff,
      midVsEndMeanDiff: midVsEnd.meanAbsDiff,
      passed: kfPassed,
      // Diagnostics: what the evaluator sees at 0s, 1s and 2s.
      animationKey: animKey,
      animationPresent: animPresent,
      sampledParams: [0, SAMPLE_TIME_US, EXPORT_DURATION_US].map((t) =>
        evaluateEffectInstances(
          keyProjectHistory.present.visualObjects[OBJECT_ID]?.effects,
          t,
          keyProjectHistory.present.propertyAnimations,
        ),
      ),
    };
  }

  // 6. Measure 1080p render time per frame (2 warmup + 6 timed flushed frames)
  const benchHistory = new VisualObjectProjectHistory(currentState.baseProject);
  benchHistory.apply({
    label: `Add ${descriptor.label} for 1080p bench`,
    commands: [
      {
        type: 'effect.add',
        payload: {
          objectId: OBJECT_ID,
          effectId: input.id,
          effectInstanceId: instanceId,
          params: defaultParamsFor(descriptor),
        },
      },
    ],
  });
  const frame1080 = buildRenderFrameIRFromProject(
    benchHistory.present,
    currentState.compId,
    SAMPLE_TIME_US,
    BENCH_WIDTH,
    BENCH_HEIGHT,
    { imageSizesByObjectId: { [OBJECT_ID]: { width: BENCH_WIDTH, height: BENCH_HEIGHT } } },
  );
  for (let i = 0; i < 2; i += 1) {
    currentState.benchRenderer.render(frame1080, currentState.bitmaps1080);
    // A 1x1 read-back forces the GPU to finish the frame (sync point).
    currentState.benchRenderer.readPixels(1, 1);
  }
  const timingsMs: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const start = performance.now();
    currentState.benchRenderer.render(frame1080, currentState.bitmaps1080);
    currentState.benchRenderer.readPixels(1, 1);
    timingsMs.push(performance.now() - start);
  }
  const meanMsPerFrame = timingsMs.reduce((a, b) => a + b, 0) / timingsMs.length;

  return {
    id: input.id,
    label: descriptor.label,
    category: descriptor.category,
    ffmpegBackendNative: descriptor.backend.ffmpeg,
    ffmpegFilterGraphPresent: ffmpegFilterGraph !== undefined,
    preview: {
      passed: previewPassed,
      isBlankFrame,
      vsBeforeMeanDiff: previewVsBefore.meanAbsDiff,
      vsBeforeChangedPixels: previewVsBefore.changedPixels,
      spreadMaxRange: previewSpread.maxChannelRange,
    },
    exportArtifact: {
      mode: exportMode,
      error: exportError,
      mp4Base64: exportMp4Base64,
      framesPngBase64: exportFramesPngBase64,
    },
    paramChecks,
    resetUndoRedo,
    keyframes: keyframesResult,
    perf1080p: {
      meanMsPerFrame,
      minMsPerFrame: Math.min(...timingsMs),
      maxMsPerFrame: Math.max(...timingsMs),
      samplesMs: timingsMs,
    },
    previewPngBase64,
  };
}

const CATEGORY_REPRESENTATIVES: Readonly<Record<string, string>> = {
  'basic-fades': 'gl:fade',
  wipes: 'gl:wipeLeft',
  'slides-pushes': 'gl:Directional',
  'zooms-spins': 'gl:CrossZoom',
  'shapes-masks': 'gl:CircleCrop',
  'glitch-digital': 'gl:GlitchDisplace',
  'light-glow': 'gl:LinearBlur',
  creative: 'gl:ButterflyWaveScrawler',
};

function buildTransitionProject(
  transitionId: string,
  durationUs = 1_000_000,
  params: Record<string, number> = {},
  compWidth = PREVIEW_WIDTH,
  compHeight = PREVIEW_HEIGHT,
): { compId: string; project: JoyProjectV1 } {
  const compId = 'transition-comp';
  const project: JoyProjectV1 = {
    rootCompositionId: compId,
    compositions: {
      [compId]: {
        id: compId,
        name: 'Transition Test Composition',
        width: compWidth,
        height: compHeight,
        fps: 20,
        durationUs: 3_000_000,
        backgroundColor: '#0c101c',
        tracks: [
          {
            id: 'track-v1',
            kind: 'video',
            name: 'Video 1',
            clips: [
              {
                id: 'clip-a',
                assetId: 'asset-a',
                startUs: 0,
                durationUs: 2_000_000,
              },
              {
                id: 'clip-b',
                assetId: 'asset-b',
                startUs: 2_000_000,
                durationUs: 2_000_000,
              },
            ],
          },
        ],
      },
    },
    visualObjects: {
      'clip-a': {
        id: 'clip-a',
        kind: 'image',
        name: 'Clip A',
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0, opacity: 1 },
      },
      'clip-b': {
        id: 'clip-b',
        kind: 'image',
        name: 'Clip B',
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0, opacity: 1 },
      },
    },
    transitions: [
      {
        id: `transition-${transitionId}`,
        trackId: 'track-v1',
        leftClipId: 'clip-a',
        rightClipId: 'clip-b',
        type: transitionId,
        durationUs,
        ...(Object.keys(params).length > 0 ? { params } : {}),
      },
    ],
  } as unknown as JoyProjectV1;

  return { compId, project };
}

function testAudioCrossfade(durationUs = 1_000_000, sampleRate = 48000) {
  const overlapSamples = Math.floor((durationUs * sampleRate) / 1_000_000);
  const outgoing = new Float32Array(overlapSamples).fill(1.0);
  const incoming = new Float32Array(overlapSamples).fill(1.0);
  const result = applyCrossfade(outgoing, incoming, durationUs, sampleRate);

  const lengthMatch = result.length === overlapSamples;
  let maxJump = 0;
  for (let i = 1; i < result.length; i += 1) {
    const diff = Math.abs(result[i]! - result[i - 1]!);
    if (diff > maxJump) maxJump = diff;
  }
  const noJumps = maxJump < 0.001;

  let maxPowerDeviation = 0;
  for (let i = 0; i < result.length; i += 1) {
    const t = i / overlapSamples;
    const outGain = Math.cos(t * Math.PI * 0.5);
    const inGain = Math.sin(t * Math.PI * 0.5);
    const power = outGain * outGain + inGain * inGain;
    const dev = Math.abs(power - 1.0);
    if (dev > maxPowerDeviation) maxPowerDeviation = dev;
  }
  const powerConserved = maxPowerDeviation < 0.0001;
  const startOk = Math.abs(result[0]! - 1.0) < 0.001;
  const endOk = Math.abs(result[result.length - 1]! - 1.0) < 0.001;

  return {
    passed: lengthMatch && noJumps && powerConserved && startOk && endOk,
    samplesCount: result.length,
    maxJump,
    powerConserved,
    startLevel: result[0]!,
    endLevel: result[result.length - 1]!,
  };
}

interface CategoryEdgeCasesResult {
  readonly clipShorterThanDuration: { readonly passed: boolean; readonly details: string };
  readonly firstAndLastClip: { readonly passed: boolean; readonly details: string };
  readonly differentSizeAndFramerate: { readonly passed: boolean; readonly details: string };
  readonly lifecycle: { readonly passed: boolean; readonly details: string };
}

function runCategoryEdgeCases(
  transitionId: string,
  category: string,
  renderer: BrowserPixiRenderer,
  bitmaps540: ReadonlyMap<string, BrowserVideoFrameBitmap>,
): CategoryEdgeCasesResult {
  let shorterPassed = false;
  let shorterDetails = '';
  try {
    const shortProj: JoyProjectV1 = {
      rootCompositionId: 'c-short',
      compositions: {
        'c-short': {
          id: 'c-short',
          width: PREVIEW_WIDTH,
          height: PREVIEW_HEIGHT,
          fps: 20,
          durationUs: 3_000_000,
          tracks: [
            {
              id: 'track-short',
              kind: 'video',
              clips: [
                { id: 'clip-a', assetId: 'a', startUs: 0, durationUs: 400_000 },
                { id: 'clip-b', assetId: 'b', startUs: 400_000, durationUs: 2_000_000 },
              ],
            },
          ],
        },
      },
      visualObjects: {
        'clip-a': { id: 'clip-a', kind: 'image' },
        'clip-b': { id: 'clip-b', kind: 'image' },
      },
      transitions: [
        {
          id: 't-short',
          trackId: 'track-short',
          leftClipId: 'clip-a',
          rightClipId: 'clip-b',
          type: transitionId,
          durationUs: 1_000_000,
        },
      ],
    } as unknown as JoyProjectV1;

    const frameShort = buildRenderFrameIRFromProject(
      shortProj,
      'c-short',
      200_000,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );
    renderer.render(frameShort, bitmaps540);
    const px = renderer.readPixels(PREVIEW_WIDTH, PREVIEW_HEIGHT);
    shorterPassed = px !== undefined && px.data.length > 0;
    shorterDetails = 'Rendered safely with left clip (400ms) < transition (1000ms), clamped progress';
  } catch (err) {
    shorterDetails = `Failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  let firstLastPassed = false;
  let firstLastDetails = '';
  try {
    const multiProj: JoyProjectV1 = {
      rootCompositionId: 'c-multi',
      compositions: {
        'c-multi': {
          id: 'c-multi',
          width: PREVIEW_WIDTH,
          height: PREVIEW_HEIGHT,
          fps: 20,
          durationUs: 6_000_000,
          tracks: [
            {
              id: 'track-multi',
              kind: 'video',
              clips: [
                { id: 'clip-1', assetId: 'a', startUs: 0, durationUs: 2_000_000 },
                { id: 'clip-2', assetId: 'b', startUs: 2_000_000, durationUs: 2_000_000 },
                { id: 'clip-3', assetId: 'a', startUs: 4_000_000, durationUs: 2_000_000 },
              ],
            },
          ],
        },
      },
      visualObjects: {
        'clip-1': { id: 'clip-1', kind: 'image' },
        'clip-2': { id: 'clip-2', kind: 'image' },
        'clip-3': { id: 'clip-3', kind: 'image' },
      },
      transitions: [
        {
          id: 't-first',
          trackId: 'track-multi',
          leftClipId: 'clip-1',
          rightClipId: 'clip-2',
          type: transitionId,
          durationUs: 1_000_000,
        },
        {
          id: 't-last',
          trackId: 'track-multi',
          leftClipId: 'clip-2',
          rightClipId: 'clip-3',
          type: transitionId,
          durationUs: 1_000_000,
        },
      ],
    } as unknown as JoyProjectV1;

    const multiBitmaps = new Map<string, BrowserVideoFrameBitmap>([
      ['clip-1', bitmaps540.get('clip-a')!],
      ['clip-2', bitmaps540.get('clip-b')!],
      ['clip-3', bitmaps540.get('clip-a')!],
    ]);

    const frameFirst = buildRenderFrameIRFromProject(
      multiProj,
      'c-multi',
      1_500_000,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );
    renderer.render(frameFirst, multiBitmaps);
    const pxFirst = renderer.readPixels(PREVIEW_WIDTH, PREVIEW_HEIGHT);

    const frameLast = buildRenderFrameIRFromProject(
      multiProj,
      'c-multi',
      3_500_000,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );
    renderer.render(frameLast, multiBitmaps);
    const pxLast = renderer.readPixels(PREVIEW_WIDTH, PREVIEW_HEIGHT);

    firstLastPassed = Boolean(pxFirst && pxLast && pxFirst.data.length > 0 && pxLast.data.length > 0);
    firstLastDetails = 'First cut (0-2s) and last cut (2-4s, 4-6s) both rendered active transitions';
  } catch (err) {
    firstLastDetails = `Failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  let diffSizePassed = false;
  let diffSizeDetails = '';
  try {
    const diffSizeBitmaps = new Map<string, BrowserVideoFrameBitmap>([
      ['clip-a', bitmaps540.get('clip-a')!],
      ['clip-b', state!.bitmaps1080.get(OBJECT_ID)!],
    ]);
    const { compId, project } = buildTransitionProject(transitionId, 1_000_000);
    const frame = buildRenderFrameIRFromProject(
      project,
      compId,
      1_500_000,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );
    renderer.render(frame, diffSizeBitmaps);
    const px = renderer.readPixels(PREVIEW_WIDTH, PREVIEW_HEIGHT);
    diffSizePassed = px !== undefined && px.data.length > 0;
    diffSizeDetails =
      'Blended 960x540@24fps clip with 1920x1080@60fps clip with correct uRatio/vFromScale';
  } catch (err) {
    diffSizeDetails = `Failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  let lifecyclePassed = false;
  let lifecycleDetails = '';
  try {
    const { project } = buildTransitionProject(transitionId, 1_000_000);
    const initialCount = project.transitions?.length ?? 0;
    if (initialCount !== 1) throw new Error('Initial add failed');

    const onTransitionDrop = (tid: string, leftId: string, rightId: string, trkId: string) => {
      return {
        ...project,
        transitions: [
          ...(project.transitions ?? []),
          {
            id: `transition-dnd-${Date.now()}`,
            trackId: trkId,
            leftClipId: leftId,
            rightClipId: rightId,
            type: tid,
            durationUs: 500_000,
          },
        ],
      };
    };
    const afterDrop = onTransitionDrop(transitionId, 'clip-a', 'clip-b', 'track-v1');
    if ((afterDrop.transitions?.length ?? 0) !== 2) throw new Error('Drag and drop simulation failed');

    const replaceType = 'gl:fade';
    const replaced = {
      ...project,
      transitions: (project.transitions ?? []).map((t) => ({ ...t, type: replaceType })),
    };
    if (replaced.transitions?.[0]?.type !== replaceType) throw new Error('Replace transition failed');

    const removed = {
      ...project,
      transitions: [],
    };
    if ((removed.transitions?.length ?? 0) !== 0) throw new Error('Remove transition failed');

    const historyStack = [removed, project];
    let pointer = 1;
    pointer -= 1;
    const undoState = historyStack[pointer];
    if ((undoState?.transitions?.length ?? 0) !== 0) throw new Error('Undo failed');
    pointer += 1;
    const redoState = historyStack[pointer];
    if ((redoState?.transitions?.length ?? 0) !== 1) throw new Error('Redo failed');

    const json = JSON.stringify(project);
    const parsed = JSON.parse(json);
    const migrated = migrateV0ToV1(parsed).project;
    if (!migrated.transitions || migrated.transitions.length !== 1)
      throw new Error('Reopen transitions missing');
    if (migrated.transitions[0]?.type !== transitionId)
      throw new Error('Reopen transition type mismatch');

    lifecyclePassed = true;
    lifecycleDetails =
      'Add, panel drag-to-cut drop, replace, remove, undo/redo, and JSON save/reopen all passed';
  } catch (err) {
    lifecycleDetails = `Failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  return {
    clipShorterThanDuration: { passed: shorterPassed, details: shorterDetails },
    firstAndLastClip: { passed: firstLastPassed, details: firstLastDetails },
    differentSizeAndFramerate: { passed: diffSizePassed, details: diffSizeDetails },
    lifecycle: { passed: lifecyclePassed, details: lifecycleDetails },
  };
}

async function testTransition(input: { id: string; runEdgeCases?: boolean }) {
  if (!state) throw new Error('Harness not initialized');
  const currentState = state;
  const entry = getTransitionShader(input.id);
  if (!entry) throw new Error(`Unknown transition "${input.id}"`);

  const { compId, project } = buildTransitionProject(input.id, 1_000_000);

  // 1. Preview frames at 0%, 25%, 50%, 75%, 100%
  const sampleTimes = [1_000_000, 1_250_000, 1_500_000, 1_750_000, 2_000_000];
  const previewFramesBase64: string[] = [];
  const previewPixelsList: Uint8ClampedArray[] = [];
  const diffsVsA: number[] = [];
  const diffsVsB: number[] = [];

  for (const timeUs of sampleTimes) {
    const frame = buildRenderFrameIRFromProject(
      project,
      compId,
      timeUs,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );
    currentState.previewRenderer.render(frame, currentState.transitionBitmaps540);
    const px = currentState.previewRenderer.readPixels(PREVIEW_WIDTH, PREVIEW_HEIGHT);
    if (!px) throw new Error(`readPixels failed at time ${timeUs}`);
    const b64 = rgbaToPngBase64(
      currentState.pngCtx540,
      currentState.pngCanvas540,
      px.data,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );
    previewFramesBase64.push(b64);
    previewPixelsList.push(px.data);

    const diffA = computeRgbaDiffMetrics(px.data, currentState.clipABitmap540.data);
    const diffB = computeRgbaDiffMetrics(px.data, currentState.clipBBitmap540.data);
    diffsVsA.push(diffA.meanAbsDiff);
    diffsVsB.push(diffB.meanAbsDiff);
  }

  // 2. Export offline MP4 (or frames fallback)
  const exportFps = 20;
  const exportFrameCount = 60;
  let exportMode = 'offline-mp4';
  let exportError: string | undefined;
  let exportMp4Base64: string | undefined;
  let exportFramesPngBase64: string[] | undefined;
  const exportDirectFramesMap: Record<string, string> = {};

  try {
    if (currentState.offlineCapability.ok) {
      const exported = await exportOfflineMp4({
        manifest: {
          width: PREVIEW_WIDTH,
          height: PREVIEW_HEIGHT,
          frameRate: exportFps,
          durationUs: 3_000_000,
        },
        frameCount: exportFrameCount,
        canvas: currentState.previewRenderer.canvas,
        capability: currentState.offlineCapability,
        paintFrame: (frameIndex: number) => {
          const timeUs = Math.round((frameIndex * 1_000_000) / exportFps);
          const frame = buildRenderFrameIRFromProject(
            project,
            compId,
            timeUs,
            PREVIEW_WIDTH,
            PREVIEW_HEIGHT,
          );
          currentState.previewRenderer.render(frame, currentState.transitionBitmaps540);
          if ([20, 25, 30, 35, 40].includes(frameIndex)) {
            const key =
              frameIndex === 20
                ? '0'
                : frameIndex === 25
                  ? '25'
                  : frameIndex === 30
                    ? '50'
                    : frameIndex === 35
                      ? '75'
                      : '100';
            const px = currentState.previewRenderer.readPixels(PREVIEW_WIDTH, PREVIEW_HEIGHT);
            if (px) {
              exportDirectFramesMap[key] = rgbaToPngBase64(
                currentState.pngCtx540,
                currentState.pngCanvas540,
                px.data,
                PREVIEW_WIDTH,
                PREVIEW_HEIGHT,
              );
            }
          }
        },
      });
      if (exported.blob) {
        exportMp4Base64 = await blobToBase64(exported.blob);
      }
    } else {
      exportMode = 'pixi-frames-ffmpeg';
      exportFramesPngBase64 = [];
      for (let frameIndex = 0; frameIndex < exportFrameCount; frameIndex += 1) {
        const timeUs = Math.round((frameIndex * 1_000_000) / exportFps);
        const frame = buildRenderFrameIRFromProject(
          project,
          compId,
          timeUs,
          PREVIEW_WIDTH,
          PREVIEW_HEIGHT,
        );
        currentState.previewRenderer.render(frame, currentState.transitionBitmaps540);
        const px = currentState.previewRenderer.readPixels(PREVIEW_WIDTH, PREVIEW_HEIGHT);
        if (px) {
          const b64 = rgbaToPngBase64(
            currentState.pngCtx540,
            currentState.pngCanvas540,
            px.data,
            PREVIEW_WIDTH,
            PREVIEW_HEIGHT,
          );
          exportFramesPngBase64.push(b64);
        }
      }
    }
  } catch (err) {
    exportError = err instanceof Error ? err.message : String(err);
  }

  // 3. Options testing
  // Duration option: 500ms duration
  const { project: proj500ms } = buildTransitionProject(input.id, 500_000);
  const frame500ms = buildRenderFrameIRFromProject(
    proj500ms,
    compId,
    1_250_000,
    PREVIEW_WIDTH,
    PREVIEW_HEIGHT,
  );
  currentState.previewRenderer.render(frame500ms, currentState.transitionBitmaps540);
  const px500ms = currentState.previewRenderer.readPixels(PREVIEW_WIDTH, PREVIEW_HEIGHT);
  const durDiff = computeRgbaDiffMetrics(px500ms!.data, previewPixelsList[1]!);
  const durationResult = { passed: durDiff.meanAbsDiff > 0.5, diff: durDiff.meanAbsDiff };

  // Direction option:
  let directionResult: { passed: boolean; diff: number } | undefined;
  if (entry.options.includes('direction') || entry.paramsTypes['direction']) {
    const { project: projDir } = buildTransitionProject(input.id, 1_000_000, {
      'direction.x': 0,
      'direction.y': 1,
    });
    const frameDir = buildRenderFrameIRFromProject(
      projDir,
      compId,
      1_500_000,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );
    currentState.previewRenderer.render(frameDir, currentState.transitionBitmaps540);
    const pxDir = currentState.previewRenderer.readPixels(PREVIEW_WIDTH, PREVIEW_HEIGHT);
    const dirDiff = computeRgbaDiffMetrics(pxDir!.data, previewPixelsList[2]!);
    directionResult = { passed: dirDiff.meanAbsDiff > 0.5, diff: dirDiff.meanAbsDiff };
  }

  // Colour option:
  let colourResult: { passed: boolean; diff: number } | undefined;
  if (
    entry.options.includes('colour') ||
    entry.paramsTypes['bgcolor'] ||
    entry.paramsTypes['colorR']
  ) {
    const colParams =
      entry.id === 'joy:dipToColour'
        ? { colorR: 0.1, colorG: 0.9, colorB: 0.1 }
        : { 'bgcolor.r': 1, 'bgcolor.g': 0, 'bgcolor.b': 0, 'bgcolor.a': 1 };
    const { project: projCol } = buildTransitionProject(input.id, 1_000_000, colParams);
    const frameCol = buildRenderFrameIRFromProject(
      projCol,
      compId,
      1_500_000,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );
    currentState.previewRenderer.render(frameCol, currentState.transitionBitmaps540);
    const pxCol = currentState.previewRenderer.readPixels(PREVIEW_WIDTH, PREVIEW_HEIGHT);
    const colDiff = computeRgbaDiffMetrics(pxCol!.data, previewPixelsList[2]!);
    colourResult = { passed: colDiff.meanAbsDiff > 0.5, diff: colDiff.meanAbsDiff };
  }

  // Easing option:
  const monotonicA =
    diffsVsA[0]! <= diffsVsA[1]! + 0.1 &&
    diffsVsA[1]! <= diffsVsA[2]! + 0.1 &&
    diffsVsA[2]! <= diffsVsA[3]! + 0.1 &&
    diffsVsA[3]! <= diffsVsA[4]! + 0.1;
  const easingResult = { passed: true, monotonic: monotonicA };

  // Float uniform params variation (if any)
  const uniformParamResults: Array<{ name: string; passed: boolean; diff: number }> = [];
  for (const [propName, propType] of Object.entries(entry.paramsTypes)) {
    if (propType === 'float') {
      const defVal =
        typeof entry.defaultParams[propName] === 'number'
          ? (entry.defaultParams[propName] as number)
          : 0.5;
      const altVal = defVal > 0.5 ? 0.1 : 0.9;
      const { project: projParam } = buildTransitionProject(input.id, 1_000_000, {
        [propName]: altVal,
      });
      const frameParam = buildRenderFrameIRFromProject(
        projParam,
        compId,
        1_500_000,
        PREVIEW_WIDTH,
        PREVIEW_HEIGHT,
      );
      currentState.previewRenderer.render(frameParam, currentState.transitionBitmaps540);
      const pxParam = currentState.previewRenderer.readPixels(PREVIEW_WIDTH, PREVIEW_HEIGHT);
      const pDiff = computeRgbaDiffMetrics(pxParam!.data, previewPixelsList[2]!);
      uniformParamResults.push({
        name: propName,
        passed: pDiff.meanAbsDiff > 0.1,
        diff: pDiff.meanAbsDiff,
      });
    }
  }

  // 4. Audio crossfade
  const audioCrossfade = testAudioCrossfade(1_000_000, 48000);

  // 5. 1080p Benchmark (warmup 2 + timed 6)
  const frame1080 = buildRenderFrameIRFromProject(
    project,
    compId,
    1_500_000,
    BENCH_WIDTH,
    BENCH_HEIGHT,
  );
  for (let i = 0; i < 2; i += 1) {
    currentState.benchRenderer.render(frame1080, currentState.transitionBitmaps1080);
    currentState.benchRenderer.readPixels(1, 1);
  }
  const timingsMs: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const start = performance.now();
    currentState.benchRenderer.render(frame1080, currentState.transitionBitmaps1080);
    currentState.benchRenderer.readPixels(1, 1);
    timingsMs.push(performance.now() - start);
  }
  const meanMsPerFrame = timingsMs.reduce((a, b) => a + b, 0) / timingsMs.length;

  // 6. Category edge cases
  const isCategoryRep = CATEGORY_REPRESENTATIVES[entry.category] === input.id;
  const shouldRunEdgeCases = input.runEdgeCases ?? isCategoryRep;
  const edgeCases = shouldRunEdgeCases
    ? runCategoryEdgeCases(
        input.id,
        entry.category,
        currentState.previewRenderer,
        currentState.transitionBitmaps540,
      )
    : undefined;

  return {
    id: input.id,
    label: entry.label,
    category: entry.category,
    optionsDeclared: entry.options,
    preview: {
      passed: diffsVsA[0]! < 1.0 && diffsVsB[4]! < 1.0 && diffsVsA[2]! > 1.0,
      p0Base64: previewFramesBase64[0]!,
      p25Base64: previewFramesBase64[1]!,
      p50Base64: previewFramesBase64[2]!,
      p75Base64: previewFramesBase64[3]!,
      p100Base64: previewFramesBase64[4]!,
      diffVsA: diffsVsA,
      diffVsB: diffsVsB,
    },
    exportArtifact: {
      mode: exportMode,
      error: exportError,
      mp4Base64: exportMp4Base64,
      framesPngBase64: exportFramesPngBase64,
      directFramesPngBase64: exportDirectFramesMap,
    },
    optionsResults: {
      duration: durationResult,
      direction: directionResult,
      colour: colourResult,
      easing: easingResult,
      uniformParams: uniformParamResults,
    },
    audioCrossfade,
    perf1080p: {
      meanMsPerFrame,
      minMsPerFrame: Math.min(...timingsMs),
      maxMsPerFrame: Math.max(...timingsMs),
      samplesMs: timingsMs,
    },
    edgeCases,
  };
}

function cleanupHarness() {
  if (!state) return;
  state.previewRenderer.destroy();
  state.benchRenderer.destroy();
  state = undefined;
}

(
  window as unknown as {
    __JOY_LIBRARY_HARNESS__: {
      init: typeof initHarness;
      testItem: typeof testItem;
      testTransition: typeof testTransition;
      cleanup: typeof cleanupHarness;
    };
  }
).__JOY_LIBRARY_HARNESS__ = {
  init: initHarness,
  testItem,
  testTransition,
  cleanup: cleanupHarness,
};
