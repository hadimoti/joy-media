import { previewQualityScale, type FixedPreviewQuality } from '../preview-quality.js';

/**
 * Device pixels per CSS pixel of the Monitor canvas (ADR-0046, review B1).
 *
 * The canvas is the size of the panel, so the backing store is
 * panel size x screen pixel ratio x quality. The zoom is not part of it: the
 * renderer draws the frame through the view at this density, which keeps
 * text sharp at any zoom without a giant buffer. Read by T-M09 (Auto quality).
 */
export function monitorPixelScale(quality: FixedPreviewQuality, devicePixelRatio: number): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.max(0.1, previewQualityScale(quality) * ratio);
}
