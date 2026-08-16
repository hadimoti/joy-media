/** Browser-safe audio timeline clock; Worker-only hashing/export stays in audio-core. */
class AudioPreviewClock {
  #timeUs = 0;

  constructor(readonly sampleRate: number) {
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 1)
      throw new RangeError('sampleRate must be a positive integer');
  }

  get timeUs(): number {
    return this.#timeUs;
  }

  get sampleIndex(): number {
    return Number((BigInt(this.#timeUs) * BigInt(this.sampleRate)) / 1_000_000n);
  }

  seek(timeUs: number): number {
    if (!Number.isSafeInteger(timeUs) || timeUs < 0)
      throw new RangeError('timeUs must be a non-negative safe integer');
    this.#timeUs = timeUs;
    return this.sampleIndex;
  }

  advance(deltaUs: number): void {
    this.#timeUs += deltaUs;
  }
}

export type { FrameDecoder, MediaSource } from './decoder.js';
export { requestDecodedFrame, selectDecodeSource } from './decoder.js';
export type { HtmlMediaDecoder, HtmlVideoElementLike } from './html-decoder.js';
export { createHtmlMediaDecoder } from './html-decoder.js';
export { sourceTimeAtPlayhead } from './source-time.js';
export {
  PlaybackDiagnosticsSession,
  type PlaybackDiagnosticsSnapshot,
  type PlaybackSourceQuality,
  type VideoFramePresentationMetadata,
} from './diagnostics.js';
export {
  importedClipToMediaSource,
  videoFrameNodeFromDecoded,
  withVideoFrameNodes,
  withVideoFrameNode,
  type VideoClipSpec,
} from './video-frame-node.js';
import type { ImageDataLike } from './image-data.js';
export type { ImageDataLike } from './image-data.js';

export interface DecodedFrame {
  readonly assetId: string;
  readonly sourceTimeUs: number;
  readonly token: string;
  readonly bitmap?: ImageDataLike;
}

export class FrameCache {
  readonly #entries = new Map<string, DecodedFrame>();
  constructor(private readonly limit = 60) {}
  get(assetId: string, sourceTimeUs: number): DecodedFrame | undefined {
    const key = `${assetId}:${sourceTimeUs}`;
    const value = this.#entries.get(key);
    if (value !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }
  put(frame: DecodedFrame): void {
    const key = `${frame.assetId}:${frame.sourceTimeUs}`;
    this.#entries.set(key, frame);
    while (this.#entries.size > this.limit)
      this.#entries.delete(this.#entries.keys().next().value!);
  }
}

/**
 * Media clock interface for real-time clock sources (e.g. HTMLVideoElement).
 * Time is in microseconds, monotonic from media start.
 */
export interface MediaClock {
  readonly timeUs: number;
  set(timeUs: number): void;
}

/**
 * Create a MediaClock backed by an HTMLVideoElement.
 * `video.currentTime` is in seconds; we convert to µs.
 * Optional `readTimeUs` override allows tests to inject a deterministic time source.
 */
export function createHtmlVideoMediaClock(
  video: HTMLVideoElement,
  readTimeUs?: () => number,
): MediaClock {
  return {
    get timeUs(): number {
      if (readTimeUs) return readTimeUs();
      return Math.floor(video.currentTime * 1_000_000);
    },
    set(timeUs: number): void {
      video.currentTime = timeUs / 1_000_000;
    },
  };
}

export interface PlaybackTick {
  readonly generation: number;
  readonly onTime: boolean;
  readonly driftUs: number;
  readonly decoded: boolean;
  readonly dropped: boolean;
}

export interface PlaybackSchedulerOptions {
  /**
   * Maximum drift (in µs) between the media clock and the scheduler's
   * audio time before a frame is considered late.
   * Defaults to one frame at 30 fps (33 333 µs), matching the WP-11.3 exit criterion.
   */
  readonly driftToleranceUs?: number;
}

export class PlaybackScheduler {
  readonly audio: AudioPreviewClock;
  readonly driftToleranceUs: number;
  #generation = 0;
  #droppedFrames = 0;
  #decodedFrames = 0;
  #maxDriftUs = 0;
  #tickIndex = 0;

  constructor(sampleRate = 48_000, options: PlaybackSchedulerOptions = {}) {
    this.audio = new AudioPreviewClock(sampleRate);
    this.driftToleranceUs = options.driftToleranceUs ?? 33_333;
  }

  seek(timeUs: number): number {
    this.#generation++;
    this.#tickIndex = 0;
    return this.audio.seek(timeUs);
  }

  requestToken(): number {
    return this.#generation;
  }

  /**
   * Legacy token-based accept. Kept for backwards compatibility; the
   * `decoded` flag is fixed to `true` here so callers that pre-date
   * WP-11.3 keep the old behaviour. New callers should use
   * {@link recordDecodedFrame} with an explicit decode result.
   */
  acceptFrame(token: number, onTime: boolean): boolean {
    return this.recordDecodedFrame(token, true, onTime);
  }

  /**
   * Record a frame decode against the active generation. Unlike the legacy
   * `acceptFrame`, this method requires an explicit `decoded` flag so
   * `decodedFrames` only increments when real decode work succeeded.
   * Returns `false` if the token is stale (seek happened mid-decode).
   */
  recordDecodedFrame(token: number, decoded: boolean, onTime: boolean): boolean {
    if (token !== this.#generation) return false;
    if (decoded) this.#decodedFrames++;
    if (!onTime || !decoded) this.#droppedFrames++;
    return true;
  }

  /**
   * Drift (in µs) between a real media clock and the scheduler's audio
   * time. Positive means the clock is ahead of the scheduler; negative
   * means the scheduler is ahead of the clock.
   */
  driftFrom(clock: MediaClock): number {
    return clock.timeUs - this.audio.timeUs;
  }

  /**
   * Drive one tick of the scheduler from a real media clock. The scheduler
   * advances its internal audio time by one frame interval, evaluates drift
   * against the clock, and reports whether the frame is on time and whether
   * real decode work succeeded. The caller is responsible for issuing the
   * actual decode and passing its result via `decoded`.
   *
   * @param clock real-time media clock (e.g. `HTMLVideoElement.currentTime`)
   * @param decoded whether the decode call for this tick succeeded
   * @param intervalUs frame interval in µs (default = 33 333 µs = 1/30 s)
   */
  driveTick(clock: MediaClock, decoded: boolean, intervalUs = 33_333): PlaybackTick {
    this.#tickIndex++;
    this.audio.advance(intervalUs);
    const driftUs = this.driftFrom(clock);
    this.#maxDriftUs = Math.max(this.#maxDriftUs, Math.abs(driftUs));
    const onTime = Math.abs(driftUs) <= this.driftToleranceUs;
    const dropped = !onTime || !decoded;
    if (decoded) this.#decodedFrames++;
    if (dropped) this.#droppedFrames++;
    return {
      generation: this.#generation,
      onTime,
      driftUs,
      decoded,
      dropped,
    };
  }

  /** Advance the scheduler's audio clock directly (for testing/seek simulation). */
  advanceAudio(deltaUs: number): void {
    this.audio.advance(deltaUs);
  }

  get tickIndex(): number {
    return this.#tickIndex;
  }

  get droppedFrames(): number {
    return this.#droppedFrames;
  }

  get metrics(): {
    readonly decodedFrames: number;
    readonly droppedFrames: number;
    /** Largest observed absolute media/audio drift since construction. */
    readonly maxDriftUs: number;
    readonly quality: 'full' | 'proxy';
  } {
    return {
      decodedFrames: this.#decodedFrames,
      droppedFrames: this.#droppedFrames,
      maxDriftUs: this.#maxDriftUs,
      quality: this.quality(),
    };
  }

  quality(): 'full' | 'proxy' {
    return this.#droppedFrames >= 3 ? 'proxy' : 'full';
  }
}
