import { describe, expect, it } from 'vitest';
import { pixelToTime, snapTime, timeToPixel } from './index.js';
describe('timeline coordinates', () => {
  it('round trips coordinates and snaps inside the pixel threshold', () => {
    const viewport = { originUs: 1_000_000, pixelsPerSecond: 100 };
    expect(pixelToTime(timeToPixel(2_500_000, viewport), viewport)).toBe(2_500_000);
    expect(snapTime(2_049_000, [2_000_000], viewport, 8)).toBe(2_000_000);
    expect(snapTime(2_090_000, [2_000_000], viewport, 8)).toBe(2_090_000);
  });
});
