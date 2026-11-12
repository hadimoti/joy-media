import { describe, expect, it } from 'vitest';
import {
  computeHistogram,
  computeParadeColumns,
  computeVectorscopePoints,
  computeWaveformColumns,
  sampleScopePixels,
  scopeAxisLabels,
  scopeLabel,
  VECTORSCOPE_FULL_SCALE,
  VECTORSCOPE_HUE_MARKS,
  vectorscopeOffset,
  type ScopePixels,
} from './color-scopes.js';

/**
 * A patch frame: five columns of solid colour — pure red, green, blue, white
 * and black. The scopes must report the documented values for each patch.
 */
function patchFrame(): ScopePixels {
  const patches = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255],
    [0, 0, 0],
  ];
  const width = patches.length * 2;
  const height = 4;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const patch = patches[Math.floor(column / 2)]!;
      const offset = (row * width + column) * 4;
      data[offset] = patch[0]!;
      data[offset + 1] = patch[1]!;
      data[offset + 2] = patch[2]!;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('scope maths', () => {
  it('samples the patch frame on the coarse grid the scopes draw', () => {
    const samples = sampleScopePixels(patchFrame());

    // Five sampled columns (every second pixel) and two sampled rows.
    expect(samples).toHaveLength(10);
    expect(samples[0]).toMatchObject({ column: 0, red: 1, green: 0, blue: 0 });
    expect(samples[2]).toMatchObject({ column: 4, red: 0, green: 0, blue: 1 });
  });

  it('reports the expected waveform levels for the patch frame', () => {
    const pixels = patchFrame();
    const columns = computeWaveformColumns(sampleScopePixels(pixels), pixels.width);

    expect(columns.map((column) => Number(column.high.toFixed(4)))).toEqual([
      0.2126, // pure red
      0.7152, // pure green
      0.0722, // pure blue
      1, // pure white
      0, // pure black
    ]);
    // A flat patch has no spread: the low and the high are the same level.
    for (const column of columns) expect(column.low).toBeCloseTo(column.high, 6);
    // The columns run across the plot from the first to the last pixel.
    expect(columns[0]?.x).toBe(0);
    expect(columns.at(-1)?.x).toBeCloseTo(8 / 9, 6);
  });

  it('reports the expected RGB parade values for the patch frame', () => {
    const pixels = patchFrame();
    const columns = computeParadeColumns(sampleScopePixels(pixels), pixels.width);
    const panel = (index: 0 | 1 | 2) =>
      columns
        .filter((column) => column.panel === index)
        .map((column) => Number(column.high.toFixed(4)));

    // Every panel shows the whole picture: red, green and blue of each patch.
    expect(panel(0)).toEqual([1, 0, 0, 1, 0]);
    expect(panel(1)).toEqual([0, 1, 0, 1, 0]);
    expect(panel(2)).toEqual([0, 0, 1, 1, 0]);
  });

  it('places the patch frame on the vectorscope by hue', () => {
    const points = computeVectorscopePoints(sampleScopePixels(patchFrame()));

    const red = points[0]!;
    const green = points[1]!;
    const blue = points[2]!;
    const white = points[3]!;
    const black = points[4]!;

    // Red leads on red against luma, blue leads on blue against luma.
    expect(red.x).toBeGreaterThan(0);
    expect(red.y).toBeLessThan(0);
    expect(green.x).toBeLessThan(0);
    expect(green.y).toBeLessThan(0);
    expect(blue.x).toBeLessThan(0);
    expect(blue.y).toBeGreaterThan(0);
    // Neutral colours sit in the centre.
    expect(white).toEqual({ x: 0, y: 0 });
    expect(black).toEqual({ x: 0, y: 0 });
    // Magenta and green are the furthest from neutral: they reach the ring.
    expect(Math.hypot(vectorscopeOffset(1, 0, 1).x, vectorscopeOffset(1, 0, 1).y)).toBeCloseTo(
      1,
      6,
    );
    expect(Math.hypot(vectorscopeOffset(0, 1, 0).x, vectorscopeOffset(0, 1, 0).y)).toBeCloseTo(
      1,
      6,
    );
    // Red sits inside the ring at about 81 per cent of full chroma.
    expect(Math.hypot(red.x, red.y)).toBeCloseTo(0.8064, 3);
    expect(VECTORSCOPE_FULL_SCALE).toBeGreaterThan(1);
  });

  it('reports the expected histogram bins for the patch frame', () => {
    const bins = computeHistogram(sampleScopePixels(patchFrame()), 64);

    // Two sampled pixels per patch, in the bin their luma rounds to.
    expect(bins[13]).toBe(2); // red, 0.2126
    expect(bins[45]).toBe(2); // green, 0.7152
    expect(bins[5]).toBe(2); // blue, 0.0722
    expect(bins[63]).toBe(2); // white
    expect(bins[0]).toBe(2); // black
    expect(bins.reduce((total, value) => total + value, 0)).toBe(10);
  });

  it('names the axes every scope draws', () => {
    expect(scopeAxisLabels('waveform')).toEqual({
      horizontal: 'image columns',
      vertical: 'level, 0 to 100 per cent',
    });
    expect(scopeAxisLabels('parade').vertical).toBe('level, 0 to 100 per cent');
    expect(scopeAxisLabels('histogram').horizontal).toBe('luminance, 0 to 100 per cent');
    expect(scopeAxisLabels('vectorscope').horizontal).toContain('hue marks');
    expect(scopeLabel('parade')).toBe('RGB Parade');
    expect(scopeLabel('vectorscope')).toBe('Vectorscope');
    expect(VECTORSCOPE_HUE_MARKS.map((mark) => mark.label)).toEqual([
      'R',
      'Yl',
      'G',
      'Cy',
      'B',
      'Mg',
    ]);
  });
});
