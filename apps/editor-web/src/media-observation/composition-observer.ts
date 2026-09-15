import {
  createCompositionEvidenceIdentity,
  type CompositionEvidenceIdentity,
} from '@joy-media/media-core';
import { validateRenderFrameIR, type RenderFrameIR } from '@joy-media/render-ir';

/** No caller can ask this isolated capture seam to fan out without a new host policy. */
export const DEFAULT_MAX_COMPOSITION_CAPTURE_TIMES = 24;
export const MAX_COMPOSITION_CAPTURE_TIMES = 64;
/** A default 1080p readback keeps a single local evidence capture bounded. */
export const DEFAULT_MAX_COMPOSITION_CAPTURE_PIXELS = 1_920 * 1_080;
export const MAX_COMPOSITION_CAPTURE_PIXELS = 4_096 * 2_160;
export const DEFAULT_MAX_COMPOSITION_CAPTURE_BYTES = DEFAULT_MAX_COMPOSITION_CAPTURE_PIXELS * 4;
export const MAX_COMPOSITION_CAPTURE_BYTES = MAX_COMPOSITION_CAPTURE_PIXELS * 4;

const MAX_SNAPSHOT_DEPTH = 64;
const MAX_SNAPSHOT_NODES = 100_000;
const MAX_SNAPSHOT_STRING_LENGTH = 65_536;
const MAX_SNAPSHOT_OBJECT_KEYS = 8_192;

const SNAPSHOT_KINDS = ['canonical', 'prepared'] as const;
const READINESS_KINDS = ['asset', 'font', 'scene', 'shader'] as const;
const READINESS_STATES = ['ready', 'missing', 'failed', 'pending', 'approximate'] as const;

export type CompositionSnapshotKind = (typeof SNAPSHOT_KINDS)[number];
export type CompositionReadinessKind = (typeof READINESS_KINDS)[number];
export type CompositionReadinessState = (typeof READINESS_STATES)[number];

/**
 * The composition state carried across this boundary is a bounded data tree,
 * never a live editor object. The observer clones and freezes it before any
 * asynchronous work begins, so an evaluator cannot follow current selection,
 * playhead, undo history, or later project edits by accident.
 */
export type CompositionSnapshotArray = ReadonlyArray<CompositionSnapshotValue>;

export interface CompositionSnapshotObject {
  readonly [key: string]: CompositionSnapshotValue;
}

export type CompositionSnapshotValue =
  null | boolean | number | string | CompositionSnapshotArray | CompositionSnapshotObject;

export interface CompositionCaptureSnapshotInput {
  readonly kind: CompositionSnapshotKind;
  readonly compositionId: string;
  readonly projectRevision: string;
  readonly rendererVersion: string;
  readonly evaluatorVersion: string;
  readonly dependencyDigests: readonly string[];
  readonly state: CompositionSnapshotValue;
}

/** A host-produced, detached copy of a canonical or prepared composition. */
export interface FrozenCompositionCaptureSnapshot {
  readonly kind: CompositionSnapshotKind;
  readonly compositionId: string;
  readonly projectRevision: string;
  readonly rendererVersion: string;
  readonly evaluatorVersion: string;
  readonly dependencyDigests: readonly string[];
  readonly state: CompositionSnapshotValue;
}

/**
 * The readiness adapter must report all composition dependency classes. It
 * deliberately carries no asset names, paths, browser errors, or provider
 * data, so a failed capture cannot disclose them through diagnostics.
 */
export interface CompositionReadinessReport {
  readonly asset: CompositionReadinessState;
  readonly font: CompositionReadinessState;
  readonly scene: CompositionReadinessState;
  readonly shader: CompositionReadinessState;
}

export interface CompositionReadinessAdapter {
  check(
    snapshot: FrozenCompositionCaptureSnapshot,
    signal: AbortSignal,
  ): Promise<CompositionReadinessReport> | CompositionReadinessReport;
}

/**
 * Production wiring must point this at the same prepared RenderFrameIR path
 * used by composition preview/export. This module owns neither UI state nor a
 * renderer instance and therefore cannot substitute the live Monitor canvas.
 */
export interface RenderFrameEvaluatorAdapter {
  readonly version: string;
  evaluate(
    snapshot: FrozenCompositionCaptureSnapshot,
    outputTimeUs: number,
    signal: AbortSignal,
  ): Promise<RenderFrameIR> | RenderFrameIR;
}

export interface IsolatedCompositionReadback {
  readonly width: number;
  readonly height: number;
  /** RGBA bytes in top-left presentation order. */
  readonly data: Uint8Array | Uint8ClampedArray;
  /** Releases an adapter-owned intermediate after the observer copies pixels. */
  readonly dispose?: () => void;
}

/** Explicitly excludes editor chrome, selection outlines, and agent highlights. */
export interface IsolatedCompositionRenderRequest {
  readonly purpose: 'composition-evidence';
  readonly includeEditorOverlays: false;
  readonly outputTimeUs: number;
  readonly maxPixels: number;
  readonly maxReadbackBytes: number;
  readonly signal: AbortSignal;
}

export interface IsolatedCompositionRendererAdapter {
  readonly version: string;
  renderAndReadback(
    frame: RenderFrameIR,
    request: IsolatedCompositionRenderRequest,
  ): Promise<IsolatedCompositionReadback> | IsolatedCompositionReadback;
}

export interface CompositionObservationRequest {
  readonly snapshot: CompositionCaptureSnapshotInput;
  /** Strictly increasing exact composition output timestamps. */
  readonly outputTimesUs: readonly number[];
  readonly readiness: CompositionReadinessAdapter;
  readonly evaluator: RenderFrameEvaluatorAdapter;
  readonly renderer: IsolatedCompositionRendererAdapter;
  readonly signal?: AbortSignal;
}

export interface CompositionObserverOptions {
  readonly maxCaptureTimes?: number;
  readonly maxPixels?: number;
  readonly maxReadbackBytes?: number;
}

export interface CompositionReadinessDiagnostic {
  readonly kind: CompositionReadinessKind;
  readonly state: Exclude<CompositionReadinessState, 'ready'>;
}

export interface CapturedCompositionEvidence {
  readonly identity: CompositionEvidenceIdentity;
  readonly snapshotKind: CompositionSnapshotKind;
  readonly outputTimeUs: number;
  readonly width: number;
  readonly height: number;
  /** Defensive copy; the renderer's buffer is never retained. */
  readonly rgba: Uint8Array;
}

export interface CompositionCaptureSuccess {
  readonly status: 'captured';
  /** These pixels came from the isolated RenderFrameIR readback only. */
  readonly captureScope: 'isolated-render-readback';
  /** Final encoded media has not been decoded or verified by this O6 slice. */
  readonly encodedOutput: 'not-assessed';
  readonly frames: readonly CapturedCompositionEvidence[];
}

export interface CompositionCaptureBlocked {
  readonly status: 'blocked';
  readonly code: 'dependency-not-ready';
  readonly diagnostics: readonly CompositionReadinessDiagnostic[];
}

export type CompositionCaptureFailureCode =
  | 'readiness-unavailable'
  | 'invalid-readiness'
  | 'adapter-version-mismatch'
  | 'evaluator-failed'
  | 'invalid-frame'
  | 'render-surface-too-large'
  | 'renderer-failed'
  | 'invalid-readback'
  | 'readback-too-large';

export interface CompositionCaptureFailure {
  readonly status: 'failed';
  readonly code: CompositionCaptureFailureCode;
}

export interface CompositionCaptureCancelled {
  readonly status: 'cancelled';
}

export type CompositionCaptureResult =
  | CompositionCaptureSuccess
  | CompositionCaptureBlocked
  | CompositionCaptureFailure
  | CompositionCaptureCancelled;

export type CompositionObserverErrorCode = 'invalid-options' | 'invalid-request';

/** Bounded and redacted input errors; adapter exceptions never escape as text. */
export class CompositionObserverError extends Error {
  constructor(readonly code: CompositionObserverErrorCode) {
    super('JOY composition observation request is invalid.');
    this.name = 'CompositionObserverError';
  }
}

export interface CompositionObserver {
  capture(request: CompositionObservationRequest): Promise<CompositionCaptureResult>;
}

interface NormalizedCompositionObserverOptions {
  readonly maxCaptureTimes: number;
  readonly maxPixels: number;
  readonly maxReadbackBytes: number;
}

interface NormalizedCompositionObservationRequest {
  readonly snapshot: FrozenCompositionCaptureSnapshot;
  readonly outputTimesUs: readonly number[];
  readonly readiness: CompositionReadinessAdapter;
  readonly evaluator: RenderFrameEvaluatorAdapter;
  readonly renderer: IsolatedCompositionRendererAdapter;
  readonly signal?: AbortSignal;
}

interface NormalizedReadback {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

class ReadbackTooLargeError extends Error {}
class RenderSurfaceTooLargeError extends Error {}

/**
 * Creates an immutable data snapshot for a composition capture. This helper
 * makes the "frozen" contract observable and reusable at the future App/export
 * seam; it does not read, write, or retain the live editor's UI state.
 */
export function createFrozenCompositionCaptureSnapshot(
  input: CompositionCaptureSnapshotInput,
): FrozenCompositionCaptureSnapshot {
  try {
    return normalizeSnapshot(input);
  } catch {
    throw new CompositionObserverError('invalid-request');
  }
}

/**
 * Captures composition pixels through supplied evaluator/renderer adapters.
 * It intentionally stops at isolated render readback: it cannot validate a
 * MediaRecorder/container result, and it never labels such output verified.
 */
export function createCompositionObserver(
  options: CompositionObserverOptions = {},
): CompositionObserver {
  const normalizedOptions = normalizeOptions(options);

  return {
    async capture(input) {
      const request = normalizeRequest(input, normalizedOptions);
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort();
      const callerSignal = request.signal;
      callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
      if (callerSignal?.aborted === true) controller.abort();

      try {
        if (controller.signal.aborted) return cancelled();
        if (
          request.evaluator.version !== request.snapshot.evaluatorVersion ||
          request.renderer.version !== request.snapshot.rendererVersion
        )
          return failed('adapter-version-mismatch');

        let rawReadiness: CompositionReadinessReport;
        try {
          rawReadiness = await request.readiness.check(request.snapshot, controller.signal);
        } catch {
          if (controller.signal.aborted) return cancelled();
          return failed('readiness-unavailable');
        }
        if (controller.signal.aborted) return cancelled();
        let readiness: CompositionReadinessReport;
        try {
          readiness = normalizeReadiness(rawReadiness);
        } catch {
          return failed('invalid-readiness');
        }

        const diagnostics = readinessDiagnostics(readiness);
        if (diagnostics.length > 0)
          return Object.freeze({
            status: 'blocked' as const,
            code: 'dependency-not-ready' as const,
            diagnostics,
          });

        const frames: CapturedCompositionEvidence[] = [];
        for (const outputTimeUs of request.outputTimesUs) {
          if (controller.signal.aborted) return cancelled();
          let frame: RenderFrameIR;
          try {
            frame = await request.evaluator.evaluate(
              request.snapshot,
              outputTimeUs,
              controller.signal,
            );
          } catch {
            if (controller.signal.aborted) return cancelled();
            return failed('evaluator-failed');
          }
          if (controller.signal.aborted) return cancelled();
          try {
            assertIsolatedCompositionFrame(
              frame,
              request.snapshot.compositionId,
              outputTimeUs,
              normalizedOptions,
            );
          } catch (error) {
            return failed(
              error instanceof RenderSurfaceTooLargeError
                ? 'render-surface-too-large'
                : 'invalid-frame',
            );
          }
          if (controller.signal.aborted) return cancelled();

          let rawReadback: IsolatedCompositionReadback;
          try {
            rawReadback = await request.renderer.renderAndReadback(
              frame,
              Object.freeze({
                purpose: 'composition-evidence' as const,
                includeEditorOverlays: false as const,
                outputTimeUs,
                maxPixels: normalizedOptions.maxPixels,
                maxReadbackBytes: normalizedOptions.maxReadbackBytes,
                signal: controller.signal,
              }),
            );
          } catch {
            if (controller.signal.aborted) return cancelled();
            return failed('renderer-failed');
          }
          let readback: NormalizedReadback;
          try {
            if (controller.signal.aborted) return cancelled();
            try {
              readback = normalizeReadback(rawReadback, normalizedOptions);
            } catch (error) {
              if (controller.signal.aborted) return cancelled();
              return failed(
                error instanceof ReadbackTooLargeError ? 'readback-too-large' : 'invalid-readback',
              );
            }
            if (controller.signal.aborted) return cancelled();
          } finally {
            disposeReadback(rawReadback);
          }

          const identity = createCompositionEvidenceIdentity({
            compositionId: request.snapshot.compositionId,
            projectRevision: request.snapshot.projectRevision,
            outputTimeUs,
            rendererVersion: request.snapshot.rendererVersion,
            evaluatorVersion: request.snapshot.evaluatorVersion,
            dependencyDigests: request.snapshot.dependencyDigests,
          });
          frames.push(
            Object.freeze({
              identity: Object.freeze({
                ...identity,
                dependencyDigests: Object.freeze([...identity.dependencyDigests]),
              }),
              snapshotKind: request.snapshot.kind,
              outputTimeUs,
              width: readback.width,
              height: readback.height,
              rgba: readback.rgba,
            }),
          );
        }

        return Object.freeze({
          status: 'captured' as const,
          captureScope: 'isolated-render-readback' as const,
          encodedOutput: 'not-assessed' as const,
          frames: Object.freeze(frames),
        });
      } finally {
        callerSignal?.removeEventListener('abort', abortFromCaller);
      }
    },
  };
}

function normalizeOptions(
  options: CompositionObserverOptions,
): NormalizedCompositionObserverOptions {
  try {
    if (
      !isPlainRecord(options) ||
      !hasOnlyKeys(options, ['maxCaptureTimes', 'maxPixels', 'maxReadbackBytes'], [])
    )
      throw new Error();
    return Object.freeze({
      maxCaptureTimes: boundedPositiveSafeInteger(
        options.maxCaptureTimes ?? DEFAULT_MAX_COMPOSITION_CAPTURE_TIMES,
        MAX_COMPOSITION_CAPTURE_TIMES,
      ),
      maxPixels: boundedPositiveSafeInteger(
        options.maxPixels ?? DEFAULT_MAX_COMPOSITION_CAPTURE_PIXELS,
        MAX_COMPOSITION_CAPTURE_PIXELS,
      ),
      maxReadbackBytes: boundedPositiveSafeInteger(
        options.maxReadbackBytes ?? DEFAULT_MAX_COMPOSITION_CAPTURE_BYTES,
        MAX_COMPOSITION_CAPTURE_BYTES,
      ),
    });
  } catch {
    throw new CompositionObserverError('invalid-options');
  }
}

function normalizeRequest(
  input: CompositionObservationRequest,
  options: NormalizedCompositionObserverOptions,
): NormalizedCompositionObservationRequest {
  try {
    if (
      !isPlainRecord(input) ||
      !hasOnlyKeys(
        input,
        ['snapshot', 'outputTimesUs', 'readiness', 'evaluator', 'renderer', 'signal'],
        ['snapshot', 'outputTimesUs', 'readiness', 'evaluator', 'renderer'],
      )
    )
      throw new Error();
    if (
      input.readiness === null ||
      typeof input.readiness !== 'object' ||
      typeof input.readiness.check !== 'function' ||
      input.evaluator === null ||
      typeof input.evaluator !== 'object' ||
      typeof input.evaluator.evaluate !== 'function' ||
      !isOpaqueVersion(input.evaluator.version) ||
      input.renderer === null ||
      typeof input.renderer !== 'object' ||
      typeof input.renderer.renderAndReadback !== 'function' ||
      !isOpaqueVersion(input.renderer.version) ||
      !isAbortSignal(input.signal)
    )
      throw new Error();
    return Object.freeze({
      snapshot: normalizeSnapshot(input.snapshot),
      outputTimesUs: normalizeOutputTimes(input.outputTimesUs, options.maxCaptureTimes),
      readiness: input.readiness,
      evaluator: input.evaluator,
      renderer: input.renderer,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    if (error instanceof CompositionObserverError) throw error;
    throw new CompositionObserverError('invalid-request');
  }
}

function normalizeSnapshot(input: unknown): FrozenCompositionCaptureSnapshot {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, [
      'kind',
      'compositionId',
      'projectRevision',
      'rendererVersion',
      'evaluatorVersion',
      'dependencyDigests',
      'state',
    ])
  )
    throw new Error();
  const kind = dataValue(input, 'kind');
  if (typeof kind !== 'string' || !(SNAPSHOT_KINDS as readonly string[]).includes(kind))
    throw new Error();
  const candidate = {
    kind: kind as CompositionSnapshotKind,
    compositionId: dataValue(input, 'compositionId'),
    projectRevision: dataValue(input, 'projectRevision'),
    rendererVersion: dataValue(input, 'rendererVersion'),
    evaluatorVersion: dataValue(input, 'evaluatorVersion'),
    dependencyDigests: dataValue(input, 'dependencyDigests'),
    state: dataValue(input, 'state'),
  };
  // The shared factory is the sole canonical validator/normalizer for the
  // identity fields. A time of zero only validates snapshot metadata; each
  // capture below receives its own exact output-time identity.
  const canonicalIdentity = createCompositionEvidenceIdentity({
    compositionId: candidate.compositionId as string,
    projectRevision: candidate.projectRevision as string,
    outputTimeUs: 0,
    rendererVersion: candidate.rendererVersion as string,
    evaluatorVersion: candidate.evaluatorVersion as string,
    dependencyDigests: candidate.dependencyDigests as readonly string[],
  });
  return Object.freeze({
    kind: candidate.kind,
    compositionId: canonicalIdentity.compositionId,
    projectRevision: canonicalIdentity.projectRevision,
    rendererVersion: canonicalIdentity.rendererVersion,
    evaluatorVersion: canonicalIdentity.evaluatorVersion,
    dependencyDigests: Object.freeze([...canonicalIdentity.dependencyDigests]),
    state: cloneFrozenSnapshotValue(candidate.state),
  });
}

function normalizeOutputTimes(value: unknown, maxCaptureTimes: number): readonly number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxCaptureTimes)
    throw new Error();
  const times: number[] = [];
  let previous = -1;
  for (const timeUs of value) {
    if (!Number.isSafeInteger(timeUs) || timeUs < 0 || timeUs <= previous) throw new Error();
    times.push(timeUs);
    previous = timeUs;
  }
  return Object.freeze(times);
}

function normalizeReadiness(value: unknown): CompositionReadinessReport {
  if (!isPlainRecord(value) || !hasExactKeys(value, READINESS_KINDS)) throw new Error();
  const report: Record<CompositionReadinessKind, CompositionReadinessState> = {
    asset: 'ready',
    font: 'ready',
    scene: 'ready',
    shader: 'ready',
  };
  for (const kind of READINESS_KINDS) {
    const state = dataValue(value, kind);
    if (typeof state !== 'string' || !(READINESS_STATES as readonly string[]).includes(state))
      throw new Error();
    report[kind] = state as CompositionReadinessState;
  }
  return Object.freeze(report);
}

function readinessDiagnostics(
  readiness: CompositionReadinessReport,
): readonly CompositionReadinessDiagnostic[] {
  return Object.freeze(
    READINESS_KINDS.flatMap((kind) => {
      const state = readiness[kind];
      return state === 'ready'
        ? []
        : [Object.freeze({ kind, state }) as CompositionReadinessDiagnostic];
    }),
  );
}

function assertIsolatedCompositionFrame(
  frame: unknown,
  compositionId: string,
  outputTimeUs: number,
  options: NormalizedCompositionObserverOptions,
): asserts frame is RenderFrameIR {
  if (
    !isPlainRecord(frame) ||
    !hasOnlyKeys(
      frame,
      ['version', 'compositionId', 'timeUs', 'viewport', 'background', 'nodes', 'colorGrade'],
      ['version', 'compositionId', 'timeUs', 'viewport', 'background', 'nodes'],
    )
  )
    throw new Error();
  const renderFrame = frame as unknown as RenderFrameIR;
  validateRenderFrameIR(renderFrame);
  if (renderFrame.compositionId !== compositionId || renderFrame.timeUs !== outputTimeUs)
    throw new Error();
  const renderWidth = Math.ceil(renderFrame.viewport.width * renderFrame.viewport.dpr);
  const renderHeight = Math.ceil(renderFrame.viewport.height * renderFrame.viewport.dpr);
  const renderPixels = renderWidth * renderHeight;
  const renderBytes = renderPixels * 4;
  if (
    !Number.isSafeInteger(renderWidth) ||
    !Number.isSafeInteger(renderHeight) ||
    !Number.isSafeInteger(renderPixels) ||
    !Number.isSafeInteger(renderBytes) ||
    renderPixels > options.maxPixels ||
    renderBytes > options.maxReadbackBytes
  )
    throw new RenderSurfaceTooLargeError();
}

function normalizeReadback(
  value: unknown,
  options: NormalizedCompositionObserverOptions,
): NormalizedReadback {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ['width', 'height', 'data', 'dispose'], ['width', 'height', 'data'])
  )
    throw new Error();
  const width = dataValue(value, 'width');
  const height = dataValue(value, 'height');
  if (
    typeof width !== 'number' ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    typeof height !== 'number' ||
    !Number.isSafeInteger(height) ||
    height < 1
  )
    throw new Error();
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > options.maxPixels)
    throw new ReadbackTooLargeError();
  const expectedBytes = pixels * 4;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > options.maxReadbackBytes)
    throw new ReadbackTooLargeError();
  const data = dataValue(value, 'data');
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) throw new Error();
  if (data.byteLength !== expectedBytes) throw new Error();
  const dispose = optionalDataValue(value, 'dispose');
  if (dispose !== undefined && typeof dispose !== 'function') throw new Error();
  return Object.freeze({
    width,
    height,
    rgba: Uint8Array.from(data),
  });
}

function disposeReadback(value: unknown): void {
  if (!isPlainRecord(value)) return;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'dispose');
  if (
    descriptor === undefined ||
    !('value' in descriptor) ||
    typeof descriptor.value !== 'function'
  )
    return;
  try {
    descriptor.value();
  } catch {
    // A cleanup error is deliberately not observable evidence or a reason to
    // publish a capture that otherwise failed/cancelled.
  }
}

function cloneFrozenSnapshotValue(value: unknown): CompositionSnapshotValue {
  const seen = new WeakSet<object>();
  const budget = { nodes: 0 };
  return cloneSnapshotValue(value, seen, budget, 0);
}

function cloneSnapshotValue(
  value: unknown,
  seen: WeakSet<object>,
  budget: { nodes: number },
  depth: number,
): CompositionSnapshotValue {
  if (depth > MAX_SNAPSHOT_DEPTH) throw new Error();
  budget.nodes += 1;
  if (budget.nodes > MAX_SNAPSHOT_NODES) throw new Error();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error();
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_SNAPSHOT_STRING_LENGTH) throw new Error();
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_SNAPSHOT_OBJECT_KEYS || seen.has(value)) throw new Error();
    const names = Object.getOwnPropertyNames(value);
    if (
      Object.getOwnPropertySymbols(value).length > 0 ||
      names.length !== value.length + 1 ||
      !names.includes('length')
    )
      throw new Error();
    seen.add(value);
    const copy: CompositionSnapshotValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor))
        throw new Error();
      copy.push(cloneSnapshotValue(descriptor.value, seen, budget, depth + 1));
    }
    return Object.freeze(copy);
  }
  if (!isPlainRecord(value) || seen.has(value)) throw new Error();
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length > 0 || names.length > MAX_SNAPSHOT_OBJECT_KEYS)
    throw new Error();
  seen.add(value);
  const copy = Object.create(null) as Record<string, CompositionSnapshotValue>;
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor))
      throw new Error();
    Object.defineProperty(copy, key, {
      value: cloneSnapshotValue(descriptor.value, seen, budget, depth + 1),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(copy);
}

function boundedPositiveSafeInteger(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error();
  return value;
}

function isOpaqueVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:=-]{0,255}$/.test(value);
}

function isAbortSignal(value: unknown): value is AbortSignal | undefined {
  return (
    value === undefined ||
    (value !== null &&
      typeof value === 'object' &&
      typeof (value as AbortSignal).aborted === 'boolean' &&
      typeof (value as AbortSignal).addEventListener === 'function' &&
      typeof (value as AbortSignal).removeEventListener === 'function')
  );
}

function cancelled(): CompositionCaptureCancelled {
  return Object.freeze({ status: 'cancelled' as const });
}

function failed(code: CompositionCaptureFailureCode): CompositionCaptureFailure {
  return Object.freeze({ status: 'failed' as const, code });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  )
    throw new Error();
  return descriptor.value;
}

function optionalDataValue(value: Record<string, unknown>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  return dataValue(value, key);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)];
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const actual = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)];
  return (
    actual.every((key) => typeof key === 'string' && allowed.includes(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
