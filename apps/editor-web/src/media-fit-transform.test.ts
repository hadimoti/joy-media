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

function frameCornersAreInsideMedia(input: FitInput, transform: FitResult): boolean {
  const crop = input.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const left = input.sourceWidth * crop.left;
  const top = input.sourceHeight * crop.top;
  const right = input.sourceWidth * (1 - crop.right);
  const bottom = input.sourceHeight * (1 - crop.bottom);
  const anchor = input.anchor ?? { x: 0.5, y: 0.5 };
  const pivotX = left + (right - left) * anchor.x;
  const pivotY = top + (bottom - top) * anchor.y;
  const radians = ((input.rotationDeg ?? 0) * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const stagePivotX = pivotX * transform.scaleX + transform.x;
  const stagePivotY = pivotY * transform.scaleY + transform.y;
  const corners = [
    { x: 0, y: 0 },
    { x: input.frameWidth, y: 0 },
    { x: input.frameWidth, y: input.frameHeight },
    { x: 0, y: input.frameHeight },
  ];

  return corners.every(({ x, y }) => {
    const offsetX = x - stagePivotX;
    const offsetY = y - stagePivotY;
    const localX = pivotX + (offsetX * cosine + offsetY * sine) / transform.scaleX;
    const localY = pivotY + (-offsetX * sine + offsetY * cosine) / transform.scaleY;
    return (
      localX >= left - 1e-8 &&
      localX <= right + 1e-8 &&
      localY >= top - 1e-8 &&
      localY <= bottom + 1e-8
    );
  });
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

  it('preserves nonzero subpixel translation values', () => {
    const actual = calculateMediaFitTransform({
      sourceWidth: 10,
      sourceHeight: 10,
      frameWidth: 10.25,
      frameHeight: 10,
      mode: 'fit',
    });
    expect(actual?.x).toBeCloseTo(0.125, 10);
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

  it('clamps each crop edge to the renderer limit before calculating the transform', () => {
    const source = {
      sourceWidth: 100,
      sourceHeight: 80,
      frameWidth: 200,
      frameHeight: 120,
      mode: 'fill' as const,
      rotationDeg: 23,
    };
    expect(
      calculateMediaFitTransform({
        ...source,
        crop: { left: 0.75, top: 0.75, right: 0.75, bottom: 0.75 },
      }),
    ).toEqual(
      calculateMediaFitTransform({
        ...source,
        crop: { left: 0.49, top: 0.49, right: 0.49, bottom: 0.49 },
      }),
    );
  });

  it('fills a square frame with a 45-degree square clip without exposing corners', () => {
    const input: FitInput = {
      sourceWidth: 100,
      sourceHeight: 100,
      frameWidth: 100,
      frameHeight: 100,
      mode: 'fill',
      rotationDeg: 45,
    };
    const result = calculateMediaFitTransform(input);
    expect(result?.scaleX).toBeCloseTo(Math.SQRT2, 10);
    expect(result?.scaleY).toBeCloseTo(Math.SQRT2, 10);
    expect(result).toBeDefined();
    expect(frameCornersAreInsideMedia(input, result!)).toBe(true);
  });

  it('fills a portrait frame with 30-degree rotated 16:9 media without exposing corners', () => {
    const input: FitInput = {
      sourceWidth: 1920,
      sourceHeight: 1080,
      frameWidth: 1080,
      frameHeight: 1920,
      mode: 'fill',
      rotationDeg: 30,
      crop: { left: 0.1, top: 0.05, right: 0.05, bottom: 0.1 },
      anchor: { x: 0.3, y: 0.7 },
    };
    const result = calculateMediaFitTransform(input);
    expect(result).toBeDefined();
    expect(frameCornersAreInsideMedia(input, result!)).toBe(true);
  });

  it.each([90, 180])(
    'fills a square frame at %i degrees without changing its size',
    (rotationDeg) => {
      const result = calculateMediaFitTransform({
        sourceWidth: 100,
        sourceHeight: 100,
        frameWidth: 100,
        frameHeight: 100,
        mode: 'fill',
        rotationDeg,
      });
      expect(result).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
    },
  );

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
