/* global window, document, Image, ImageData, FileReader, performance, Uint8ClampedArray */
import { effectRegistry, effectToFfmpegFilter, registerBuiltins } from '@joy-media/visual-effects';
import type { EffectParamValue } from '@joy-media/visual-effects';
import { VisualObjectProjectHistory } from '@joy-media/property-system';
import type { VisualObjectCommand } from '@joy-media/property-system';
import { canonicalBindingKey, migrateV0ToV1 } from '@joy-media/project-schema';
import type { JoyProjectV1 } from '@joy-media/project-schema';
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
import { previewAccepted } from './preview-rule.js';

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
  readonly contextParams?: Readonly<Record<string, EffectParamValue>>;
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
  readonly contextParams?: Readonly<Record<string, EffectParamValue>>;
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

async function initHarness(faceDataUrl?: string) {
  registerBuiltins();
  const faceImage = faceDataUrl ? await loadImage(faceDataUrl) : undefined;
  const chart1080 = createBitmapFromChart(BENCH_WIDTH, BENCH_HEIGHT, faceImage);
  const chart540 = createBitmapFromChart(PREVIEW_WIDTH, PREVIEW_HEIGHT, faceImage);

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

  return {
    filters,
    effects,
    descriptors,
    offlineCapability,
    knownChartPngBase64: chart1080.pngBase64,
    beforePngBase64,
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
          ...Object.entries(paramPlan.contextParams ?? {}).map(([contextKey, contextValue]) => ({
            type: 'effect.setParam' as const,
            payload: {
              objectId: OBJECT_ID,
              effectInstanceId: instanceId,
              paramKey: contextKey,
              value: contextValue,
            },
          })),
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
        ...Object.keys(paramPlan.contextParams ?? {}).map((contextKey) => ({
          type: 'effect.setParam' as const,
          payload: {
            objectId: OBJECT_ID,
            effectInstanceId: instanceId,
            paramKey: contextKey,
            value: defaultParams[contextKey]!,
          },
        })),
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
            params: { ...defaultParamsFor(descriptor), ...input.keyframePlan.contextParams },
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

  const previewDecision = previewAccepted({
    isBlankFrame,
    defaultVsBeforeMeanDiff: previewVsBefore.meanAbsDiff,
    adjustedVsDefaultMeanDiffs: paramChecks
      .filter((p) => p.passed)
      .map((p) => Math.max(p.lowVsDefaultMeanDiff, p.highVsDefaultMeanDiff)),
  });
  const previewOk = previewDecision.accepted;
  const neutralDefault = previewDecision.neutralDefault;

  return {
    id: input.id,
    label: descriptor.label,
    category: descriptor.category,
    ffmpegBackendNative: descriptor.backend.ffmpeg,
    ffmpegFilterGraphPresent: ffmpegFilterGraph !== undefined,
    preview: {
      passed: previewOk,
      neutralDefault,
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
      cleanup: typeof cleanupHarness;
    };
  }
).__JOY_LIBRARY_HARNESS__ = {
  init: initHarness,
  testItem,
  cleanup: cleanupHarness,
};
