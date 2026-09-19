/**
 * Frame color analytics and shot matching for `@joy-media/motion-core`.
 *
 * Pure, zero-dependency helpers that derive a compact `FrameColorStats`
 * descriptor from raw pixels (per-channel mean, standard deviation, and the
 * eight-band HSL histogram defined by `HSL_BAND_IDS`) and then use those
 * descriptors to align a `candidate` frame to a `reference` frame:
 *
 *   - {@link solveShotMatchAdjustments} returns the minimal `{R,G,B}` lift /
 *     gamma / gain + exposure / saturation correction that closes the mean
 *     and luminance gap to the reference.
 *   - {@link solveShotMatchColorGrade} returns a full `ColorGradeV2` whose
 *     lift/gamma/gain and `ColorAdjustments` blocks carry those corrections,
 *     with all other blocks left at identity.
 *
 * Both solvers are deterministic, allocation-light beyond the returned
 * grade, and operate strictly on SDR display-referred Rec.709/sRGB numbers —
 * the same domain the schema declares.
 */

import type { ColorAdjustments, ColorGradeV2 } from '@joy-media/project-schema';
import {
  HSL_BAND_IDS,
  IDENTITY_COLOR_ADJUSTMENTS,
  createIdentityColorGrade,
} from '@joy-media/project-schema';

/**
 * Compact, deterministic descriptor for one frame's color signature.
 *
 * Pixel counts feed the histogram; per-channel statistics use the
 * Rec.709/sRGB display domain the rest of the editor assumes. HSL banding
 * follows `HSL_BAND_IDS`, so histograms are always eight entries in stable
 * order — handy for diffing two frames without re-sorting.
 */
export interface FrameColorStats {
  /** Total pixels sampled (sRGB triples). */
  readonly sampleCount: number;
  /** Per-channel mean over `[0,1]`, in `{ r, g, b }` order. */
  readonly meanRgb: { readonly r: number; readonly g: number; readonly b: number };
  /** Per-channel standard deviation over `[0,1]`. */
  readonly stdRgb: { readonly r: number; readonly g: number; readonly b: number };
  /** Rec.709 luminance mean over `[0,1]`. */
  readonly luma: number;
  /** Rec.709 luminance standard deviation over `[0,1]`. */
  readonly lumaStd: number;
  /** Relative share of pixels (`sum == 1`) falling into each HSL band id. */
  readonly hslHistogram: Readonly<Record<(typeof HSL_BAND_IDS)[number], number>>;
}

/** Input pixels are linearised triplets of red, green, blue in `[0,1]`. */
export interface RgbPixel {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const REC709_R = 0.2126;
const REC709_G = 0.7152;
const REC709_B = 0.0722;

/** Extracts a {@link FrameColorStats} descriptor from a flat array of pixels. */
export function extractFrameColorStats(pixels: readonly RgbPixel[]): FrameColorStats {
  if (pixels.length === 0) {
    const zero = { r: 0, g: 0, b: 0 };
    const histogram = Object.freeze(
      Object.fromEntries(HSL_BAND_IDS.map((id) => [id, 0])) as Record<
        (typeof HSL_BAND_IDS)[number],
        number
      >,
    );
    return {
      sampleCount: 0,
      meanRgb: zero,
      stdRgb: zero,
      luma: 0,
      lumaStd: 0,
      hslHistogram: histogram,
    };
  }

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumLuma = 0;
  const histogram = Object.fromEntries(HSL_BAND_IDS.map((id) => [id, 0])) as Record<
    (typeof HSL_BAND_IDS)[number],
    number
  >;

  for (const pixel of pixels) {
    const r = clamp01(pixel.r);
    const g = clamp01(pixel.g);
    const b = clamp01(pixel.b);
    sumR += r;
    sumG += g;
    sumB += b;
    sumLuma += REC709_R * r + REC709_G * g + REC709_B * b;
    histogram[classifyHslBand(r, g, b)] += 1;
  }

  const count = pixels.length;
  const meanR = sumR / count;
  const meanG = sumG / count;
  const meanB = sumB / count;
  const luma = sumLuma / count;

  let varR = 0;
  let varG = 0;
  let varB = 0;
  let varLuma = 0;
  for (const pixel of pixels) {
    const r = clamp01(pixel.r);
    const g = clamp01(pixel.g);
    const b = clamp01(pixel.b);
    const pixelLuma = REC709_R * r + REC709_G * g + REC709_B * b;
    varR += (r - meanR) ** 2;
    varG += (g - meanG) ** 2;
    varB += (b - meanB) ** 2;
    varLuma += (pixelLuma - luma) ** 2;
  }

  const stdR = Math.sqrt(varR / count);
  const stdG = Math.sqrt(varG / count);
  const stdB = Math.sqrt(varB / count);
  const stdLuma = Math.sqrt(varLuma / count);

  for (const id of HSL_BAND_IDS) {
    histogram[id] = histogram[id]! / count;
  }

  return {
    sampleCount: count,
    meanRgb: { r: meanR, g: meanG, b: meanB },
    stdRgb: { r: stdR, g: stdG, b: stdB },
    luma,
    lumaStd: stdLuma,
    hslHistogram: Object.freeze(histogram),
  };
}

/** Match correction: per-channel lift/gamma/gain plus adjustments. */
export interface ShotMatchAdjustments {
  /** Per-channel lift (offset) applied after exposure, in `[-1, 1]`. */
  readonly lift: { readonly r: number; readonly g: number; readonly b: number };
  /** Per-channel gamma exponent (1 = identity), strictly positive. */
  readonly gamma: { readonly r: number; readonly g: number; readonly b: number };
  /** Per-channel gain (multiplier), strictly positive. */
  readonly gain: { readonly r: number; readonly g: number; readonly b: number };
  /** Exposure offset in stops (added to schema `exposure`). */
  readonly exposure: number;
  /**
   * Saturation multiplier derived from the per-channel std-dev ratio
   * (schema `saturation` is unit-base; `1` is identity).
   */
  readonly saturation: number;
  /** Mean residual after correction, summed across channels. */
  readonly residual: number;
}

/**
 * Returns the minimal lift/gamma/gain + exposure/saturation correction that
 * aligns the candidate frame's per-channel mean and luminance to the
 * reference frame's.
 *
 * The candidate's white balance is nudged toward the reference via the
 * difference in channel means, leaving neutral pixels close to neutral. The
 * gamma term closes the mean-luminance gap; gain closes the per-channel
 * mean ratio. `saturation` is the ratio `ref.stdMean / cand.stdMean` so a
 * dull candidate is pushed toward the reference's contrast.
 */
export function solveShotMatchAdjustments(
  reference: FrameColorStats,
  candidate: FrameColorStats,
): ShotMatchAdjustments {
  assertFrameColorStats(reference, 'reference');
  assertFrameColorStats(candidate, 'candidate');

  const refMean = reference.meanRgb;
  const candMean = candidate.meanRgb;

  const lr = clampUnitSigned(refMean.r - candMean.r);
  const lg = clampUnitSigned(refMean.g - candMean.g);
  const lb = clampUnitSigned(refMean.b - candMean.b);

  const exposure = stopsBetween(candidate.luma, reference.luma);

  const gr = safeRatio(refMean.r, afterLiftGamma(candMean.r, lr));
  const gg = safeRatio(refMean.g, afterLiftGamma(candMean.g, lg));
  const gb = safeRatio(refMean.b, afterLiftGamma(candMean.b, lb));

  const refStdMean = meanOfTriple(reference.stdRgb);
  const candStdMean = meanOfTriple(candidate.stdRgb);
  const saturation = safeRatio(refStdMean, candStdMean);

  const exposureLinear = Math.pow(2, exposure);
  const correctedCand = {
    r: (candMean.r + lr) * exposureLinear * gg,
    g: (candMean.g + lg) * exposureLinear * gg,
    b: (candMean.b + lb) * exposureLinear * gg,
  };
  const residual = clampedResidual(refMean, correctedCand);

  return Object.freeze({
    lift: Object.freeze({ r: lr, g: lg, b: lb }),
    gamma: Object.freeze({ r: gr, g: gg, b: gb }),
    gain: Object.freeze({
      r: safeRatio(refMean.r, (candMean.r + lr) * exposureLinear),
      g: safeRatio(refMean.g, (candMean.g + lg) * exposureLinear),
      b: safeRatio(refMean.b, (candMean.b + lb) * exposureLinear),
    }),
    exposure,
    saturation,
    residual,
  });
}

/**
 * Returns a `ColorGradeV2` whose lift/gamma/gain and `adjust` blocks encode
 * the shot-match correction. All other blocks remain at identity so the grade
 * is a minimal, reversible overlay.
 */
export function solveShotMatchColorGrade(
  reference: FrameColorStats,
  candidate: FrameColorStats,
): ColorGradeV2 {
  const match = solveShotMatchAdjustments(reference, candidate);
  const identity = createIdentityColorGrade();
  const adjust: ColorAdjustments = {
    ...IDENTITY_COLOR_ADJUSTMENTS,
    exposure: IDENTITY_COLOR_ADJUSTMENTS.exposure + match.exposure,
    saturation: IDENTITY_COLOR_ADJUSTMENTS.saturation * match.saturation,
  };
  return {
    ...identity,
    enabled: true,
    lift: meanOfTriple(match.lift),
    gamma: meanOfTriple(match.gamma),
    gain: meanOfTriple(match.gain),
    adjust,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

function clampUnitSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < -0.2) return -0.2;
  return value > 0.2 ? 0.2 : value;
}

function safeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return 1;
  if (denominator <= 1e-6) return 1;
  const ratio = numerator / denominator;
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return ratio > 2 ? 2 : ratio;
}

function stopsBetween(candidate: number, reference: number): number {
  if (candidate <= 1e-6) return reference > 0 ? 1 : 0;
  const ratio = reference / candidate;
  if (ratio <= 0) return 0;
  const stops = Math.log2(ratio);
  if (!Number.isFinite(stops)) return 0;
  return stops > 2 ? 2 : stops < -2 ? -2 : stops;
}

function afterLiftGamma(value: number, lift: number): number {
  const lifted = value + lift;
  if (lifted <= 0) return 1e-6;
  return lifted;
}

function meanOfTriple(values: {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}): number {
  return (values.r + values.g + values.b) / 3;
}

function clampedResidual(
  ref: { readonly r: number; readonly g: number; readonly b: number },
  corrected: { readonly r: number; readonly g: number; readonly b: number },
): number {
  const dr = ref.r - corrected.r;
  const dg = ref.g - corrected.g;
  const db = ref.b - corrected.b;
  return Math.min(1, Math.sqrt(dr * dr + dg * dg + db * db));
}

function assertFrameColorStats(value: FrameColorStats, role: string): void {
  if (!Number.isFinite(value.luma)) throw new RangeError(`${role} luma must be finite`);
  if (value.sampleCount <= 0) throw new RangeError(`${role} frame is empty`);
  for (const channel of ['r', 'g', 'b'] as const) {
    if (!Number.isFinite(value.meanRgb[channel]))
      throw new RangeError(`${role} mean.${channel} must be finite`);
  }
}

function classifyHslBand(r: number, g: number, b: number): (typeof HSL_BAND_IDS)[number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta < 1e-6) return 'red';
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return HSL_BAND_IDS[Math.floor((hue % 360) / 45)]!;
}
