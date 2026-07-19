import type { DecodedFrame } from './index.js';
import type { FrameDecoder } from './decoder.js';

/** Minimal DOM boundary, enabling a proxy-backed HTML media decode tier in the editor. */
export interface HtmlVideoElementLike {
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

export function createHtmlMediaDecoder(video: HtmlVideoElementLike): FrameDecoder {
  return {
    async decode(sourceToken, sourceTimeUs, requestToken): Promise<DecodedFrame> {
      if (video.src !== sourceToken) video.src = sourceToken;
      video.currentTime = sourceTimeUs / 1_000_000;
      if (video.readyState < 2) await waitForSeek(video);
      return { assetId: sourceToken, sourceTimeUs, token: `html-media:${requestToken}` };
    },
  };
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
