/**
 * @joy-media/golden-render — Golden-frame/golden-audio comparison harness.
 *
 * WP-00.3 state: deterministic golden-frame harness for a preview adapter and
 * pinned headless reference renderer over the same Render IR.
 */
import type { RenderFrameIR } from '@joy-media/render-ir';
import { renderHeadlessFrame } from '@joy-media/renderer-headless';
import { renderPixiPreview } from '@joy-media/renderer-pixi';

export const PACKAGE_NAME = '@joy-media/golden-render' as const;

const US_PER_SECOND = 1_000_000;

/**
 * The first visual parity fixture: a still image, a resolved video frame, a
 * bitmap text object, and a linearly evaluated transform animation.
 */
export function createParitySpikeFrame(timeUs: number): RenderFrameIR {
  if (!Number.isSafeInteger(timeUs) || timeUs < 0 || timeUs > US_PER_SECOND) {
    throw new RangeError('parity fixture timeUs must be an integer in [0, 1000000]');
  }
  const progress = timeUs / US_PER_SECOND;
  return {
    version: 1,
    compositionId: 'parity-spike',
    timeUs,
    viewport: { width: 32, height: 18, dpr: 1 },
    background: { r: 12, g: 16, b: 28, a: 255 },
    nodes: [
      {
        kind: 'sprite',
        id: 'image-card',
        zIndex: 0,
        opacity: 1,
        transform: {
          translateX: 2 + 6 * progress,
          translateY: 2,
          scaleX: 1 + progress / 2,
          scaleY: 1 + progress / 2,
        },
        width: 6,
        height: 4,
        color: { r: 247, g: 185, b: 40, a: 255 },
      },
      {
        kind: 'video-frame',
        id: 'video-frame',
        zIndex: 1,
        opacity: 0.8,
        transform: { translateX: 7, translateY: 10, scaleX: 1, scaleY: 1 },
        width: 12,
        height: 5,
        sourceTimeUs: 4 * US_PER_SECOND + timeUs,
        color: { r: 67, g: 137, b: 255, a: 255 },
      },
      {
        kind: 'text',
        id: 'title-text',
        zIndex: 2,
        opacity: 1,
        transform: { translateX: 19, translateY: 4, scaleX: 1, scaleY: 1 },
        text: 'JOY',
        color: { r: 238, g: 244, b: 255, a: 255 },
      },
    ],
  };
}

export interface GoldenFrameComparison {
  readonly previewDigest: string;
  readonly headlessDigest: string;
  readonly identical: boolean;
}

/** Runs both adapters against exactly the same evaluated frame. */
export function compareGoldenFrame(frame: RenderFrameIR): GoldenFrameComparison {
  const preview = renderPixiPreview(frame);
  const headless = renderHeadlessFrame(frame);
  return {
    previewDigest: digestRgba(preview.pixels),
    headlessDigest: digestRgba(headless.pixels),
    identical:
      preview.width === headless.width &&
      preview.height === headless.height &&
      preview.pixels.length === headless.pixels.length &&
      preview.pixels.every((value, index) => value === headless.pixels[index]),
  };
}

/** FNV-1a 64-bit digest: compact, deterministic golden evidence (not a security checksum). */
export function digestRgba(pixels: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of pixels) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}
