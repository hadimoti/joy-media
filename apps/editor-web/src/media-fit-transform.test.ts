import { describe, expect, it } from 'vitest';
import { calculateMediaFitTransform } from './media-fit-transform.js';

interface FitInput {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly mode: 'fit' | 'fill';
  readonly rotationDeg?: number;
  readonly crop?: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  readonly anchor?: { readonly x: number; readonly y: number };
}

interface FitResult {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

describe('calculateMediaFitTransform', () => {
  const fitCases: readonly {
    readonly name: string;
    readonly input: FitInput;
    readonly expected: FitResult;
  }[] = [
    {
      name: 'contains 16:9 media in a 9:16 composition',
      input: {
        sourceWidth: 1920,
        sourceHeight: 1080,
        frameWidth: 1080,
        frameHeight: 1920,
        mode: 'fit',
      },
      expected: { x: 0, y: 656.25, scaleX: 0.5625, scaleY: 0.5625 },
    },
    {
      name: 'fills a 9:16 composition with 16:9 media',
      input: {
        sourceWidth: 1920,
        sourceHeight: 1080,
        frameWidth: 1080,
        frameHeight: 1920,
        mode: 'fill',
      },
      expected: {
        x: -1166.6666666666665,
        y: 0,
        scaleX: 1.7777777777777777,
        scaleY: 1.7777777777777777,
      },
    },
    {
      name: 'contains 9:16 media in a 16:9 composition',
      input: {
        sourceWidth: 1080,
        sourceHeight: 1920,
        frameWidth: 1920,
        frameHeight: 1080,
        mode: 'fit',
      },
      expected: { x: 656.25, y: 0, scaleX: 0.5625, scaleY: 0.5625 },
    },
    {
      name: 'fills a 16:9 composition with 9:16 media',
      input: {
        sourceWidth: 1080,
        sourceHeight: 1920,
        frameWidth: 1920,
        frameHeight: 1080,
        mode: 'fill',
      },
      expected: {
        x: 0,
        y: -1166.6666666666665,
        scaleX: 1.7777777777777777,
        scaleY: 1.7777777777777777,
      },
    },
    {
      name: 'contains a 4:3 picture without stretching it',
      input: {
        sourceWidth: 640,
        sourceHeight: 480,
        frameWidth: 1920,
        frameHeight: 1080,
        mode: 'fit',
      },
      expected: { x: 240, y: 0, scaleX: 2.25, scaleY: 2.25 },
    },
    {
      name: 'upscales a small picture to fit the frame',
      input: {
        sourceWidth: 320,
        sourceHeight: 180,
        frameWidth: 1920,
        frameHeight: 1080,
        mode: 'fit',
      },
      expected: { x: 0, y: 0, scaleX: 6, scaleY: 6 },
    },
    {
      name: 'contains an odd-sized source without rounding its placement',
      input: {
        sourceWidth: 1001,
        sourceHeight: 667,
        frameWidth: 1920,
        frameHeight: 1080,
        mode: 'fit',
      },
      expected: {
        x: 149.5952023988006,
        y: 0,
        scaleX: 1080 / 667,
        scaleY: 1080 / 667,
      },
    },
    {
      name: 'fits a quarter-turned clip by its rotated bounds',
      input: {
        sourceWidth: 1920,
        sourceHeight: 1080,
        frameWidth: 1080,
        frameHeight: 1920,
        mode: 'fit',
        rotationDeg: 90,
      },
      expected: { x: -420, y: 420, scaleX: 1, scaleY: 1 },
    },
  ];

  for (const { name, input, expected } of fitCases) {
    it(name, () => {
      const actual = calculateMediaFitTransform(input);
      expect(actual).toBeDefined();
      expect(actual?.x).toBeCloseTo(expected.x, 10);
      expect(actual?.y).toBeCloseTo(expected.y, 10);
      expect(actual?.scaleX).toBeCloseTo(expected.scaleX, 10);
      expect(actual?.scaleY).toBeCloseTo(expected.scaleY, 10);
    });
  }

  it('cleans floating-point noise from right-angle rotation results', () => {
    expect(
      calculateMediaFitTransform({
        sourceWidth: 1920,
        sourceHeight: 1080,
        frameWidth: 1080,
        frameHeight: 1920,
        mode: 'fit',
        rotationDeg: 90,
      }),
    ).toEqual({ x: -420, y: 420, scaleX: 1, scaleY: 1 });
  });

  it('centres a cropped clip around its saved anchor while preserving the crop', () => {
    const actual = calculateMediaFitTransform({
      sourceWidth: 100,
      sourceHeight: 80,
      frameWidth: 200,
      frameHeight: 200,
      mode: 'fit',
      rotationDeg: 90,
      crop: { left: 0.25, top: 0, right: 0, bottom: 0 },
      anchor: { x: 0.25, y: 0.5 },
    });
    expect(actual?.x).toBeCloseTo(-9.375, 10);
    expect(actual?.y).toBeCloseTo(-46.875, 10);
    expect(actual?.scaleX).toBeCloseTo(2.5, 10);
    expect(actual?.scaleY).toBeCloseTo(2.5, 10);
  });

  it('rejects dimensions that cannot produce a finite positive transform', () => {
    expect(
      calculateMediaFitTransform({
        sourceWidth: 0,
        sourceHeight: 180,
        frameWidth: 1920,
        frameHeight: 1080,
        mode: 'fit',
      }),
    ).toBeUndefined();
    expect(
      calculateMediaFitTransform({
        sourceWidth: 320,
        sourceHeight: 180,
        frameWidth: Number.NaN,
        frameHeight: 1080,
        mode: 'fit',
      }),
    ).toBeUndefined();
  });
});
