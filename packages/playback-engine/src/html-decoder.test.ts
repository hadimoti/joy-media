import { describe, expect, it } from 'vitest';
import { createHtmlMediaDecoder } from './html-decoder.js';
import type {
  HtmlCanvas2DContextLike,
  HtmlCanvasElementLike,
  HtmlVideoElementLike,
} from './html-decoder.js';

class FakeVideo implements HtmlVideoElementLike {
  videoWidth = 0;
  videoHeight = 0;
  src = '';
  currentTime = 0;
  readyState = 4;
  readonly seekListeners: Array<() => void> = [];
  readonly errorListeners: Array<() => void> = [];
  addEventListener(
    type: 'seeked' | 'error',
    listener: () => void,
    _options?: { once?: boolean },
  ): void {
    if (type === 'seeked') this.seekListeners.push(listener);
    else this.errorListeners.push(listener);
  }
  removeEventListener(type: 'seeked' | 'error', listener: () => void): void {
    const list = type === 'seeked' ? this.seekListeners : this.errorListeners;
    const i = list.indexOf(listener);
    if (i >= 0) list.splice(i, 1);
  }
}

class FakeContext implements HtmlCanvas2DContextLike {
  drawCalls: Array<{ dw: number; dh: number }> = [];
  pixels: Uint8ClampedArray;
  constructor(public readonly canvas: { width: number; height: number }) {
    this.pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  }
  drawImage(_image: HtmlVideoElementLike, _dx: number, _dy: number, dw: number, dh: number): void {
    this.drawCalls.push({ dw, dh });
  }
  getImageData(_dx: number, _dy: number, _sw: number, _sh: number) {
    return { width: this.canvas.width, height: this.canvas.height, data: this.pixels };
  }
}

class FakeCanvas implements HtmlCanvasElementLike {
  readonly context: FakeContext;
  constructor(public readonly width: number, public readonly height: number) {
    this.context = new FakeContext({ width, height });
  }
  getContext(kind: '2d'): HtmlCanvas2DContextLike | null {
    return kind === '2d' ? this.context : null;
  }
}

describe('HTML media decoder tier', () => {
  it('seeks in source time and labels the request generation (no canvas)', async () => {
    const video = new FakeVideo();
    await expect(createHtmlMediaDecoder(video).decode('proxy-url', 1_250_000, 7)).resolves.toEqual({
      assetId: 'proxy-url',
      sourceTimeUs: 1_250_000,
      token: 'html-media:7',
    });
    expect(video.currentTime).toBe(1.25);
  });

  it('captures an ImageData bitmap when a canvas and intrinsic size are available', async () => {
    const video = new FakeVideo();
    video.videoWidth = 640;
    video.videoHeight = 360;
    const canvas = new FakeCanvas(320, 180);
    const decoded = await createHtmlMediaDecoder(video, canvas).decode('proxy-url', 0, 3);
    expect(decoded.bitmap).toBeDefined();
    expect(decoded.bitmap?.width).toBe(320);
    expect(decoded.bitmap?.height).toBe(180);
    expect(decoded.bitmap?.data.length).toBe(320 * 180 * 4);
    expect(canvas.context.drawCalls).toEqual([{ dw: 320, dh: 180 }]);
  });

  it('omits the bitmap when the video has no decoded frame yet', async () => {
    const video = new FakeVideo();
    const canvas = new FakeCanvas(64, 64);
    const decoded = await createHtmlMediaDecoder(video, canvas).decode('proxy-url', 0, 1);
    expect(decoded.bitmap).toBeUndefined();
  });

  it('waits for the seeked event when readyState is below HAVE_CURRENT_DATA', async () => {
    const video = new FakeVideo();
    video.readyState = 0;
    const canvas = new FakeCanvas(64, 64);
    video.videoWidth = 64;
    video.videoHeight = 64;
    const pending = createHtmlMediaDecoder(video, canvas).decode('proxy-url', 500_000, 9);
    expect(video.currentTime).toBe(0.5);
    const listener = video.seekListeners[0];
    expect(listener).toBeDefined();
    listener!();
    const decoded = await pending;
    expect(decoded.sourceTimeUs).toBe(500_000);
  });
});
