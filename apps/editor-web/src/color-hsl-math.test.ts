import { describe, expect, it } from 'vitest';
import { IDENTITY_COLOR_ADJUSTMENTS, IDENTITY_HSL_BANDS } from '@joy-media/project-schema';
import type { ColorGradeIR } from '@joy-media/render-ir';
import { applyColorGradeV2 } from '../../../packages/renderer-pixi/src/color-grade-math.js';
import {
  canAddCustomBand,
  clampHslValue,
  formatHslValue,
  gradeHslBands,
  hasPickableHue,
  HSL_CONTROLS,
  hslBandChipColour,
  isIdentityHslBand,
  nearestHslBand,
  pickHslBand,
  pixelHue,
  withBandCentre,
  withHslBandReset,
  withHslValue,
  wrapHue,
} from './color-hsl-math.js';

const bands = IDENTITY_HSL_BANDS;
const ID = (index: number) => bands[index]!.id;

describe('hue to the nearest band', () => {
  it('finds the band of each primary and secondary colour', () => {
    expect(ID(nearestHslBand(bands, 0))).toBe('red');
    expect(ID(nearestHslBand(bands, 120))).toBe('green');
    expect(ID(nearestHslBand(bands, 180))).toBe('cyan');
    expect(ID(nearestHslBand(bands, 240))).toBe('blue');
    expect(ID(nearestHslBand(bands, 300))).toBe('magenta');
  });

  it('wraps around red: 350° and 359.9° are red, not magenta', () => {
    expect(ID(nearestHslBand(bands, 350))).toBe('red');
    expect(ID(nearestHslBand(bands, 359.9))).toBe('red');
    expect(ID(nearestHslBand(bands, 330))).toBe('magenta');
    expect(ID(nearestHslBand(bands, 360))).toBe('red');
    expect(ID(nearestHslBand(bands, -10))).toBe('red');
  });

  it('uses the engine normalisation of band centres (a centre past 360 wraps)', () => {
    const moved = withHslValue(bands, 7, 'hue', 0);
    // Stored out of range on purpose: the engine reads 365° as 5°.
    const raw = moved.map((band, index) => (index === 7 ? { ...band, hue: 365 } : band));
    expect(ID(nearestHslBand(raw, 8))).toBe('magenta');
  });

  it('gives the first band on a tie', () => {
    // 22.5° is half-way between red (0°) and orange (45°).
    expect(ID(nearestHslBand(bands, 22.5))).toBe('red');
  });
});

describe('picked pixels', () => {
  it('reads the hue with the engine conversion', () => {
    expect(pixelHue({ r: 0, g: 255, b: 0 }).hue).toBeCloseTo(120, 9);
    expect(pixelHue({ r: 255, g: 0, b: 0 }).hue).toBeCloseTo(0, 9);
    expect(pixelHue({ r: 255, g: 0, b: 40 }).hue).toBeGreaterThan(350);
  });

  it('has no hue for greys, black and white', () => {
    expect(hasPickableHue({ r: 128, g: 128, b: 128 })).toBe(false);
    expect(hasPickableHue({ r: 0, g: 0, b: 0 })).toBe(false);
    expect(hasPickableHue({ r: 255, g: 255, b: 255 })).toBe(false);
    expect(hasPickableHue({ r: 130, g: 128, b: 128 })).toBe(false);
    expect(hasPickableHue({ r: 0, g: 200, b: 0 })).toBe(true);
    expect(pickHslBand(bands, { r: 90, g: 90, b: 90 })).toBeUndefined();
  });

  it('moves the nearest band onto the picked hue', () => {
    const picked = pickHslBand(bands, { r: 0, g: 255, b: 0 })!;
    expect(ID(picked.index)).toBe('green');
    expect(picked.hue).toBe(120);
    expect(picked.bands[picked.index]!.hue).toBe(120);
    // Only that band moves.
    picked.bands.forEach((band, index) => {
      if (index !== picked.index) expect(band).toBe(bands[index]);
    });
  });

  it('keeps a picked red just below 360 inside the circle', () => {
    const picked = pickHslBand(bands, { r: 255, g: 0, b: 1 })!;
    expect(ID(picked.index)).toBe('red');
    expect(picked.hue).toBeGreaterThanOrEqual(0);
    expect(picked.hue).toBeLessThan(360);
  });

  it('turns a pure green patch grey in the engine after the pick and saturation to minimum', () => {
    const picked = pickHslBand(bands, { r: 0, g: 255, b: 0 })!;
    const desaturated = withHslValue(picked.bands, picked.index, 'saturation', -1);
    const grade: ColorGradeIR = {
      version: 2,
      lift: 0,
      gamma: 1,
      gain: 1,
      saturation: 1,
      adjust: { ...IDENTITY_COLOR_ADJUSTMENTS },
      hsl: desaturated,
    };
    const [r, g, b] = applyColorGradeV2(0, 1, 0, grade);
    expect(Math.abs(r - g)).toBeLessThan(1e-6);
    expect(Math.abs(g - b)).toBeLessThan(1e-6);
    // A red patch is left alone.
    const red = applyColorGradeV2(1, 0, 0, grade);
    expect(red[0]).toBeCloseTo(1, 6);
    expect(red[1]).toBeCloseTo(0, 6);
  });

  it('cannot add a ninth band: the model and the engine hold eight', () => {
    expect(canAddCustomBand(bands)).toBe(false);
  });
});

describe('band maths edge cases', () => {
  it('wraps hues', () => {
    expect(wrapHue(360)).toBe(0);
    expect(wrapHue(-10)).toBe(350);
    expect(wrapHue(725)).toBe(5);
    expect(wrapHue(Number.NaN)).toBe(0);
  });

  it('wraps a centre and clamps the other values to their ranges', () => {
    expect(clampHslValue('hue', 360)).toBe(0);
    expect(clampHslValue('hue', -1)).toBe(359);
    expect(withBandCentre(bands, 0, -5)[0]!.hue).toBe(355);
    expect(clampHslValue('hueShift', 400)).toBe(180);
    expect(clampHslValue('hueShift', -400)).toBe(-180);
    expect(clampHslValue('saturation', -3)).toBe(-1);
    expect(clampHslValue('luminance', 2)).toBe(1);
    expect(clampHslValue('hueWidth', 0)).toBe(1);
    expect(clampHslValue('softness', 5)).toBe(1);
  });

  it('resets one band to where it started, the others are kept', () => {
    const changed = withHslValue(withBandCentre(bands, 3, 120), 3, 'saturation', -0.5);
    expect(isIdentityHslBand(changed[3]!, 3)).toBe(false);
    const reset = withHslBandReset(changed, 3);
    expect(reset[3]).toEqual(bands[3]);
    expect(isIdentityHslBand(reset[3]!, 3)).toBe(true);
  });

  it('fills a legacy band list: ids from the position, missing bands from identity', () => {
    const legacy = [{ hue: 10, hueWidth: 30, softness: 0.1, saturation: 0.2, luminance: 0 }];
    const filled = gradeHslBands(legacy);
    expect(filled).toHaveLength(8);
    expect(filled[0]!.id).toBe('red');
    expect(filled[0]!.hue).toBe(10);
    expect(filled[5]).toBe(bands[5]);
    expect(gradeHslBands(undefined)).toEqual(bands);
  });

  it('offers Hue shift, Saturation, Luminance and Width first', () => {
    expect(HSL_CONTROLS.filter((control) => control.primary).map((c) => c.label)).toEqual([
      'Hue shift',
      'Saturation',
      'Luminance',
      'Width',
    ]);
  });

  it('formats values and the chip colour', () => {
    const shift = HSL_CONTROLS.find((control) => control.key === 'hueShift')!;
    const saturation = HSL_CONTROLS.find((control) => control.key === 'saturation')!;
    expect(formatHslValue(shift, 12)).toBe('+12°');
    expect(formatHslValue(saturation, -0.5)).toBe('-0.50');
    expect(hslBandChipColour(-45)).toBe('hsl(315 85% 55%)');
  });
});
