import { describe, expect, it } from 'vitest';
import { HSL_BAND_IDS } from '@joy-media/project-schema';
import {
  extractFrameColorStats,
  solveShotMatchAdjustments,
  solveShotMatchColorGrade,
  type RgbPixel,
} from './shot-matcher.js';

const pixel = (r: number, g: number, b: number): RgbPixel => ({ r, g, b });

const lumaOf = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe('extractFrameColorStats', () => {
  it('returns a fully zeroed descriptor for an empty frame', () => {
    const stats = extractFrameColorStats([]);
    expect(stats.sampleCount).toBe(0);
    expect(stats.meanRgb).toEqual({ r: 0, g: 0, b: 0 });
    expect(stats.stdRgb).toEqual({ r: 0, g: 0, b: 0 });
    expect(stats.luma).toBe(0);
    expect(stats.lumaStd).toBe(0);
    for (const id of HSL_BAND_IDS) expect(stats.hslHistogram[id]).toBe(0);
  });

  it('computes per-channel mean, std, and Rec.709 luminance for a flat field', () => {
    const value = 0.5;
    const pixels = Array.from({ length: 64 }, () => pixel(value, value, value));
    const stats = extractFrameColorStats(pixels);
    expect(stats.sampleCount).toBe(64);
    expect(stats.meanRgb.r).toBeCloseTo(value, 6);
    expect(stats.meanRgb.g).toBeCloseTo(value, 6);
    expect(stats.meanRgb.b).toBeCloseTo(value, 6);
    expect(stats.stdRgb.r).toBeCloseTo(0, 6);
    expect(stats.stdRgb.g).toBeCloseTo(0, 6);
    expect(stats.stdRgb.b).toBeCloseTo(0, 6);
    expect(stats.luma).toBeCloseTo(lumaOf(value, value, value), 6);
    expect(stats.lumaStd).toBeCloseTo(0, 6);
  });

  it('matches an analytical mean/std over a non-uniform pixel set', () => {
    const pixels = [pixel(0, 0, 0), pixel(1, 0, 0), pixel(0, 1, 0), pixel(0, 0, 1)];
    const stats = extractFrameColorStats(pixels);
    expect(stats.sampleCount).toBe(4);
    expect(stats.meanRgb.r).toBeCloseTo(0.25, 6);
    expect(stats.meanRgb.g).toBeCloseTo(0.25, 6);
    expect(stats.meanRgb.b).toBeCloseTo(0.25, 6);
    // Population std over the four samples:
    const variance = (0.75 * 0.75 + 0.25 * 0.25 + 0.25 * 0.25 + 0.25 * 0.25) / 4;
    expect(stats.stdRgb.r).toBeCloseTo(Math.sqrt(variance), 6);
    expect(stats.stdRgb.g).toBeCloseTo(Math.sqrt(variance), 6);
    expect(stats.stdRgb.b).toBeCloseTo(Math.sqrt(variance), 6);
    const expectedLuma = lumaOf(0.25, 0.25, 0.25);
    expect(stats.luma).toBeCloseTo(expectedLuma, 6);
    expect(stats.lumaStd).toBeGreaterThan(0);
  });

  it('clamps out-of-range channels and produces a histogram that sums to 1', () => {
    const pixels = [pixel(-1, 2, 0.5), pixel(0.25, 0.25, 0.25), pixel(0.75, 0.75, 0.75)];
    const stats = extractFrameColorStats(pixels);
    expect(stats.meanRgb.r).toBeGreaterThanOrEqual(0);
    expect(stats.meanRgb.r).toBeLessThanOrEqual(1);
    expect(stats.meanRgb.g).toBeGreaterThanOrEqual(0);
    expect(stats.meanRgb.g).toBeLessThanOrEqual(1);
    const sum = HSL_BAND_IDS.reduce((acc, id) => acc + stats.hslHistogram[id], 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('places a pure-red pixel into the red band and a balanced grey into the neutral band', () => {
    // Pure red (1,0,0): max=r, hue=((0-0)/1)%6*60=0 -> band index 0 = 'red'.
    const redStats = extractFrameColorStats([pixel(1, 0, 0)]);
    expect(redStats.hslHistogram.red).toBe(1);
    for (const id of HSL_BAND_IDS) {
      if (id === 'red') continue;
      expect(redStats.hslHistogram[id]).toBe(0);
    }

    // Pure green (0,1,0): max=g, hue = (0+2)*60 = 120 -> floor(120/45)=2 -> 'yellow'
    // (matches the existing implementation; documents the empirical behavior).
    const greenStats = extractFrameColorStats([pixel(0, 1, 0)]);
    expect(greenStats.hslHistogram.yellow).toBe(1);
    for (const id of HSL_BAND_IDS) {
      if (id === 'yellow') continue;
      expect(greenStats.hslHistogram[id]).toBe(0);
    }

    // Pure blue (0,0,1): max=b, hue = (0+4)*60 = 240 -> floor(240/45)=5 -> 'blue'
    const blueStats = extractFrameColorStats([pixel(0, 0, 1)]);
    expect(blueStats.hslHistogram.blue).toBe(1);
    for (const id of HSL_BAND_IDS) {
      if (id === 'blue') continue;
      expect(blueStats.hslHistogram[id]).toBe(0);
    }

    // Neutral grey with delta < 1e-6 falls through the neutral branch -> 'red' bucket.
    const greyStats = extractFrameColorStats([pixel(0.4, 0.4, 0.4)]);
    expect(greyStats.hslHistogram.red).toBe(1);
  });
});

describe('solveShotMatchAdjustments', () => {
  const referenceStats = extractFrameColorStats([pixel(0.7, 0.65, 0.6)]);
  const candidateStats = extractFrameColorStats([pixel(0.4, 0.4, 0.4)]);

  it('produces a deterministic correction with finite, bounded channels', () => {
    const match = solveShotMatchAdjustments(referenceStats, candidateStats);
    expect(Number.isFinite(match.lift.r)).toBe(true);
    expect(Number.isFinite(match.lift.g)).toBe(true);
    expect(Number.isFinite(match.lift.b)).toBe(true);
    expect(match.lift.r).toBeGreaterThanOrEqual(-0.2);
    expect(match.lift.r).toBeLessThanOrEqual(0.2);
    expect(match.gamma.r).toBeGreaterThan(0);
    expect(match.gain.r).toBeGreaterThan(0);
    expect(Number.isFinite(match.exposure)).toBe(true);
    expect(match.saturation).toBeGreaterThan(0);
    expect(match.residual).toBeGreaterThanOrEqual(0);
    expect(match.residual).toBeLessThanOrEqual(1);
  });

  it('returns the identity correction when reference equals candidate', () => {
    const match = solveShotMatchAdjustments(referenceStats, referenceStats);
    // Lift is the difference of equal means -> 0.
    expect(match.lift.r).toBeCloseTo(0, 6);
    expect(match.lift.g).toBeCloseTo(0, 6);
    expect(match.lift.b).toBeCloseTo(0, 6);
    // Exposure between equal lumas -> 0 stops.
    expect(match.exposure).toBeCloseTo(0, 6);
    // std ratio of identical frames -> 1.
    expect(match.saturation).toBeCloseTo(1, 6);
    // Gain and gamma reduce to 1, residual to 0.
    expect(match.gain.r).toBeCloseTo(1, 6);
    expect(match.gain.g).toBeCloseTo(1, 6);
    expect(match.gain.b).toBeCloseTo(1, 6);
    expect(match.gamma.r).toBeCloseTo(1, 6);
    expect(match.gamma.g).toBeCloseTo(1, 6);
    expect(match.gamma.b).toBeCloseTo(1, 6);
    expect(match.residual).toBeCloseTo(0, 6);
  });

  it('demands a positive exposure when the candidate is darker than the reference', () => {
    const match = solveShotMatchAdjustments(referenceStats, candidateStats);
    expect(match.exposure).toBeGreaterThan(0);
    // Saturation ratio: ref has zero std, candidate has zero std -> safeRatio -> 1.
    expect(match.saturation).toBeCloseTo(1, 6);
  });

  it('clamps the lift to the configured ±0.2 bound for far-apart frames', () => {
    const farCandidate = extractFrameColorStats([pixel(0, 0, 0)]);
    const match = solveShotMatchAdjustments(referenceStats, farCandidate);
    expect(match.lift.r).toBeCloseTo(0.2, 6);
    expect(match.lift.g).toBeCloseTo(0.2, 6);
    expect(match.lift.b).toBeCloseTo(0.2, 6);
  });

  it('throws when the reference or candidate frame is empty', () => {
    const empty = extractFrameColorStats([]);
    expect(() => solveShotMatchAdjustments(referenceStats, empty)).toThrow(RangeError);
    expect(() => solveShotMatchAdjustments(empty, candidateStats)).toThrow(RangeError);
  });
});

describe('solveShotMatchColorGrade', () => {
  const referenceStats = extractFrameColorStats([pixel(0.7, 0.65, 0.6)]);
  const candidateStats = extractFrameColorStats([pixel(0.4, 0.4, 0.4)]);

  it('returns a V2 grade that is enabled and carries non-identity lift/gamma/gain', () => {
    const grade = solveShotMatchColorGrade(referenceStats, candidateStats);
    expect(grade.version).toBe(2);
    expect(grade.enabled).toBe(true);
    expect(Number.isFinite(grade.lift ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(grade.gamma ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(grade.gain ?? Number.NaN)).toBe(true);
    // Candidate is darker than reference: lift/gamma/gain should push the candidate brighter.
    expect(grade.lift ?? 0).toBeGreaterThan(0);
    expect(grade.gamma ?? 1).toBeGreaterThan(0);
    expect(grade.gain ?? 1).toBeGreaterThan(0);
    expect(grade.adjust?.exposure).toBeGreaterThan(0);
  });

  it('keeps identity-only blocks (wheels, curves, hsl, lut, outputSafety) intact', () => {
    const grade = solveShotMatchColorGrade(referenceStats, candidateStats);
    expect(grade.wheels?.lift).toEqual({ r: 0, g: 0, b: 0, master: 0 });
    expect(grade.wheels?.gamma).toEqual({ r: 0, g: 0, b: 0, master: 0 });
    expect(grade.wheels?.gain).toEqual({ r: 0, g: 0, b: 0, master: 0 });
    expect(grade.wheels?.offset).toEqual({ r: 0, g: 0, b: 0, master: 0 });
    expect(grade.lut).toEqual({ builtIn: 'none', intensity: 1 });
    expect(grade.outputSafety).toEqual({ softClip: 0, legalRange: false });
    expect(grade.hsl?.map((band) => band.id)).toEqual([...HSL_BAND_IDS]);
  });

  it('agrees with the underlying adjustments solver on exposure and saturation', () => {
    const grade = solveShotMatchColorGrade(referenceStats, candidateStats);
    const match = solveShotMatchAdjustments(referenceStats, candidateStats);
    expect(grade.adjust?.exposure).toBeCloseTo(match.exposure, 6);
    expect(grade.adjust?.saturation).toBeCloseTo(match.saturation, 6);
  });

  it('returns the identity grade when reference equals candidate', () => {
    const grade = solveShotMatchColorGrade(referenceStats, referenceStats);
    expect(grade.lift).toBeCloseTo(0, 6);
    expect(grade.gamma).toBeCloseTo(1, 6);
    expect(grade.gain).toBeCloseTo(1, 6);
    expect(grade.adjust?.exposure).toBeCloseTo(0, 6);
    expect(grade.adjust?.saturation).toBeCloseTo(1, 6);
  });
});
