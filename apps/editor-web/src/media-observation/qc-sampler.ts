import {
  EvidenceStoreQuotaError,
  type EvidenceManifestLookup,
  type EvidenceStore,
} from './evidence-store.js';
import type {
  CompositionCaptureFailureCode,
  CompositionObservationRequest,
  CapturedCompositionEvidence,
} from './composition-observer.js';
import { createCompositionObserver } from './composition-observer.js';
import type { EvidenceFrameArtifactCoverage } from './evidence-store.js';

export const MAX_TIMELINE_QC_FRAMES = 64;
export const DEFAULT_TIMELINE_QC_FRAME_WIDTH = 480;
export const DEFAULT_TIMELINE_QC_FRAME_HEIGHT = 270;
export const DEFAULT_TIMELINE_QC_FRAME_BYTES = 512 * 1024;
export const DEFAULT_TIMELINE_QC_TOTAL_BYTES = 24 * 1024 * 1024;
export const MINIMUM_TIMELINE_TEXT_CONTRAST_RATIO = 4.5;

export interface TimelineQcRgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a?: number;
}

/** A text-box projection from the document, normalized to the composition size. */
export interface TimelineQcTextBox {
  readonly id: string;
  readonly kind: 'title' | 'caption';
  readonly startUs: number;
  readonly endUs: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly textColor: TimelineQcRgba;
  /** When present, use the authored plate instead of sampling video behind it. */
  readonly backgroundColor?: TimelineQcRgba;
}

export type TimelineQcSamplingStrategy =
  | { readonly kind: 'times'; readonly timesUs: readonly number[] }
  | { readonly kind: 'evenly-spaced-plus-cuts'; readonly count: number };

export interface TimelineQcSamplingPlanInput {
  readonly durationUs: number;
  readonly cutTimesUs?: readonly number[];
  readonly strategy: TimelineQcSamplingStrategy;
  readonly textBoxes?: readonly TimelineQcTextBox[];
  readonly maxFrames?: number;
}

export interface TimelineQcSamplingPlan {
  readonly durationUs: number;
  readonly timesUs: readonly number[];
  readonly frameIds: readonly string[];
  readonly textBoxes: readonly TimelineQcTextBox[];
  readonly cutTimesUs: readonly number[];
  readonly missedCutTimesUs: readonly number[];
  readonly coverage: EvidenceFrameArtifactCoverage;
}

export interface TimelineQcTextAnalysis {
  readonly id: string;
  readonly kind: TimelineQcTextBox['kind'];
  readonly startUs: number;
  readonly endUs: number;
  readonly safeArea: {
    readonly inside90Percent: boolean;
  };
  readonly legibility:
    | {
        readonly status: 'measured';
        readonly sampledAtUs: number;
        readonly contrastRatio: number;
        readonly meetsMinimumContrast: boolean;
      }
    | {
        readonly status: 'unavailable';
        readonly sampledAtUs: null;
        readonly contrastRatio: null;
        readonly meetsMinimumContrast: null;
      };
}

export interface TimelineQcCanvasImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface TimelineQcCanvas2DContext {
  createImageData(width: number, height: number): TimelineQcCanvasImageData;
  putImageData(imageData: TimelineQcCanvasImageData, x: number, y: number): void;
  drawImage(image: unknown, x: number, y: number, width: number, height: number): void;
}

export interface TimelineQcCanvas {
  readonly width: number;
  readonly height: number;
  getContext(type: '2d', options?: { readonly alpha?: boolean }): TimelineQcCanvas2DContext | null;
  convertToBlob(options: { readonly type: 'image/jpeg'; readonly quality: number }): Promise<Blob>;
}

export type TimelineQcCanvasFactory = (width: number, height: number) => TimelineQcCanvas;

export interface TimelineQcSamplerOptions {
  readonly canvasFactory?: TimelineQcCanvasFactory;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly maxFrameBytes?: number;
  readonly maxTotalBytes?: number;
  readonly jpegQuality?: number;
  readonly maxReadbackPixels?: number;
  readonly maxReadbackBytes?: number;
}

interface TimelineQcTextAnalyzer {
  /** Consumes this frame immediately and retains only the selected text-check results. */
  observe(
    frame: Pick<CapturedCompositionEvidence, 'outputTimeUs' | 'width' | 'height' | 'rgba'>,
  ): void;
  finish(): readonly TimelineQcTextAnalysis[];
}

export interface TimelineQcSampleRequest {
  readonly plan: TimelineQcSamplingPlan;
  readonly composition: Omit<CompositionObservationRequest, 'outputTimesUs'>;
  readonly evidenceStore: EvidenceStore;
  readonly evidenceLookup: EvidenceManifestLookup;
  readonly signal?: AbortSignal;
}

export type TimelineQcSampleResult =
  | {
      readonly status: 'captured';
      readonly frameIds: readonly string[];
      readonly coverage: EvidenceFrameArtifactCoverage;
      readonly textChecks: readonly TimelineQcTextAnalysis[];
    }
  | {
      readonly status: 'blocked';
      readonly diagnostics: readonly { readonly kind: string; readonly state: string }[];
      readonly sampledFrameCount: number;
    }
  | {
      readonly status: 'failed';
      readonly code: TimelineQcSamplerErrorCode | CompositionCaptureFailureCode;
      readonly sampledFrameCount: number;
    }
  | { readonly status: 'cancelled'; readonly sampledFrameCount: number };

export type TimelineQcSamplerErrorCode =
  | 'invalid-options'
  | 'invalid-plan'
  | 'manifest-unavailable'
  | 'canvas-unavailable'
  | 'artifact-too-large'
  | 'byte-budget-exceeded'
  | 'capture-failed';

export class TimelineQcSamplerError extends Error {
  constructor(readonly code: TimelineQcSamplerErrorCode) {
    super(`JOY timeline QC sampling failed: ${code}`);
    this.name = 'TimelineQcSamplerError';
  }
}

interface NormalizedTimelineQcSamplerOptions {
  readonly canvasFactory: TimelineQcCanvasFactory;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxFrameBytes: number;
  readonly maxTotalBytes: number;
  readonly jpegQuality: number;
  readonly maxReadbackPixels: number;
  readonly maxReadbackBytes: number;
}

const DEFAULT_MAX_READBACK_PIXELS = 1_920 * 1_080;
const DEFAULT_MAX_READBACK_BYTES = DEFAULT_MAX_READBACK_PIXELS * 4;
const DEFAULT_JPEG_QUALITY = 0.82;
const FRAME_ID_PREFIX = 'timeline-frame-';

/**
 * Builds a deterministic, bounded sample plan. Text-box midpoints are added so
 * every title and caption has one composed frame available for its contrast check.
 */
export function planTimelineQcSampling(input: TimelineQcSamplingPlanInput): TimelineQcSamplingPlan {
  const durationUs = normalizeDuration(input.durationUs);
  const maxFrames = normalizeMaxFrames(input.maxFrames);
  const cutTimesUs = normalizeCutTimes(input.cutTimesUs ?? [], durationUs);
  const textBoxes = normalizeTextBoxes(input.textBoxes ?? [], durationUs);
  const selectedTimes = new Set<number>();

  if (input.strategy.kind === 'times') {
    if (!Array.isArray(input.strategy.timesUs) || input.strategy.timesUs.length === 0)
      throw new TimelineQcSamplerError('invalid-plan');
    for (const timeUs of input.strategy.timesUs) {
      if (!Number.isSafeInteger(timeUs) || timeUs < 0 || timeUs >= durationUs)
        throw new TimelineQcSamplerError('invalid-plan');
      selectedTimes.add(timeUs);
    }
  } else if (input.strategy.kind === 'evenly-spaced-plus-cuts') {
    const count = input.strategy.count;
    if (!Number.isSafeInteger(count) || count < 1 || count > maxFrames)
      throw new TimelineQcSamplerError('invalid-plan');
    if (count === 1) selectedTimes.add(Math.floor((durationUs - 1) / 2));
    else {
      for (let index = 0; index < count; index += 1) {
        selectedTimes.add(Math.round((index * (durationUs - 1)) / (count - 1)));
      }
    }
    for (const cutTimeUs of cutTimesUs) selectedTimes.add(cutTimeUs);
  } else {
    throw new TimelineQcSamplerError('invalid-plan');
  }

  for (const box of textBoxes)
    selectedTimes.add(Math.floor(box.startUs + (box.endUs - box.startUs) / 2));
  const timesUs = [...selectedTimes].sort((left, right) => left - right);
  // A cut at zero is invalid; cuts or text midpoints beyond maxFrames fail closed.
  if (timesUs.length < 1 || timesUs.length > maxFrames)
    throw new TimelineQcSamplerError('invalid-plan');
  const selectedSet = new Set(timesUs);
  const selectedCutTimesUs = cutTimesUs.filter((timeUs) => selectedSet.has(timeUs));
  const frameIds = timesUs.map(timelineQcFrameId);
  const coverage: EvidenceFrameArtifactCoverage = Object.freeze({
    sourceDurationUs: durationUs,
    sampledFrameCount: timesUs.length,
    sampledCutCount: selectedCutTimesUs.length,
    totalCutCount: cutTimesUs.length,
    completeSourceCoverage: false,
  });

  return Object.freeze({
    durationUs,
    timesUs: Object.freeze(timesUs),
    frameIds: Object.freeze(frameIds),
    textBoxes,
    cutTimesUs,
    missedCutTimesUs: Object.freeze(cutTimesUs.filter((timeUs) => !selectedSet.has(timeUs))),
    coverage,
  });
}

/** Stable opaque ids bind one timeline sample to its evidence manifest. */
export function timelineQcFrameId(timeUs: number): string {
  if (!Number.isSafeInteger(timeUs) || timeUs < 0) throw new TimelineQcSamplerError('invalid-plan');
  return `${FRAME_ID_PREFIX}${timeUs}`;
}

/**
 * Checks safe-area placement and sampled-frame contrast for every supplied
 * title/caption box. The box coordinates are normalized to the composition.
 */
export function analyzeTimelineTextBoxes(
  textBoxes: readonly TimelineQcTextBox[],
  frames: readonly Pick<
    CapturedCompositionEvidence,
    'outputTimeUs' | 'width' | 'height' | 'rgba'
  >[],
): readonly TimelineQcTextAnalysis[] {
  const normalizedBoxes = normalizeTextBoxes(textBoxes, Number.MAX_SAFE_INTEGER);
  return Object.freeze(
    normalizedBoxes.map((box) => {
      const midpointUs = textBoxMidpoint(box);
      const frame = frames
        .filter(
          (candidate) =>
            candidate.outputTimeUs >= box.startUs && candidate.outputTimeUs < box.endUs,
        )
        .sort(
          (left, right) =>
            Math.abs(left.outputTimeUs - midpointUs) - Math.abs(right.outputTimeUs - midpointUs),
        )[0];
      return analyzeTextBoxOnFrame(box, frame);
    }),
  );
}

/** Streams frames through text checks while retaining only small numeric results. */
function createTimelineQcTextAnalyzer(
  textBoxes: readonly TimelineQcTextBox[],
  sampleTimesUs: readonly number[],
): TimelineQcTextAnalyzer {
  const boxes = normalizeTextBoxes(textBoxes, Number.MAX_SAFE_INTEGER);
  const selectedTimeByTextBox = new Map<string, number>();
  const analysisByTextBox = new Map<string, TimelineQcTextAnalysis>();
  for (const box of boxes) {
    const midpointUs = textBoxMidpoint(box);
    const selectedTimeUs = sampleTimesUs
      .filter((timeUs) => timeUs >= box.startUs && timeUs < box.endUs)
      .sort((left, right) => Math.abs(left - midpointUs) - Math.abs(right - midpointUs))[0];
    if (selectedTimeUs !== undefined) selectedTimeByTextBox.set(box.id, selectedTimeUs);
  }

  return {
    observe(frame) {
      for (const box of boxes) {
        if (selectedTimeByTextBox.get(box.id) !== frame.outputTimeUs) continue;
        analysisByTextBox.set(box.id, analyzeTextBoxOnFrame(box, frame));
      }
    },
    finish() {
      return Object.freeze(
        boxes.map((box) => analysisByTextBox.get(box.id) ?? analyzeTextBoxOnFrame(box, undefined)),
      );
    },
  };
}

/** Creates a sequential sampler which retains only bounded JPEG evidence. */
export function createTimelineQcSampler(options: TimelineQcSamplerOptions = {}): {
  sample(request: TimelineQcSampleRequest): Promise<TimelineQcSampleResult>;
} {
  const normalized = normalizeSamplerOptions(options);
  return {
    async sample(request) {
      let capturedCount = 0;
      try {
        const plan = validatePlan(request.plan);
        assertManifestMatchesPlan(request.evidenceStore, request.evidenceLookup, plan);
        const observer = createCompositionObserver({
          maxCaptureTimes: 1,
          maxPixels: normalized.maxReadbackPixels,
          maxReadbackBytes: normalized.maxReadbackBytes,
        });
        const textAnalyzer = createTimelineQcTextAnalyzer(plan.textBoxes, plan.timesUs);
        let totalBytes = 0;

        for (const [index, outputTimeUs] of plan.timesUs.entries()) {
          if (request.signal?.aborted === true || request.composition.signal?.aborted === true) {
            setStatus(request.evidenceStore, request.evidenceLookup, 'cancelled');
            return { status: 'cancelled', sampledFrameCount: capturedCount };
          }
          const signal = request.signal ?? request.composition.signal;
          const result = await observer.capture({
            ...request.composition,
            outputTimesUs: [outputTimeUs],
            ...(signal === undefined ? {} : { signal }),
          });
          if (result.status !== 'captured') {
            if (result.status === 'cancelled') {
              setStatus(request.evidenceStore, request.evidenceLookup, 'cancelled');
              return { status: 'cancelled', sampledFrameCount: capturedCount };
            }
            setStatus(
              request.evidenceStore,
              request.evidenceLookup,
              capturedCount === 0 ? 'failed' : 'partial',
            );
            if (result.status === 'blocked')
              return {
                status: 'blocked',
                diagnostics: result.diagnostics,
                sampledFrameCount: capturedCount,
              };
            return {
              status: 'failed',
              code: result.code,
              sampledFrameCount: capturedCount,
            };
          }
          const frame = result.frames[0];
          if (frame === undefined || result.frames.length !== 1)
            throw new TimelineQcSamplerError('capture-failed');
          textAnalyzer.observe(frame);
          const encoded = await encodeJpeg(frame, normalized);
          const jpeg = encoded.jpeg;
          if (jpeg.size > normalized.maxFrameBytes)
            throw new TimelineQcSamplerError('artifact-too-large');
          if (jpeg.size > normalized.maxTotalBytes - totalBytes)
            throw new TimelineQcSamplerError('byte-budget-exceeded');
          const frameId = plan.frameIds[index];
          if (frameId === undefined || frameId !== timelineQcFrameId(outputTimeUs))
            throw new TimelineQcSamplerError('invalid-plan');
          const decoded = request.evidenceStore.recordFrames({
            ...request.evidenceLookup,
            stage: 'decoded',
            frameIds: [frameId],
          });
          if (!decoded) throw new TimelineQcSamplerError('manifest-unavailable');
          const stored = request.evidenceStore.recordFrameArtifact({
            ...request.evidenceLookup,
            frameId,
            timestampUs: outputTimeUs,
            jpeg,
            width: encoded.width,
            height: encoded.height,
            coverage: plan.coverage,
          });
          if (!stored) throw new TimelineQcSamplerError('manifest-unavailable');
          capturedCount += 1;
          totalBytes += jpeg.size;
        }

        setStatus(request.evidenceStore, request.evidenceLookup, 'complete');
        return {
          status: 'captured',
          frameIds: plan.frameIds,
          coverage: plan.coverage,
          textChecks: textAnalyzer.finish(),
        };
      } catch (error) {
        const cancelled =
          request.signal?.aborted === true || request.composition.signal?.aborted === true;
        setStatus(
          request.evidenceStore,
          request.evidenceLookup,
          cancelled ? 'cancelled' : capturedCount === 0 ? 'failed' : 'partial',
        );
        if (cancelled) return { status: 'cancelled', sampledFrameCount: capturedCount };
        return {
          status: 'failed',
          code:
            error instanceof TimelineQcSamplerError
              ? error.code
              : error instanceof EvidenceStoreQuotaError
                ? 'byte-budget-exceeded'
                : 'capture-failed',
          sampledFrameCount: capturedCount,
        };
      }
    },
  };
}

function normalizeSamplerOptions(
  options: TimelineQcSamplerOptions,
): NormalizedTimelineQcSamplerOptions {
  const maxWidth = options.maxWidth ?? DEFAULT_TIMELINE_QC_FRAME_WIDTH;
  const maxHeight = options.maxHeight ?? DEFAULT_TIMELINE_QC_FRAME_HEIGHT;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_TIMELINE_QC_FRAME_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_TIMELINE_QC_TOTAL_BYTES;
  const jpegQuality = options.jpegQuality ?? DEFAULT_JPEG_QUALITY;
  const maxReadbackPixels = options.maxReadbackPixels ?? DEFAULT_MAX_READBACK_PIXELS;
  const maxReadbackBytes = options.maxReadbackBytes ?? DEFAULT_MAX_READBACK_BYTES;
  if (
    !Number.isSafeInteger(maxWidth) ||
    maxWidth < 1 ||
    !Number.isSafeInteger(maxHeight) ||
    maxHeight < 1 ||
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < 1 ||
    !Number.isSafeInteger(maxTotalBytes) ||
    maxTotalBytes < maxFrameBytes ||
    !Number.isFinite(jpegQuality) ||
    jpegQuality <= 0 ||
    jpegQuality > 1 ||
    !Number.isSafeInteger(maxReadbackPixels) ||
    maxReadbackPixels < 1 ||
    !Number.isSafeInteger(maxReadbackBytes) ||
    maxReadbackBytes < 4
  )
    throw new TimelineQcSamplerError('invalid-options');
  return Object.freeze({
    canvasFactory: options.canvasFactory ?? createOffscreenCanvas,
    maxWidth,
    maxHeight,
    maxFrameBytes,
    maxTotalBytes,
    jpegQuality,
    maxReadbackPixels,
    maxReadbackBytes,
  });
}

function createOffscreenCanvas(width: number, height: number): TimelineQcCanvas {
  if (typeof OffscreenCanvas === 'undefined')
    throw new TimelineQcSamplerError('canvas-unavailable');
  return new OffscreenCanvas(width, height) as unknown as TimelineQcCanvas;
}

function encodeJpeg(
  frame: CapturedCompositionEvidence,
  options: NormalizedTimelineQcSamplerOptions,
): Promise<{ readonly jpeg: Blob; readonly width: number; readonly height: number }> {
  const scale = Math.min(1, options.maxWidth / frame.width, options.maxHeight / frame.height);
  const width = Math.max(1, Math.floor(frame.width * scale));
  const height = Math.max(1, Math.floor(frame.height * scale));
  const sourceCanvas = options.canvasFactory(frame.width, frame.height);
  const sourceContext = sourceCanvas.getContext('2d', { alpha: false });
  if (sourceContext === null) throw new TimelineQcSamplerError('canvas-unavailable');
  const imageData = sourceContext.createImageData(frame.width, frame.height);
  imageData.data.set(frame.rgba);
  sourceContext.putImageData(imageData, 0, 0);
  const outputCanvas = options.canvasFactory(width, height);
  const outputContext = outputCanvas.getContext('2d', { alpha: false });
  if (outputContext === null) throw new TimelineQcSamplerError('canvas-unavailable');
  outputContext.drawImage(sourceCanvas, 0, 0, width, height);
  return outputCanvas
    .convertToBlob({ type: 'image/jpeg', quality: options.jpegQuality })
    .then((blob) => {
      if (!(blob instanceof Blob) || blob.type !== 'image/jpeg' || blob.size < 1)
        throw new TimelineQcSamplerError('canvas-unavailable');
      return Object.freeze({ jpeg: blob, width, height });
    });
}

function assertManifestMatchesPlan(
  evidenceStore: EvidenceStore,
  lookup: EvidenceManifestLookup,
  plan: TimelineQcSamplingPlan,
): void {
  const manifest = evidenceStore.readManifest(lookup);
  const page = evidenceStore.readCoveragePage({ ...lookup, pageIndex: 0 });
  if (
    manifest === undefined ||
    page === undefined ||
    manifest.status !== 'running' ||
    manifest.persistence !== 'ephemeral' ||
    manifest.intendedFrameCount !== plan.frameIds.length ||
    page.intendedFrameIds.length !== plan.frameIds.length ||
    page.intendedFrameIds.some((frameId, index) => frameId !== plan.frameIds[index])
  )
    throw new TimelineQcSamplerError('manifest-unavailable');
}

function validatePlan(value: TimelineQcSamplingPlan): TimelineQcSamplingPlan {
  if (
    value === null ||
    typeof value !== 'object' ||
    !Number.isSafeInteger(value.durationUs) ||
    value.durationUs < 1 ||
    !Array.isArray(value.timesUs) ||
    !Array.isArray(value.frameIds) ||
    value.timesUs.length < 1 ||
    value.timesUs.length > MAX_TIMELINE_QC_FRAMES ||
    value.frameIds.length !== value.timesUs.length ||
    !Array.isArray(value.textBoxes)
  )
    throw new TimelineQcSamplerError('invalid-plan');
  let previous = -1;
  for (const [index, timeUs] of value.timesUs.entries()) {
    if (
      !Number.isSafeInteger(timeUs) ||
      timeUs < 0 ||
      timeUs >= value.durationUs ||
      timeUs <= previous ||
      value.frameIds[index] !== timelineQcFrameId(timeUs)
    )
      throw new TimelineQcSamplerError('invalid-plan');
    previous = timeUs;
  }
  return value;
}

function setStatus(
  evidenceStore: EvidenceStore,
  lookup: EvidenceManifestLookup,
  status: 'complete' | 'partial' | 'failed' | 'cancelled',
): void {
  try {
    evidenceStore.setStatus({ ...lookup, status });
  } catch {
    // A stale manifest must not leak storage errors into an agent-facing result.
  }
}

function normalizeDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TimelineQcSamplerError('invalid-plan');
  return value;
}

function normalizeMaxFrames(value: number | undefined): number {
  if (value === undefined) return MAX_TIMELINE_QC_FRAMES;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMELINE_QC_FRAMES)
    throw new TimelineQcSamplerError('invalid-plan');
  return value;
}

function normalizeCutTimes(value: readonly number[], durationUs: number): readonly number[] {
  if (!Array.isArray(value)) throw new TimelineQcSamplerError('invalid-plan');
  const times = new Set<number>();
  for (const timeUs of value) {
    if (!Number.isSafeInteger(timeUs) || timeUs <= 0 || timeUs >= durationUs)
      throw new TimelineQcSamplerError('invalid-plan');
    times.add(timeUs);
  }
  return Object.freeze([...times].sort((left, right) => left - right));
}

function normalizeTextBoxes(
  value: readonly TimelineQcTextBox[],
  durationUs: number,
): readonly TimelineQcTextBox[] {
  if (!Array.isArray(value) || value.length > 10_000)
    throw new TimelineQcSamplerError('invalid-plan');
  const ids = new Set<string>();
  return Object.freeze(
    value.map((box) => {
      if (
        box === null ||
        typeof box !== 'object' ||
        typeof box.id !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:@=-]{0,255}$/.test(box.id) ||
        ids.has(box.id) ||
        (box.kind !== 'title' && box.kind !== 'caption') ||
        !Number.isSafeInteger(box.startUs) ||
        !Number.isSafeInteger(box.endUs) ||
        box.startUs < 0 ||
        box.endUs <= box.startUs ||
        box.endUs > durationUs ||
        ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
        box.width <= 0 ||
        box.height <= 0
      )
        throw new TimelineQcSamplerError('invalid-plan');
      ids.add(box.id);
      const textColor = normalizeColor(box.textColor);
      const backgroundColor =
        box.backgroundColor === undefined ? undefined : normalizeColor(box.backgroundColor);
      return Object.freeze({
        id: box.id,
        kind: box.kind,
        startUs: box.startUs,
        endUs: box.endUs,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        textColor,
        ...(backgroundColor === undefined ? {} : { backgroundColor }),
      });
    }),
  );
}

function normalizeColor(value: TimelineQcRgba): TimelineQcRgba {
  if (
    value === null ||
    typeof value !== 'object' ||
    ![value.r, value.g, value.b, value.a ?? 255].every(
      (channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255,
    )
  )
    throw new TimelineQcSamplerError('invalid-plan');
  return Object.freeze({ r: value.r, g: value.g, b: value.b, a: value.a ?? 255 });
}

function textBoxMidpoint(box: TimelineQcTextBox): number {
  return Math.floor(box.startUs + (box.endUs - box.startUs) / 2);
}

function analyzeTextBoxOnFrame(
  box: TimelineQcTextBox,
  frame:
    Pick<CapturedCompositionEvidence, 'outputTimeUs' | 'width' | 'height' | 'rgba'> | undefined,
): TimelineQcTextAnalysis {
  const inside90Percent =
    box.x >= 0.05 && box.y >= 0.05 && box.x + box.width <= 0.95 && box.y + box.height <= 0.95;
  if (frame === undefined) {
    return Object.freeze({
      id: box.id,
      kind: box.kind,
      startUs: box.startUs,
      endUs: box.endUs,
      safeArea: Object.freeze({ inside90Percent }),
      legibility: Object.freeze({
        status: 'unavailable' as const,
        sampledAtUs: null,
        contrastRatio: null,
        meetsMinimumContrast: null,
      }),
    });
  }
  const backgroundColor = sampleBackgroundColor(frame, box);
  if (backgroundColor === undefined) {
    return Object.freeze({
      id: box.id,
      kind: box.kind,
      startUs: box.startUs,
      endUs: box.endUs,
      safeArea: Object.freeze({ inside90Percent }),
      legibility: Object.freeze({
        status: 'unavailable' as const,
        sampledAtUs: null,
        contrastRatio: null,
        meetsMinimumContrast: null,
      }),
    });
  }
  const backgroundLuminance = relativeLuminance(backgroundColor);
  const textLuminance = relativeLuminance(compositeColor(box.textColor, backgroundColor));
  const contrastRatio = contrast(textLuminance, backgroundLuminance);
  return Object.freeze({
    id: box.id,
    kind: box.kind,
    startUs: box.startUs,
    endUs: box.endUs,
    safeArea: Object.freeze({ inside90Percent }),
    legibility: Object.freeze({
      status: 'measured' as const,
      sampledAtUs: frame.outputTimeUs,
      contrastRatio,
      meetsMinimumContrast: contrastRatio >= MINIMUM_TIMELINE_TEXT_CONTRAST_RATIO,
    }),
  });
}

function sampleBackgroundColor(
  frame: Pick<CapturedCompositionEvidence, 'width' | 'height' | 'rgba'>,
  box: TimelineQcTextBox,
): TimelineQcRgba | undefined {
  if (
    !Number.isSafeInteger(frame.width) ||
    frame.width < 1 ||
    !Number.isSafeInteger(frame.height) ||
    frame.height < 1 ||
    frame.rgba.byteLength !== frame.width * frame.height * 4
  )
    return undefined;
  if (box.backgroundColor !== undefined)
    return compositeColor(box.backgroundColor, { r: 0, g: 0, b: 0, a: 255 });

  const left = Math.max(0, Math.floor(box.x * frame.width));
  const top = Math.max(0, Math.floor(box.y * frame.height));
  const right = Math.min(frame.width, Math.ceil((box.x + box.width) * frame.width));
  const bottom = Math.min(frame.height, Math.ceil((box.y + box.height) * frame.height));
  if (right <= left || bottom <= top) return undefined;
  const sampleStride = Math.max(
    1,
    Math.floor(Math.sqrt(((right - left) * (bottom - top)) / 4_096)),
  );
  const text = box.textColor;
  const pixels: { readonly color: TimelineQcRgba; readonly luminance: number }[] = [];
  const allPixels: { readonly color: TimelineQcRgba; readonly luminance: number }[] = [];
  for (let y = top; y < bottom; y += sampleStride) {
    for (let x = left; x < right; x += sampleStride) {
      const offset = (y * frame.width + x) * 4;
      const r = frame.rgba[offset]!;
      const g = frame.rgba[offset + 1]!;
      const b = frame.rgba[offset + 2]!;
      const color = { r, g, b, a: 255 };
      const luminance = relativeLuminance(color);
      const sample = { color, luminance };
      allPixels.push(sample);
      const distance = (r - text.r) ** 2 + (g - text.g) ** 2 + (b - text.b) ** 2;
      if (distance > 30 ** 2 * 3) pixels.push(sample);
    }
  }
  const candidates = pixels.length > 0 ? pixels : allPixels;
  if (candidates.length === 0) return undefined;
  candidates.sort((left, right) => left.luminance - right.luminance);
  return candidates[Math.floor(candidates.length / 2)]!.color;
}

function compositeColor(color: TimelineQcRgba, background: TimelineQcRgba): TimelineQcRgba {
  const alpha = (color.a ?? 255) / 255;
  return {
    r: color.r * alpha + background.r * (1 - alpha),
    g: color.g * alpha + background.g * (1 - alpha),
    b: color.b * alpha + background.b * (1 - alpha),
    a: 255,
  };
}

function relativeLuminance(color: TimelineQcRgba): number {
  const linear = [color.r, color.g, color.b].map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(left: number, right: number): number {
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}
