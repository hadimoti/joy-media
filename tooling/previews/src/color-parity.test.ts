import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EffectInstanceIR } from '@joy-media/render-ir';
import type { ColorMatrixFilter } from 'pixi.js';
import { applyHeadlessEffects } from '../../../packages/renderer-headless/src/index.js';
import { buildPixiEffectFilters } from '../../../packages/renderer-pixi/src/effects-pixi.js';
import { effectToFfmpegFilter } from '../../../packages/visual-effects/src/ffmpeg-backend.js';

// Pixi touches a canvas while constructing filters; node has no document, so stub one without a GL context.
beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: () => ({ getContext: () => null }),
  });
});

afterAll(() => vi.unstubAllGlobals());

/**
 * Sepia must produce the same colours on all three render paths: the Pixi
 * ColorMatrixFilter (preview builder and editor), the headless CPU reference
 * renderer, and the ffmpeg colorchannelmixer graph used for export.
 */

const COLOURS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [255, 255, 255],
  [128, 128, 128],
  [200, 120, 40],
  [30, 160, 220],
  [10, 200, 90],
];
const AMOUNTS = [0, 0.25, 0.5, 1];

/** Headless clamps and rounds to 8 bits, so it may differ from the exact float result by one level. */
const HEADLESS_TOLERANCE = 1;
/** ffmpeg coefficients are printed with four decimals, so they are allowed a small rounding error. */
const FFMPEG_TOLERANCE = 0.1;

function sepiaInstance(amount: number): EffectInstanceIR {
  return { id: 'fx-sepia', kind: 'sepia', enabled: true, params: { amount } };
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, value));
}

/** Applies a Pixi 5x4 row-major colour matrix to one 8-bit RGB colour. */
function applyPixiMatrix(
  matrix: readonly number[],
  [r, g, b]: readonly [number, number, number],
): number[] {
  const input = [r / 255, g / 255, b / 255, 1];
  return [0, 1, 2].map((row) => {
    const offset = row * 5;
    const sum =
      matrix[offset]! * input[0]! +
      matrix[offset + 1]! * input[1]! +
      matrix[offset + 2]! * input[2]! +
      matrix[offset + 3]! * input[3]! +
      matrix[offset + 4]!;
    return clamp255(sum * 255);
  });
}

function pixiSepiaMatrix(amount: number): number[] {
  const [filter] = buildPixiEffectFilters([sepiaInstance(amount)]);
  expect(filter).toBeDefined();
  return Array.from((filter as ColorMatrixFilter).matrix);
}

function headlessSepia(
  [r, g, b]: readonly [number, number, number],
  amount: number,
): [number, number, number] {
  const pixels = new Uint8Array([r, g, b, 255]);
  applyHeadlessEffects(pixels, 1, 1, [sepiaInstance(amount)]);
  return [pixels[0]!, pixels[1]!, pixels[2]!];
}

/** Parses the rr..bb coefficients of the colorchannelmixer string into a 3x3 matrix. */
function ffmpegSepiaCoefficients(amount: number): number[] {
  const graph = effectToFfmpegFilter(
    { id: 'fx-sepia', effectId: 'sepia', enabled: true, params: { amount } },
    'in',
    'out',
  );
  expect(graph).toBeDefined();
  const keys = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'] as const;
  const values = new Map<string, number>();
  for (const match of graph!.matchAll(/([a-z]{2})=(-?\d+(?:\.\d+)?)/g)) {
    values.set(match[1]!, Number(match[2]));
  }
  return keys.map((key) => {
    const value = values.get(key);
    expect(value, `ffmpeg ${key}`).toBeDefined();
    return value!;
  });
}

function applyFfmpegSepia(
  coefficients: readonly number[],
  [r, g, b]: readonly [number, number, number],
): number[] {
  return [0, 3, 6].map((start) =>
    clamp255(
      coefficients[start]! * r + coefficients[start + 1]! * g + coefficients[start + 2]! * b,
    ),
  );
}

describe('sepia parity across Pixi, headless and ffmpeg', () => {
  it.each(AMOUNTS)('amount %s: the Pixi matrix matches the headless CPU formula', (amount) => {
    const matrix = pixiSepiaMatrix(amount);
    for (const colour of COLOURS) {
      const pixi = applyPixiMatrix(matrix, colour);
      const headless = headlessSepia(colour, amount);
      for (let channel = 0; channel < 3; channel++) {
        expect(
          Math.abs(pixi[channel]! - headless[channel]!),
          `colour ${colour.join(',')} channel ${channel}`,
        ).toBeLessThanOrEqual(HEADLESS_TOLERANCE);
      }
    }
  });

  it.each(AMOUNTS)(
    'amount %s: the Pixi matrix matches the ffmpeg colorchannelmixer graph',
    (amount) => {
      const matrix = pixiSepiaMatrix(amount);
      const coefficients = ffmpegSepiaCoefficients(amount);
      for (const colour of COLOURS) {
        const pixi = applyPixiMatrix(matrix, colour);
        const ffmpeg = applyFfmpegSepia(coefficients, colour);
        for (let channel = 0; channel < 3; channel++) {
          expect(
            Math.abs(pixi[channel]! - ffmpeg[channel]!),
            `colour ${colour.join(',')} channel ${channel}`,
          ).toBeLessThanOrEqual(FFMPEG_TOLERANCE);
        }
      }
    },
  );

  it('is the identity at amount 0 on every path', () => {
    expect(pixiSepiaMatrix(0)).toEqual([
      1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0,
    ]);
    for (const colour of COLOURS) {
      expect(headlessSepia(colour, 0)).toEqual([...colour]);
    }
  });
});
