import {
  assertFrameIdentity,
  frameIdentityKey,
  type FrameIdentity,
} from '@joy-media/media-core/observation';
import type { ObservationResourceScheduler } from './resource-scheduler.js';
import { type ObservationResourceLease } from './resource-scheduler.js';

let nextLeaseSequence = 0;

/** The narrow portion of a decoded browser sample which JOY retains. */
export interface BrowserVideoSampleLike {
  readonly microsecondTimestamp: number;
  readonly microsecondDuration: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  /**
   * Optional pixel draw bridge supplied by the real browser decoder. Keeping
   * it optional lets the identity/resource layer remain testable without a
   * canvas implementation, while callers fail closed if the decoder cannot
   * materialize visual evidence.
   */
  draw?(
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dx: number,
    dy: number,
    dWidth?: number,
    dHeight?: number,
  ): void;
  close(): void;
}

export interface ObservationThumbnailOptions {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxBytes: number;
  readonly mimeType?: 'image/jpeg' | 'image/png';
  readonly quality?: number;
}

export interface ObservationThumbnail {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  readonly mimeType: 'image/jpeg' | 'image/png';
}

export interface SourceObservationFrame {
  readonly id: string;
  readonly identity: FrameIdentity;
  readonly actualTimeUs: number;
  readonly presentationIndex: number;
  readonly width: number;
  readonly height: number;
  readonly durationUs: number;
  /**
   * Creates a bounded visual artifact while this frame is still leased. The
   * caller must not retain raw decoder samples or a full-size RGBA clip.
   */
  createThumbnail(options: ObservationThumbnailOptions): Promise<ObservationThumbnail>;
  /** Releases the decoder sample and this frame's owned working-set lease. */
  close(): void;
}

export interface CreateSourceObservationFrameOptions {
  readonly assetDigest: string;
  readonly streamId: string;
  readonly presentationIndex: number;
  readonly sample: BrowserVideoSampleLike;
  readonly scheduler: ObservationResourceScheduler;
  readonly epoch: number;
}

export class ObservationResourceBackpressureError extends Error {
  readonly code = 'JOY_OBSERVATION_BACKPRESSURE' as const;

  constructor(readonly reason: 'working-set-budget' | 'in-flight-budget' | 'playback-priority') {
    super(`Observation decoding is paused by ${reason}`);
    this.name = 'ObservationResourceBackpressureError';
  }
}

export class ObservationSampleError extends Error {
  readonly code = 'JOY_OBSERVATION_INVALID_SAMPLE' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ObservationSampleError';
  }
}

export class ObservationThumbnailError extends Error {
  readonly code:
    | 'unsupported-artifact'
    | 'invalid-thumbnail-options'
    | 'frame-closed'
    | 'artifact-too-large'
    | 'artifact-failed';

  constructor(
    code:
      | 'unsupported-artifact'
      | 'invalid-thumbnail-options'
      | 'frame-closed'
      | 'artifact-too-large'
      | 'artifact-failed',
    message: string,
  ) {
    super(message);
    this.name = 'ObservationThumbnailError';
    this.code = code;
  }
}

/**
 * Upper-bound both the decoded RGBA frame and one transferable copy. This is
 * deliberately conservative: compressed input bytes are not counted as the
 * decoded working set used for live observation scheduling.
 */
export function estimateObservationFrameWorkingSetBytes(width: number, height: number): number {
  assertDimension(width, 'width');
  assertDimension(height, 'height');
  const rgbaBytes = width * height * 4;
  const ownedBytes = rgbaBytes * 2;
  if (!Number.isSafeInteger(ownedBytes))
    throw new ObservationSampleError('decoded frame working set exceeds the safe integer range');
  return ownedBytes;
}

/**
 * Adapts an actual browser decoder sample into an opaque, timestamped JOY
 * observation. It never uses requested time as evidence: identity is derived
 * only from the decoder's actual presentation timestamp.
 */
export function createSourceObservationFrame(
  options: CreateSourceObservationFrameOptions,
): SourceObservationFrame {
  let closed = false;
  let lease: ObservationResourceLease | undefined;
  const closeSample = (): void => {
    if (closed) return;
    closed = true;
    try {
      options.sample.close();
    } finally {
      lease?.release();
    }
  };

  try {
    assertNonNegativeSafeInteger(options.presentationIndex, 'presentationIndex');
    assertNonNegativeSafeInteger(options.epoch, 'epoch');
    const actualTimeUs = options.sample.microsecondTimestamp;
    const durationUs = options.sample.microsecondDuration;
    assertNonNegativeSafeInteger(actualTimeUs, 'sample.microsecondTimestamp');
    assertNonNegativeSafeInteger(durationUs, 'sample.microsecondDuration');
    const width = options.sample.displayWidth;
    const height = options.sample.displayHeight;
    const bytes = estimateObservationFrameWorkingSetBytes(width, height);
    const identity: FrameIdentity = {
      assetDigest: options.assetDigest,
      streamId: options.streamId,
      presentationIndex: options.presentationIndex,
      // Mediabunny exposes actual decoder PTS normalized to integer µs. This
      // is intentionally recorded as a browser-normalized 1/1,000,000 base;
      // no container timebase is invented or inferred from nominal FPS.
      ptsTicks: String(actualTimeUs),
      timebaseNumerator: 1,
      timebaseDenominator: 1_000_000,
      sourceTimeUs: actualTimeUs,
      durationUs,
    };
    assertFrameIdentity(identity);
    const id = frameIdentityKey(identity);
    const decision = options.scheduler.tryAcquire({
      id: leaseId(options.epoch, id),
      bytes,
      epoch: options.epoch,
      priority: 'background',
    });
    if (decision.state === 'backpressure')
      throw new ObservationResourceBackpressureError(decision.reason);
    lease = decision;
    return {
      id,
      identity,
      actualTimeUs,
      presentationIndex: options.presentationIndex,
      width,
      height,
      durationUs,
      createThumbnail: async (thumbnailOptions) => {
        if (closed)
          throw new ObservationThumbnailError(
            'frame-closed',
            'A visual artifact cannot be created after its source frame is released.',
          );
        return createObservationThumbnail(options.sample, width, height, thumbnailOptions);
      },
      close: closeSample,
    };
  } catch (error) {
    closeSample();
    throw error;
  }
}

/**
 * Materializes a small JPEG/PNG only while the VideoSample is owned. The
 * dedicated worker transfers this Blob, never the decoder's full-resolution
 * frame or a source URL. Canvas dimensions are caller-bounded before any
 * additional pixel buffer is allocated.
 */
async function createObservationThumbnail(
  sample: BrowserVideoSampleLike,
  sourceWidth: number,
  sourceHeight: number,
  options: ObservationThumbnailOptions,
): Promise<ObservationThumbnail> {
  assertThumbnailOptions(options);
  if (typeof sample.draw !== 'function' || typeof OffscreenCanvas === 'undefined')
    throw new ObservationThumbnailError(
      'unsupported-artifact',
      'This browser decoder cannot materialize a local visual evidence artifact.',
    );

  const scale = Math.min(1, options.maxWidth / sourceWidth, options.maxHeight / sourceHeight);
  const width = Math.max(1, Math.floor(sourceWidth * scale));
  const height = Math.max(1, Math.floor(sourceHeight * scale));
  let canvas: OffscreenCanvas;
  let context: OffscreenCanvasRenderingContext2D | null;
  try {
    canvas = new OffscreenCanvas(width, height);
    context = canvas.getContext('2d', { alpha: false });
    if (context === null)
      throw new ObservationThumbnailError(
        'unsupported-artifact',
        'This browser worker does not provide a 2D canvas for visual evidence.',
      );
    sample.draw(context, 0, 0, width, height);
    const mimeType = options.mimeType ?? 'image/jpeg';
    const blob = await canvas.convertToBlob({ type: mimeType, quality: options.quality ?? 0.82 });
    if (blob.size < 1 || blob.size > options.maxBytes)
      throw new ObservationThumbnailError(
        'artifact-too-large',
        'The bounded visual evidence artifact exceeded its byte budget.',
      );
    return { blob, width, height, mimeType };
  } catch (error) {
    if (error instanceof ObservationThumbnailError) throw error;
    throw new ObservationThumbnailError(
      'artifact-failed',
      'The browser could not materialize this visual evidence artifact.',
    );
  }
}

function leaseId(epoch: number, frameId: string): string {
  // Scheduler IDs need only be local resource leases, not evidence identity.
  // A process-local sequence avoids hash collisions between simultaneous
  // streams while the complete frame identity remains on the public object.
  if (nextLeaseSequence >= Number.MAX_SAFE_INTEGER) nextLeaseSequence = 0;
  nextLeaseSequence += 1;
  return `obs-${epoch}-${nextLeaseSequence}-${frameId.length}`;
}

function assertDimension(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new ObservationSampleError(`${label} must be a positive safe integer`);
}

function assertThumbnailOptions(options: ObservationThumbnailOptions): void {
  if (
    !Number.isSafeInteger(options.maxWidth) ||
    !Number.isSafeInteger(options.maxHeight) ||
    options.maxWidth < 1 ||
    options.maxHeight < 1 ||
    options.maxWidth > 2_048 ||
    options.maxHeight > 2_048 ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > 8 * 1024 * 1024 ||
    (options.mimeType !== undefined &&
      options.mimeType !== 'image/jpeg' &&
      options.mimeType !== 'image/png') ||
    (options.quality !== undefined &&
      (!Number.isFinite(options.quality) || options.quality < 0 || options.quality > 1))
  )
    throw new ObservationThumbnailError(
      'invalid-thumbnail-options',
      'Visual evidence bounds must be finite and within the local worker limits.',
    );
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ObservationSampleError(`${label} must be a non-negative safe integer`);
}
