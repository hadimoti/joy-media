import { describe, expect, it } from 'vitest';

/**
 * C-078: Unit guard and math verification for untagged video color space decode conventions.
 *
 * Grounded in c2-untagged-decode-evidence-2026-11-06.md:
 * - Untagged SD (< 720p height, e.g. 640x480) decodes with BT.601 matrix coefficients.
 * - Untagged HD (>= 720p height, e.g. 1280x720) decodes with BT.709 matrix coefficients.
 * - For a reference red source (R=200, G=50, B=50):
 *   - Encoded as BT.601, decoded as BT.601 -> R~200, G~49, B~50 (preserves source color)
 *   - Encoded as BT.709, decoded as BT.601 -> R~184, G~31, B~49 (darkened/desaturated shift)
 *   - Encoded as BT.601, decoded as BT.709 -> R~213, G~64, B~50 (oversaturated shift)
 *   - Encoded as BT.709, decoded as BT.709 -> R~198, G~47, B~49 (preserves source color)
 */

export interface ColorMatrixCoefficients {
  readonly kr: number;
  readonly kg: number;
  readonly kb: number;
}

export const BT601_COEFFICIENTS: ColorMatrixCoefficients = Object.freeze({
  kr: 0.299,
  kg: 0.587,
  kb: 0.114,
});

export const BT709_COEFFICIENTS: ColorMatrixCoefficients = Object.freeze({
  kr: 0.2126,
  kg: 0.7152,
  kb: 0.0722,
});

/** Resolves the default color matrix for an untagged video stream based on display height. */
export function defaultUntaggedColorMatrix(displayHeight: number): 'bt601' | 'bt709' {
  if (!Number.isFinite(displayHeight) || displayHeight <= 0) {
    throw new RangeError('displayHeight must be a positive finite number');
  }
  return displayHeight < 720 ? 'bt601' : 'bt709';
}

/** Converts normalized RGB [0..1] to YCbCr using specified matrix coefficients. */
export function rgbToYcbcr(
  r: number,
  g: number,
  b: number,
  coeffs: ColorMatrixCoefficients,
): { y: number; cb: number; cr: number } {
  const y = coeffs.kr * r + coeffs.kg * g + coeffs.kb * b;
  const cb = (b - y) / (2 * (1 - coeffs.kb));
  const cr = (r - y) / (2 * (1 - coeffs.kr));
  return { y, cb, cr };
}

/** Converts YCbCr back to RGB [0..1] using specified matrix coefficients. */
export function ycbcrToRgb(
  y: number,
  cb: number,
  cr: number,
  coeffs: ColorMatrixCoefficients,
): { r: number; g: number; b: number } {
  const r = y + 2 * (1 - coeffs.kr) * cr;
  const b = y + 2 * (1 - coeffs.kb) * cb;
  const g = (y - coeffs.kr * r - coeffs.kb * b) / coeffs.kg;
  return { r, g, b };
}

describe('untagged color space decode guard (C-078)', () => {
  it('classifies heights below 720 as BT.601 and 720 or above as BT.709', () => {
    expect(defaultUntaggedColorMatrix(480)).toBe('bt601');
    expect(defaultUntaggedColorMatrix(576)).toBe('bt601');
    expect(defaultUntaggedColorMatrix(719)).toBe('bt601');

    expect(defaultUntaggedColorMatrix(720)).toBe('bt709');
    expect(defaultUntaggedColorMatrix(1080)).toBe('bt709');
    expect(defaultUntaggedColorMatrix(2160)).toBe('bt709');

    expect(() => defaultUntaggedColorMatrix(0)).toThrow(RangeError);
    expect(() => defaultUntaggedColorMatrix(-480)).toThrow(RangeError);
  });

  it('mathematically reproduces the cross-matrix color shifts observed in c2-untagged-decode-evidence', () => {
    // Source color RGB(200, 50, 50) normalized to [0..1]
    const srcR = 200 / 255;
    const srcG = 50 / 255;
    const srcB = 50 / 255;

    // 1. Encode with BT.601, decode with BT.601 (SD matching decode)
    const yuv601 = rgbToYcbcr(srcR, srcG, srcB, BT601_COEFFICIENTS);
    const decoded601Matching = ycbcrToRgb(yuv601.y, yuv601.cb, yuv601.cr, BT601_COEFFICIENTS);
    expect(Math.round(decoded601Matching.r * 255)).toBe(200);
    expect(Math.round(decoded601Matching.g * 255)).toBe(50);
    expect(Math.round(decoded601Matching.b * 255)).toBe(50);

    // 2. Encode with BT.709, decode with BT.601 (SD mismatch: off source ~184, 31, 49)
    const yuv709 = rgbToYcbcr(srcR, srcG, srcB, BT709_COEFFICIENTS);
    const decodedSdMismatch = ycbcrToRgb(yuv709.y, yuv709.cb, yuv709.cr, BT601_COEFFICIENTS);
    const sdMismatchR = Math.round(decodedSdMismatch.r * 255);
    const sdMismatchG = Math.round(decodedSdMismatch.g * 255);
    expect(sdMismatchR).toBeLessThanOrEqual(188);
    expect(sdMismatchG).toBeLessThanOrEqual(35);

    // 3. Encode with BT.601, decode with BT.709 (HD mismatch: off source ~213, 64, 50)
    const decodedHdMismatch = ycbcrToRgb(yuv601.y, yuv601.cb, yuv601.cr, BT709_COEFFICIENTS);
    const hdMismatchR = Math.round(decodedHdMismatch.r * 255);
    const hdMismatchG = Math.round(decodedHdMismatch.g * 255);
    expect(hdMismatchR).toBeGreaterThanOrEqual(210);
    expect(hdMismatchG).toBeGreaterThanOrEqual(60);

    // 4. Encode with BT.709, decode with BT.709 (HD matching decode)
    const decoded709Matching = ycbcrToRgb(yuv709.y, yuv709.cb, yuv709.cr, BT709_COEFFICIENTS);
    expect(Math.round(decoded709Matching.r * 255)).toBe(200);
    expect(Math.round(decoded709Matching.g * 255)).toBe(50);
    expect(Math.round(decoded709Matching.b * 255)).toBe(50);
  });
});
