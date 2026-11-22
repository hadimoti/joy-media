import { describe, expect, it } from 'vitest';
import { overFrameBackdrop } from './frame-backdrop.js';
import { sampleScopePixels } from './color-scopes.js';
import { pixelAt } from './color-eyedropper.js';

describe('frame backdrop', () => {
  it('keeps opaque pixels and shows the export backdrop through transparent ones', () => {
    expect(overFrameBackdrop('r', 200, 255)).toBe(200);
    expect(overFrameBackdrop('r', 0, 0)).toBe(12);
    expect(overFrameBackdrop('g', 0, 0)).toBe(16);
    expect(overFrameBackdrop('b', 0, 0)).toBe(28);
    expect(overFrameBackdrop('r', 255, 128)).toBeCloseTo(255 * (128 / 255) + 12 * (127 / 255), 5);
  });

  it('measures a transparent pixel as the exported backdrop, not as black', () => {
    const pixels = { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 0]) };
    const [sample] = sampleScopePixels(pixels, 1);
    expect(sample?.red).toBeCloseTo(12 / 255, 5);
    expect(sample?.blue).toBeCloseTo(28 / 255, 5);
    expect(pixelAt(pixels, { width: 1, height: 1 }, { x: 0, y: 0 })).toEqual({
      r: 12,
      g: 16,
      b: 28,
    });
  });
});
