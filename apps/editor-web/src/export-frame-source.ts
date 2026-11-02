import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from 'mediabunny';
import type { DecodedFrame } from '@joy-media/playback-engine';
import {
  createSequentialFrameCursor,
  type CursorFrame,
  type SequentialFrameCursor,
} from './sequential-frame-cursor.js';

/**
 * Source frames for an export, decoded forward-only instead of by seeking a video element.
 *
 * `frameAt` answers with the frame on screen at a source time. It resolves `undefined` when this
 * clip should be served another way (the source times jump around too much, the decoder failed or
 * stalled), and the caller then falls back to seeking a video element for that clip. It rejects
 * with an AbortError when `signal` aborts, after stopping the decoder.
 */
export interface ExportFrameSource {
  frameAt(
    sourceUs: number,
    requestToken: number,
    signal?: AbortSignal,
  ): Promise<DecodedFrame | undefined>;
  /** Width and height of the frames, after rotation, once the first one has been served. */
  readonly size: () => { readonly width: number; readonly height: number };
  /** Frees the decoder of a clip that has ended; a later request reopens it. */
  release(): void;
  close(): void;
}

export interface OpenExportFrameSourceOptions {
  /**
   * The longest one frame may take to decode before the clip is handed back to the seeking path.
   * The seeking path gives each seek the same 15 seconds (`EXPORT_PRELOAD_TIMEOUT_MS`).
   */
  readonly decodeTimeoutMs?: number;
}

/** Compressed bytes the Blob reader keeps in memory; the clip itself is already held as a Blob. */
const SOURCE_CACHE_BYTES = 16 * 1024 * 1024;
/** A transition makes the incoming clip snap back once; a clip that jumps more often is seeked. */
const MAX_RESTARTS = 16;
/** Past this gap, jumping to the nearest keyframe is cheaper than decoding every frame between. */
const MAX_FORWARD_GAP_US = 8_000_000;
const DEFAULT_DECODE_TIMEOUT_MS = 15_000;

interface DecodedSample extends CursorFrame {
  readonly sample: VideoSample;
}

const decodeTimedOut = Symbol('decode timed out');

/**
 * Opens `blob` for forward decoding, or resolves `undefined` when it cannot: no video track, a
 * codec this browser cannot decode, or any failure while opening. The export then keeps using
 * the seeking path, so a clip that worked before still works.
 */
export async function openExportFrameSource(
  blob: Blob,
  assetId: string,
  options: OpenExportFrameSourceOptions = {},
): Promise<ExportFrameSource | undefined> {
  if (typeof document === 'undefined' || typeof VideoDecoder === 'undefined') return undefined;
  const decodeTimeoutMs = options.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS;
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(blob, { maxCacheSize: SOURCE_CACHE_BYTES }),
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (track === null || !(await track.canDecode())) {
      input.dispose();
      return undefined;
    }
    const sink = new VideoSampleSink(track);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (context === null) {
      input.dispose();
      return undefined;
    }
    let closed = false;
    let failed = false;
    const cursor: SequentialFrameCursor<DecodedSample> = createSequentialFrameCursor(
      (startUs): AsyncIterator<DecodedSample> => {
        const samples = sink.samples(startUs / 1_000_000);
        return {
          next: async () => {
            const result = await samples.next();
            if (result.done === true) return { done: true, value: undefined };
            const sample = result.value;
            return {
              done: false,
              value: {
                sample,
                timestampUs: sample.microsecondTimestamp,
                close: () => sample.close(),
              },
            };
          },
          return: async () => {
            await samples.return(undefined);
            return { done: true, value: undefined };
          },
        };
      },
      { maxRestarts: MAX_RESTARTS, maxForwardGapUs: MAX_FORWARD_GAP_US },
    );
    const close = () => {
      if (closed) return;
      closed = true;
      cursor.close();
      input.dispose();
      canvas.width = 0;
      canvas.height = 0;
    };
    const decode = async (
      sourceUs: number,
      requestToken: number,
    ): Promise<DecodedFrame | undefined> => {
      const frame = await cursor.frameAt(sourceUs);
      if (frame === undefined) return undefined;
      const width = Math.max(1, Math.round(frame.sample.displayWidth));
      const height = Math.max(1, Math.round(frame.sample.displayHeight));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      // A transparent frame must not show the previous one through it.
      context.clearRect(0, 0, width, height);
      frame.sample.draw(context, 0, 0, width, height);
      return {
        assetId,
        sourceTimeUs: sourceUs,
        token: `html-media:${requestToken}`,
        bitmap: context.getImageData(0, 0, width, height),
      };
    };
    return {
      async frameAt(sourceUs, requestToken, signal) {
        if (failed) return undefined;
        if (signal?.aborted === true) {
          close();
          throw new DOMException('Export cancelled', 'AbortError');
        }
        const decoding = decode(sourceUs, requestToken);
        let onAbort: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const interrupted = new Promise<typeof decodeTimedOut | 'aborted'>((resolve) => {
          timer = setTimeout(() => resolve(decodeTimedOut), decodeTimeoutMs);
          onAbort = () => resolve('aborted');
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        try {
          const outcome = await Promise.race([decoding, interrupted]);
          if (outcome === 'aborted') {
            // The decoder may be stuck mid-frame, so stop it now instead of waiting for cleanup.
            close();
            void decoding.catch(() => undefined);
            throw new DOMException('Export cancelled', 'AbortError');
          }
          if (outcome === decodeTimedOut) {
            failed = true;
            close();
            void decoding.catch(() => undefined);
            console.warn(
              `Export: decoding ${assetId} stalled for ${decodeTimeoutMs} ms; seeking a video element instead.`,
            );
            return undefined;
          }
          return outcome;
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          // The decoder can fail after it opened (a stream WebCodecs rejects half way, a codec
          // `canDecode` promised but the hardware refused). The export carries on by seeking.
          if (!closed) {
            failed = true;
            console.warn(
              `Export: forward decoding of ${assetId} failed; seeking a video element instead.`,
              error,
            );
          }
          return undefined;
        } finally {
          clearTimeout(timer);
          if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
        }
      },
      size: () => ({ width: canvas.width, height: canvas.height }),
      release: () => cursor.release(),
      close,
    };
  } catch {
    input.dispose();
    return undefined;
  }
}
