import { describe, expect, it } from 'vitest';
import { parseCubeLut, sampleCubeLut } from './lut.js';

describe('cube LUT parser', () => {
  it('parses and samples a 2x2 identity LUT', () => {
    const lut = parseCubeLut(
      `TITLE "identity"\nLUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1`,
    );
    expect(sampleCubeLut(lut, 0.25, 0.5, 0.75)).toEqual([0.25, 0.5, 0.75]);
  });

  it('rejects 1D and incomplete LUTs', () => {
    expect(() => parseCubeLut('LUT_1D_SIZE 16')).toThrow(/1D/);
    expect(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 0')).toThrow(/expected/);
  });
});
