import { describe, expect, it } from 'vitest';
import { seekPreviewMedia } from './preview-media-seek.js';

class DelayedSeekVideo extends EventTarget {
  #currentTime = 0;
  seeking = false;

  get currentTime(): number {
    return this.#currentTime;
  }

  set currentTime(value: number) {
    this.#currentTime = value;
    this.seeking = true;
  }

  beginAt(time: number): void {
    this.#currentTime = time;
    this.seeking = true;
  }

  finishSeek(): void {
    this.seeking = false;
    this.dispatchEvent(new Event('seeked'));
  }
}

describe('seekPreviewMedia', () => {
  it('waits for seeked when currentTime already matches but decoding is pending', async () => {
    const video = new DelayedSeekVideo();
    video.beginAt(4.2);
    let resolved = false;
    const pending = seekPreviewMedia(video as unknown as HTMLVideoElement, 4_200_000).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    video.finishSeek();
    await pending;
    expect(resolved).toBe(true);
  });

  it('sets a different target and waits for the delayed seek to finish', async () => {
    const video = new DelayedSeekVideo();
    const pending = seekPreviewMedia(video as unknown as HTMLVideoElement, 7_500_000);

    expect(video.currentTime).toBe(7.5);
    expect(video.seeking).toBe(true);
    video.finishSeek();
    await expect(pending).resolves.toBeUndefined();
  });
});
