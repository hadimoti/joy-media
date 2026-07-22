import type { DecodedFrame } from './index.js';
import type { FrameDecoder } from './decoder.js';
import type { ImageDataLike } from './image-data.js';

/** Minimal DOM boundary, enabling a proxy-backed HTML media decode tier in the editor. */
export interface HtmlVideoElementLike {
  readonly videoWidth: number;
  readonly videoHeight: number;
  src: string;
  currentTime: number;
  readyState: number;
  addEventListener(
    type: 'seeked' | 'error',
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: 'seeked' | 'error', listener: () => void): void;
}

/** Minimal 2D canvas context boundary, mirroring `CanvasRenderingContext2D`. */
export interface HtmlCanvas2DContextLike {
  drawImage(
    image: HtmlVideoElementLike,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  getImageData(dx: number, dy: number, sw: number, sh: number): ImageDataLike;
  readonly canvas: { readonly width: number; readonly height: number };
}

/** Minimal canvas element boundary, mirroring `HTMLCanvasElement`. */
export interface HtmlCanvasElementLike {
  readonly width: number;
  readonly height: number;
  getContext(kind: '2d'): HtmlCanvas2DContextLike | null;
}

/**
 * Create a {@link FrameDecoder} backed by an HTMLVideoElement.
 *
 * WP-11.2: this is the *real* browser decode tier for the editor preview.
 * When an optional canvas is supplied, after every seek the video frame is
 * drawn to the canvas and the resulting `ImageData` rides on the returned
 * `DecodedFrame` so the caller can paint it into the Monitor. Without a
 * canvas the decoder still drives a real `<video>` element (a real seek on
 * real media) but only returns metadata — useful for tests and for the
 * metrics-only path.
 */
export function createHtmlMediaDecoder(
  video: HtmlVideoElementLike,
  canvas?: HtmlCanvasElementLike,
): FrameDecoder {
  return {
    async decode(sourceToken, sourceTimeUs, requestToken): Promise<DecodedFrame> {
      if (video.src !== sourceToken) video.src = sourceToken;
      video.currentTime = sourceTimeUs / 1_000_000;
      if (video.readyState < 2) await waitForSeek(video);
      const bitmap = captureBitmap(video, canvas);
      return {
        assetId: sourceToken,
        sourceTimeUs,
        token: `html-media:${requestToken}`,
        ...(bitmap !== undefined ? { bitmap } : {}),
      };
    },
  };
}

function captureBitmap(
  video: HtmlVideoElementLike,
  canvas: HtmlCanvasElementLike | undefined,
): ImageDataLike | undefined {
  if (canvas === undefined) return undefined;
  if (video.videoWidth === 0 || video.videoHeight === 0) return undefined;
  const context = canvas.getContext('2d');
  if (context === null) return undefined;
  const width = Math.min(canvas.width, video.videoWidth);
  const height = Math.min(canvas.height, video.videoHeight);
  context.drawImage(video, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

function waitForSeek(video: HtmlVideoElementLike): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('HTML media decoder failed to seek'));
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}
