/**
 * Playback diagnostics are deliberately session-scoped. The editor can seek,
 * switch clips, or change projects without allowing an old counter to make a
 * new session look unhealthy.
 */

export type PlaybackSourceQuality = 'full' | 'proxy' | 'missing';

export interface VideoFramePresentationMetadata {
  /** Media time reported by requestVideoFrameCallback, in seconds. */
  readonly mediaTime: number;
  /** Monotonic presented-frame counter reported by the browser. */
  readonly presentedFrames: number;
  /** Expected presentation timestamp, in the browser's monotonic timebase. */
  readonly expectedDisplayTime: number;
}

export interface PlaybackDiagnosticsSnapshot {
  readonly sessionId: number;
  readonly clipId: string | undefined;
  readonly sourceQuality: PlaybackSourceQuality;
  readonly decodedFrames: number;
  readonly droppedFrames: number;
  readonly presentationFrames: number;
  readonly presentationDrops: number;
  readonly decodeMisses: number;
  readonly callbackLatenessUs: number;
  readonly p50DriftUs: number;
  readonly p95DriftUs: number;
  readonly maxDriftUs: number;
  readonly stalls: number;
  readonly maxStallUs: number;
  readonly quality: PlaybackSourceQuality;
}

export class PlaybackDiagnosticsSession {
  #sessionId = 0;
  #clipId: string | undefined;
  #sourceQuality: PlaybackSourceQuality = 'missing';
  #decodedFrames = 0;
  #presentationFrames = 0;
  #presentationDrops = 0;
  #decodeMisses = 0;
  #callbackLatenessUs = 0;
  #driftsUs: number[] = [];
  #stalls = 0;
  #maxStallUs = 0;
  #lastPresentedFrames: number | undefined;
  #stallStartedAtUs: number | undefined;

  /** Start a new measurement window, normally after a clip switch or seek. */
  start(clipId: string | undefined, sourceQuality: PlaybackSourceQuality): number {
    this.#sessionId += 1;
    this.#clipId = clipId;
    this.#sourceQuality = sourceQuality;
    this.#decodedFrames = 0;
    this.#presentationFrames = 0;
    this.#presentationDrops = 0;
    this.#decodeMisses = 0;
    this.#callbackLatenessUs = 0;
    this.#driftsUs = [];
    this.#stalls = 0;
    this.#maxStallUs = 0;
    this.#lastPresentedFrames = undefined;
    this.#stallStartedAtUs = undefined;
    return this.#sessionId;
  }

  /** Reset the current window while retaining its clip/source identity. */
  reset(): void {
    this.start(this.#clipId, this.#sourceQuality);
  }

  recordDecodeMiss(): void {
    this.#decodeMisses += 1;
  }

  recordFrame(
    metadata: VideoFramePresentationMetadata | undefined,
    audioTimeUs: number,
    observedAtMs = performanceNow(),
  ): void {
    this.#decodedFrames += 1;
    if (metadata === undefined) {
      this.#presentationFrames += 1;
      return;
    }
    const previous = this.#lastPresentedFrames;
    const delta = previous === undefined ? 1 : Math.max(0, metadata.presentedFrames - previous);
    this.#lastPresentedFrames = metadata.presentedFrames;
    this.#presentationFrames += delta;
    if (delta > 1) this.#presentationDrops += delta - 1;
    const mediaTimeUs = Math.round(metadata.mediaTime * 1_000_000);
    this.#driftsUs.push(Math.abs(mediaTimeUs - audioTimeUs));
    const callbackLatenessUs = Math.round(
      observedAtMs * 1_000 - metadata.expectedDisplayTime * 1_000_000,
    );
    this.#callbackLatenessUs = Math.max(this.#callbackLatenessUs, Math.max(0, callbackLatenessUs));
  }

  beginStall(atUs: number): void {
    if (this.#stallStartedAtUs === undefined) this.#stallStartedAtUs = atUs;
  }

  endStall(atUs: number): void {
    if (this.#stallStartedAtUs === undefined) return;
    this.#stalls += 1;
    this.#maxStallUs = Math.max(this.#maxStallUs, Math.max(0, atUs - this.#stallStartedAtUs));
    this.#stallStartedAtUs = undefined;
  }

  snapshot(): PlaybackDiagnosticsSnapshot {
    const sorted = [...this.#driftsUs].sort((left, right) => left - right);
    const p50DriftUs = percentile(sorted, 0.5);
    const p95DriftUs = percentile(sorted, 0.95);
    return {
      sessionId: this.#sessionId,
      clipId: this.#clipId,
      sourceQuality: this.#sourceQuality,
      decodedFrames: this.#decodedFrames,
      droppedFrames: this.#presentationDrops + this.#decodeMisses,
      presentationFrames: this.#presentationFrames,
      presentationDrops: this.#presentationDrops,
      decodeMisses: this.#decodeMisses,
      callbackLatenessUs: this.#callbackLatenessUs,
      p50DriftUs,
      p95DriftUs,
      maxDriftUs: sorted.length === 0 ? 0 : Math.max(...sorted),
      stalls: this.#stalls,
      maxStallUs: this.#maxStallUs,
      quality: this.#sourceQuality,
    };
  }
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index]!;
}

function performanceNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}
