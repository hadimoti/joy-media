import type { DecodedFrame } from './index.js';
import type { FrameDecoder } from './decoder.js';
import type { ImageDataLike } from './image-data.js';

/** Browser decoder with a no-seek path for video-frame-driven playback. */
export interface HtmlMediaDecoder extends FrameDecoder {
  /** Capture the frame already presented by the live HTML media clock. */
  captureCurrentFrame(requestToken: number): DecodedFrame;
}

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
  drawImage(image: HtmlVideoElementLike, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(dx: number, dy: number, sw: number, sh: number): ImageDataLike;
  readonly canvas: { readonly width: number; readonly height: number };
}

/** Minimal canvas element boundary, mirroring `HTMLCanvasElement`. */
export interface HtmlCanvasElementLike {
  width: number;
  height: number;
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
  canvas?: HtmlCanvasElementLike | HTMLCanvasElement,
): HtmlMediaDecoder {
  let currentSourceToken = '';
  return {
    async decode(sourceToken, sourceTimeUs, requestToken): Promise<DecodedFrame> {
      if (video.src !== sourceToken) video.src = sourceToken;
      currentSourceToken = sourceToken;
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
    captureCurrentFrame(requestToken): DecodedFrame {
      const bitmap = captureBitmap(video, canvas);
      return {
        assetId: currentSourceToken || video.src,
        sourceTimeUs: Math.floor(video.currentTime * 1_000_000),
        token: `html-media:${requestToken}`,
        ...(bitmap !== undefined ? { bitmap } : {}),
      };
    },
  };
}

function captureBitmap(
  video: HtmlVideoElementLike,
  canvas: HtmlCanvasElementLike | HTMLCanvasElement | undefined,
): ImageDataLike | undefined {
  if (canvas === undefined) return undefined;
  if (video.videoWidth === 0 || video.videoHeight === 0) return undefined;
  // HTMLCanvasElement has a wider DOM `drawImage` signature than our minimal
  // test boundary. At runtime both expose exactly the operations below.
  const context = canvas.getContext('2d') as HtmlCanvas2DContextLike | null;
  if (context === null) return undefined;
  // A caller can provide a zero-sized canvas to opt into the source's
  // intrinsic size. This is useful for editor preview because a newly-created
  // DOM canvas otherwise defaults to 300×150 before media metadata is known.
  if (canvas.width === 0 || canvas.height === 0) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
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
