import { describe, expect, it } from 'vitest';
import { IDENTITY_COLOR_ADJUSTMENTS } from '@joy-media/project-schema';
import type { ColorGradeIR } from '@joy-media/render-ir';
import { applyColorGradeV2 } from '../../../packages/renderer-pixi/src/color-grade-math.js';
import { LOOK_NOTES } from './ColorPanel.js';

/**
 * The looks through the renderer's own maths (`applyBuiltInLook`), so a
 * description that drifts away from the maths fails this test instead of the
 * colourist. Nothing but the look is in the grade: every other control is at
 * its identity value.
 */
function applyLook(builtIn: string, rgb: readonly [number, number, number]) {
  const grade: ColorGradeIR = {
    version: 2,
    lift: 0,
    gamma: 1,
    gain: 1,
    saturation: 1,
    adjust: { ...IDENTITY_COLOR_ADJUSTMENTS },
    lut: { builtIn, intensity: 1 },
  };
  return applyColorGradeV2(rgb[0], rgb[1], rgb[2], grade);
}

describe('look descriptions', () => {
  it('says that None leaves the picture alone, and the maths leaves it alone', () => {
    expect(LOOK_NOTES.none).toMatch(/no look/i);

    const [red, green, blue] = applyLook('none', [0.2, 0.5, 0.9]);
    expect(red).toBeCloseTo(0.2, 6);
    expect(green).toBeCloseTo(0.5, 6);
    expect(blue).toBeCloseTo(0.9, 6);
  });

  it('describes Clean Contrast as a 1.22 stretch about the mid grey', () => {
    expect(LOOK_NOTES['clean-contrast']).toMatch(/1\.22/);
    expect(LOOK_NOTES['clean-contrast']).toMatch(/mid grey/i);

    const [mid] = applyLook('clean-contrast', [0.5, 0.5, 0.5]);
    expect(mid).toBeCloseTo(0.5, 6);
    const [quarter] = applyLook('clean-contrast', [0.75, 0.75, 0.75]);
    expect((quarter - 0.5) / 0.25).toBeCloseTo(1.22, 6);
    // The colours get stronger: the gap between two channels grows by 1.22.
    const [top, bottom] = applyLook('clean-contrast', [0.6, 0.4, 0.4]);
    expect(top - bottom).toBeCloseTo(0.2 * 1.22, 6);
  });

  it('describes Soft Film as lifted blacks, rolled-off highlights and a warmer picture', () => {
    expect(LOOK_NOTES['soft-film']).toMatch(/blacks/i);
    expect(LOOK_NOTES['soft-film']).toMatch(/highlights/i);
    expect(LOOK_NOTES['soft-film']).toMatch(/warms the picture/i);

    // The blacks lift to about 3 %, and red is lifted more than blue.
    const [blackRed, , blackBlue] = applyLook('soft-film', [0, 0, 0]);
    expect(blackRed).toBeCloseTo(0.035, 6);
    expect(blackBlue).toBeCloseTo(0.025, 6);
    // The highlights roll off below white.
    const [whiteRed] = applyLook('soft-film', [1, 1, 1]);
    expect(whiteRed).toBeLessThan(1);
    expect(whiteRed).toBeCloseTo(0.945, 6);
    // Neutral turns warm: red above green above blue.
    const [red, green, blue] = applyLook('soft-film', [0.5, 0.5, 0.5]);
    expect(red).toBeGreaterThan(green);
    expect(green).toBeGreaterThan(blue);
  });

  it('describes Warm Cinema as warm shadows and cool highlights', () => {
    expect(LOOK_NOTES['warm-cinema']).toMatch(/warm shadows/i);
    expect(LOOK_NOTES['warm-cinema']).toMatch(/cool highlights/i);

    const [shadowRed, , shadowBlue] = applyLook('warm-cinema', [0.1, 0.1, 0.1]);
    const [highlightRed, , highlightBlue] = applyLook('warm-cinema', [0.9, 0.9, 0.9]);
    // Red is added in proportion to (1 - luma): most of it in the shadows.
    expect(shadowRed - 0.1).toBeGreaterThan(highlightRed - 0.9);
    // Blue is taken away in proportion to luma: most of it in the highlights.
    expect(0.9 - highlightBlue).toBeGreaterThan(0.1 - shadowBlue);
    // Warm shadows, cool highlights.
    expect(shadowRed).toBeGreaterThan(shadowBlue);
    expect(highlightBlue).toBeLessThan(highlightRed);
  });

  it('describes Cool Fade as a cool lift in the shadows that spares the highlights', () => {
    expect(LOOK_NOTES['cool-fade']).toMatch(/shadows/i);
    expect(LOOK_NOTES['cool-fade']).toMatch(/most blue/i);
    expect(LOOK_NOTES['cool-fade']).toMatch(/highlights/i);

    const [shadowRed, shadowGreen, shadowBlue] = applyLook('cool-fade', [0.1, 0.1, 0.1]);
    const [, , highlightBlue] = applyLook('cool-fade', [0.9, 0.9, 0.9]);
    // Blue is lifted the most in the shadows, and the shadows turn cool.
    expect(shadowBlue - 0.1).toBeGreaterThan(shadowRed - 0.1);
    expect(shadowRed - 0.1).toBeGreaterThan(shadowGreen - 0.1);
    expect(shadowBlue).toBeGreaterThan(shadowRed);
    // The highlights are left nearly alone.
    expect(highlightBlue - 0.9).toBeLessThan(0.01);
  });

  it('describes Monochrome as the picture in grey', () => {
    expect(LOOK_NOTES.monochrome).toMatch(/grey/i);

    const [red, green, blue] = applyLook('monochrome', [0.2, 0.6, 0.9]);
    expect(red).toBeCloseTo(green, 6);
    expect(green).toBeCloseTo(blue, 6);
    // The grey keeps the light of the picture it came from.
    expect(red).toBeGreaterThan(0.2);
    expect(red).toBeLessThan(0.9);
  });
});
