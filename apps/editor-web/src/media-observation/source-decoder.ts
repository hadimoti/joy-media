import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny';
import {
  createSourceObservationFrame,
  ObservationResourceBackpressureError,
  ObservationSampleError,
  type SourceObservationFrame,
} from './browser-sample-decoder.js';
import type { ObservationResourceScheduler } from './resource-scheduler.js';

export interface SourceObservationRange {
  readonly startUs: number;
  readonly endUs: number;
}

export interface SourceObservationDecoder {
  frames(range: SourceObservationRange, signal: AbortSignal): AsyncIterable<SourceObservationFrame>;
  close(): void;
}

export interface BrowserSourceObservationDecoderOptions {
  /** Content digest supplied by the trusted asset resolver; never a path or URL. */
  readonly assetDigest: string;
  /** Opaque trusted stream identifier. */
  readonly streamId: string;
  /** Original or proxy bytes chosen by the trusted host, never model-supplied. */
  readonly source: Blob;
  readonly scheduler: ObservationResourceScheduler;
  readonly epoch: number;
  /** Separate bounded compressed-byte cache used by Mediabunny's Blob source. */
  readonly maxSourceCacheBytes?: number;
}

export type SourceObservationDecodeFailureCode =
  | 'cancelled'
  | 'closed'
  | 'invalid-range'
  | 'missing-video-track'
  | 'unsupported-codec'
  | 'backpressure'
  | 'decode-failed';

/** A structured, source-redacted failure returned by the browser observation tier. */
export class SourceObservationDecodeError extends Error {
  constructor(
    readonly code: SourceObservationDecodeFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'SourceObservationDecodeError';
  }
}

/**
 * Streams presentation-order frames from a dedicated Mediabunny input. It
 * never seeks or reads the Monitor's HTMLVideoElement, and it closes every
 * sample even if a consumer abandons an async iterator mid-frame.
 */
export class BrowserSourceObservationDecoder implements SourceObservationDecoder {
  readonly #inputs = new Set<Input>();
  readonly #options: Required<Pick<BrowserSourceObservationDecoderOptions, 'maxSourceCacheBytes'>> &
    Omit<BrowserSourceObservationDecoderOptions, 'maxSourceCacheBytes'>;
  #closed = false;

  constructor(options: BrowserSourceObservationDecoderOptions) {
    assertOptions(options);
    this.#options = {
      ...options,
      maxSourceCacheBytes: options.maxSourceCacheBytes ?? 8 * 1024 * 1024,
    };
  }

  async *frames(
    range: SourceObservationRange,
    signal: AbortSignal,
  ): AsyncGenerator<SourceObservationFrame, void, undefined> {
    assertRange(range);
    this.#assertOpen();
    if (signal.aborted) throw cancelledError();

    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(this.#options.source, {
        maxCacheSize: this.#options.maxSourceCacheBytes,
      }),
    });
    this.#inputs.add(input);
    const abort = () => input.dispose();
    signal.addEventListener('abort', abort, { once: true });

    try {
      const videoTrack = await input.getPrimaryVideoTrack();
      if (videoTrack === null)
        throw new SourceObservationDecodeError(
          'missing-video-track',
          'This media has no video track available for source observation.',
        );
      if (!(await videoTrack.canDecode()))
        throw new SourceObservationDecodeError(
          'unsupported-codec',
          'This video codec is not supported by the current browser for source observation.',
        );

      const sink = new VideoSampleSink(videoTrack);
      let presentationIndex = 0;
      // Enumerating from the stream origin gives every returned frame its real
      // presentation index. O3 can add a cached index for faster sparse focus;
      // this base adapter favors truthful identities over request-order IDs.
      for await (const nativeSample of sink.samples()) {
        const sample = closeOnce(nativeSample);
        const currentPresentationIndex = presentationIndex;
        presentationIndex += 1;
        let frame: SourceObservationFrame | undefined;
        try {
          throwIfAborted(signal);
          const actualTimeUs = nativeSample.microsecondTimestamp;
          const durationUs = nativeSample.microsecondDuration;
          assertSampleTiming(actualTimeUs, durationUs);
          if (actualTimeUs >= range.endUs) break;
          if (!intersectsRequestedRange(actualTimeUs, durationUs, range)) continue;
          frame = createSourceObservationFrame({
            assetDigest: this.#options.assetDigest,
            streamId: this.#options.streamId,
            presentationIndex: currentPresentationIndex,
            sample,
            scheduler: this.#options.scheduler,
            epoch: this.#options.epoch,
          });
          yield frame;
        } finally {
          // A yielded frame is only valid until the caller advances/returns the
          // iterator. Consumers can close it earlier; both paths are idempotent.
          frame?.close();
          if (frame === undefined) sample.close();
        }
      }
    } catch (error) {
      if (signal.aborted) throw cancelledError();
      if (this.#closed) {
        throw new SourceObservationDecodeError(
          'closed',
          'Source observation was closed before its frame scan completed.',
        );
      }
      if (error instanceof ObservationResourceBackpressureError) {
        throw new SourceObservationDecodeError(
          'backpressure',
          'Source observation is paused until enough local decode memory is available.',
        );
      }
      if (error instanceof SourceObservationDecodeError || error instanceof ObservationSampleError)
        throw error;
      throw new SourceObservationDecodeError(
        'decode-failed',
        'The browser could not decode this source for frame observation.',
      );
    } finally {
      signal.removeEventListener('abort', abort);
      input.dispose();
      this.#inputs.delete(input);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const input of this.#inputs) input.dispose();
    this.#inputs.clear();
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new SourceObservationDecodeError(
        'closed',
        'Source observation decoder is already closed.',
      );
  }
}

export function createBrowserSourceObservationDecoder(
  options: BrowserSourceObservationDecoderOptions,
): SourceObservationDecoder {
  return new BrowserSourceObservationDecoder(options);
}

function closeOnce(sample: {
  readonly microsecondTimestamp: number;
  readonly microsecondDuration: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  draw?(
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dx: number,
    dy: number,
    dWidth?: number,
    dHeight?: number,
  ): void;
  close(): void;
}) {
  let closed = false;
  const value = {
    microsecondTimestamp: sample.microsecondTimestamp,
    microsecondDuration: sample.microsecondDuration,
    displayWidth: sample.displayWidth,
    displayHeight: sample.displayHeight,
    close: () => {
      if (closed) return;
      closed = true;
      sample.close();
    },
  };
  const draw = sample.draw;
  if (typeof draw !== 'function') return value;
  return {
    ...value,
    draw: (
      context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
      dx: number,
      dy: number,
      dWidth?: number,
      dHeight?: number,
    ) => draw.call(sample, context, dx, dy, dWidth, dHeight),
  };
}

function assertOptions(options: BrowserSourceObservationDecoderOptions): void {
  if (!(options.source instanceof Blob)) throw new TypeError('source must be a browser Blob');
  if (!Number.isSafeInteger(options.epoch) || options.epoch < 0)
    throw new RangeError('epoch must be a non-negative safe integer');
  if (
    options.maxSourceCacheBytes !== undefined &&
    (!Number.isSafeInteger(options.maxSourceCacheBytes) || options.maxSourceCacheBytes < 1)
  )
    throw new RangeError('maxSourceCacheBytes must be a positive safe integer');
}

function assertRange(range: SourceObservationRange): void {
  if (
    !Number.isSafeInteger(range.startUs) ||
    !Number.isSafeInteger(range.endUs) ||
    range.startUs < 0 ||
    range.endUs <= range.startUs
  )
    throw new SourceObservationDecodeError(
      'invalid-range',
      'Source observation range must be a non-empty, non-negative half-open interval.',
    );
}

function assertSampleTiming(actualTimeUs: number, durationUs: number): void {
  if (
    !Number.isSafeInteger(actualTimeUs) ||
    !Number.isSafeInteger(durationUs) ||
    actualTimeUs < 0 ||
    durationUs < 0 ||
    actualTimeUs + durationUs > Number.MAX_SAFE_INTEGER
  )
    throw new ObservationSampleError(
      'The browser decoder returned an unsupported timestamp or duration.',
    );
}

function intersectsRequestedRange(
  actualTimeUs: number,
  durationUs: number,
  range: SourceObservationRange,
): boolean {
  if (durationUs === 0) return actualTimeUs >= range.startUs && actualTimeUs < range.endUs;
  return actualTimeUs < range.endUs && actualTimeUs + durationUs > range.startUs;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancelledError();
}

function cancelledError(): SourceObservationDecodeError {
  return new SourceObservationDecodeError('cancelled', 'Source observation was cancelled.');
}
