import { describe, expect, it } from 'vitest';
import { anchorToCanvas, canvasToAnchor } from './monitor-gradient-anchors.js';

// A text box 400 x 100 canvas px whose top-left corner is at (100, 50).
const plain = [400, 0, 0, 100, 100, 50] as const;
// The same box turned a quarter turn about its top-left corner.
const turned = [0, 400, -100, 0, 100, 50] as const;

describe('gradient anchors on the Monitor', () => {
  it('maps text-box fractions to canvas pixels', () => {
    expect(anchorToCanvas(plain, { x: 0, y: 0 })).toEqual({ x: 100, y: 50 });
    expect(anchorToCanvas(plain, { x: 1, y: 1 })).toEqual({ x: 500, y: 150 });
    expect(anchorToCanvas(plain, { x: 0.5, y: 0.5 })).toEqual({ x: 300, y: 100 });
  });

  it('is the inverse of that map, also for a turned box', () => {
    for (const matrix of [plain, turned]) {
      const anchor = { x: 0.25, y: 0.75 };
      const back = canvasToAnchor(matrix, anchorToCanvas(matrix, anchor));
      expect(back?.x).toBeCloseTo(0.25, 3);
      expect(back?.y).toBeCloseTo(0.75, 3);
    }
  });

  it('keeps a dragged anchor near the box', () => {
    const far = canvasToAnchor(plain, { x: 100_000, y: -100_000 });
    expect(far).toEqual({ x: 2, y: -1 });
  });

  it('has no answer for a collapsed box', () => {
    expect(canvasToAnchor([0, 0, 0, 0, 10, 10], { x: 1, y: 1 })).toBeUndefined();
  });
});
