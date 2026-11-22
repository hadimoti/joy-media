import { DEFAULT_FRAME_BACKGROUND } from '@joy-media/visual-object-renderer';

/**
 * The Monitor frame is transparent where nothing is drawn, but the exported frame has a solid backdrop.
 * Scopes and the eyedropper measure what the export will show, so they lay a read-back pixel over that
 * backdrop. `alpha` is 0 to 255 and the channels are straight (not premultiplied), as `getImageData` gives.
 */
export function overFrameBackdrop(channel: 'r' | 'g' | 'b', value: number, alpha: number): number {
  if (alpha >= 255) return value;
  const a = Math.max(0, alpha) / 255;
  return value * a + DEFAULT_FRAME_BACKGROUND[channel] * (1 - a);
}
