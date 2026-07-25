import { describe, expect, it } from 'vitest';
import { dualTextureBitmapsReady } from './transition-bitmaps.js';

describe('dualTextureBitmapsReady', () => {
  it('requires both left and right clip bitmaps for gl blend', () => {
    const bitmaps = new Map<string, { width: number; height: number; data: Uint8ClampedArray }>([
      ['left', { width: 1, height: 1, data: new Uint8ClampedArray(4) }],
      ['right', { width: 1, height: 1, data: new Uint8ClampedArray(4) }],
    ]);
    expect(dualTextureBitmapsReady('left', 'right', bitmaps)).toBe(true);
    expect(dualTextureBitmapsReady('left', 'missing', bitmaps)).toBe(false);
    expect(dualTextureBitmapsReady('missing', 'right', bitmaps)).toBe(false);
  });
});
