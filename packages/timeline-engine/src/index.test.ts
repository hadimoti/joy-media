import { describe, expect, it } from 'vitest';
import {
  commitMove,
  pixelToTime,
  previewMove,
  snapTime,
  timeToPixel,
  visibleRange,
} from './index.js';
describe('timeline coordinates', () => {
  it('round trips coordinates and snaps inside the pixel threshold', () => {
    const viewport = { originUs: 1_000_000, pixelsPerSecond: 100 };
    expect(pixelToTime(timeToPixel(2_500_000, viewport), viewport)).toBe(2_500_000);
    expect(snapTime(2_049_000, [2_000_000], viewport, 8)).toBe(2_000_000);
    expect(snapTime(2_090_000, [2_000_000], viewport, 8)).toBe(2_090_000);
  });
  it('keeps drag previews transient and emits one snapped move command on commit', () => {
    const viewport = { originUs: 0, pixelsPerSecond: 100 };
    const preview = previewMove('clip-a', 0, 1_049_000, [1_000_000], viewport);
    expect(preview.snappedStartUs).toBe(1_000_000);
    expect(commitMove('root', 'track-0', preview)).toMatchObject({
      type: 'timeline.moveClip',
      payload: { newStartUs: 1_000_000 },
    });
    expect(visibleRange(viewport, 250)).toEqual({ startUs: 0, endUs: 2_500_000 });
  });
});
