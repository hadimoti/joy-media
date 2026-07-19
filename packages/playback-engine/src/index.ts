import { AudioPreviewClock } from '@joy-media/audio-core';
export type { FrameDecoder, MediaSource } from './decoder.js';
export { requestDecodedFrame, selectDecodeSource } from './decoder.js';
export type { HtmlVideoElementLike } from './html-decoder.js';
export { createHtmlMediaDecoder } from './html-decoder.js';
export { sourceTimeAtPlayhead } from './source-time.js';
export interface DecodedFrame {
  readonly assetId: string;
  readonly sourceTimeUs: number;
  readonly token: string;
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
export class PlaybackScheduler {
  readonly audio: AudioPreviewClock;
  #generation = 0;
  #droppedFrames = 0;
  #decodedFrames = 0;
  constructor(sampleRate = 48_000) {
    this.audio = new AudioPreviewClock(sampleRate);
  }
  seek(timeUs: number): number {
    this.#generation++;
    return this.audio.seek(timeUs);
  }
  requestToken(): number {
    return this.#generation;
  }
  acceptFrame(token: number, onTime: boolean): boolean {
    if (token !== this.#generation) return false;
    this.#decodedFrames++;
    if (!onTime) this.#droppedFrames++;
    return true;
  }
  get droppedFrames(): number {
    return this.#droppedFrames;
  }
  get metrics(): {
    readonly decodedFrames: number;
    readonly droppedFrames: number;
    readonly quality: 'full' | 'proxy';
  } {
    return {
      decodedFrames: this.#decodedFrames,
      droppedFrames: this.#droppedFrames,
      quality: this.quality(),
    };
  }
  quality(): 'full' | 'proxy' {
    return this.#droppedFrames >= 3 ? 'proxy' : 'full';
  }
}
