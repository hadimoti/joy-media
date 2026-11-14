import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColorGradeIR } from '@joy-media/render-ir';
import { buildPixiColorGradeFilter } from './effects-pixi.js';
import { normalizeColorGradeHslBands } from './color-grade-math.js';
import { parseCubeLut } from './lut.js';

const identity: ColorGradeIR = {
  version: 2,
  enabled: true,
  lift: 0,
  gamma: 1,
  gain: 1,
  saturation: 1,
};

const adjustPreviewCases = [
  { label: 'temperature', property: 'temperature', uniform: 'uTemperature', value: 0.4 },
  { label: 'tint', property: 'tint', uniform: 'uTint', value: -0.3 },
  { label: 'exposure', property: 'exposure', uniform: 'uExposure', value: 1.2 },
  { label: 'contrast', property: 'contrast', uniform: 'uContrast', value: 0.25 },
  { label: 'pivot', property: 'pivot', uniform: 'uPivot', value: 0.65 },
  { label: 'highlights', property: 'highlights', uniform: 'uHighlights', value: 0.35 },
  { label: 'shadows', property: 'shadows', uniform: 'uShadows', value: -0.2 },
  { label: 'whites', property: 'whites', uniform: 'uWhites', value: 0.45 },
  { label: 'blacks', property: 'blacks', uniform: 'uBlacks', value: -0.4 },
  { label: 'saturation', property: 'saturation', uniform: 'uSaturation', value: 1.4 },
  { label: 'vibrance', property: 'vibrance', uniform: 'uVibrance', value: 0.5 },
  { label: 'hue', property: 'hue', uniform: 'uHue', value: 45 },
] as const;

const builtInLookPreviewCases = [
  { look: 'clean-contrast', index: 0 },
  { look: 'soft-film', index: 2 },
  { look: 'warm-cinema', index: 3 },
  { look: 'cool-fade', index: 4 },
  { look: 'monochrome', index: 5 },
] as const;

describe('Pixi color-grade filter inputs', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => ({ getContext: () => null }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(adjustPreviewCases)(
    'binds Adjust $label to the preview shader',
    ({ property, uniform, value }) => {
      const grade = { ...identity, adjust: { [property]: value } } as ColorGradeIR;
      const filter = buildPixiColorGradeFilter(grade)!;
      const uniforms = filter.resources.colorGradeUniforms.uniforms as Record<string, number>;
      expect(uniforms[uniform]).toBe(value);
      filter.destroy();
    },
  );

  it.each(builtInLookPreviewCases)(
    'binds the $look look and intensity to the preview shader',
    ({ look, index }) => {
      const filter = buildPixiColorGradeFilter({
        ...identity,
        lut: { builtIn: look, intensity: 0.4 },
      })!;
      const uniforms = filter.resources.colorGradeUniforms.uniforms as Record<string, number>;
      expect(uniforms.uLook).toBe(index);
      expect(uniforms.uLookIntensity).toBe(0.4);
      filter.destroy();
    },
  );

  it('binds custom LUT intensity to the preview shader and omits the None look filter', () => {
    const cubeLut = parseCubeLut(
      `LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1`,
    );
    const filter = buildPixiColorGradeFilter(
      {
        ...identity,
        lut: { assetId: 'test-lut', sha256: 'a'.repeat(64), intensity: 0.35 },
      },
      cubeLut,
    )!;
    const uniforms = filter.resources.colorGradeUniforms.uniforms as Record<string, number>;
    expect(uniforms.uCubeEnabled).toBe(1);
    expect(uniforms.uCubeIntensity).toBe(0.35);
    filter.destroy();

    expect(
      buildPixiColorGradeFilter({ ...identity, lut: { builtIn: 'none', intensity: 1 } }),
    ).toBeUndefined();
  });

  it('caps HSL band widths to the CPU supported range', () => {
    const filter = buildPixiColorGradeFilter({
      ...identity,
      hsl: [
        {
          hue: 0,
          hueWidth: 360,
          softness: 0.2,
          saturation: 0.3,
          luminance: -0.1,
        },
      ],
    });
    expect(filter).toBeDefined();
    const uniforms = filter!.resources.colorGradeUniforms.uniforms as {
      uHslBands: Float32Array;
    };
    expect(uniforms.uHslBands.slice(0, 4)).toEqual(new Float32Array([0, 180, 0.2, 0]));
  });

  it('uploads the same normalized HSL bands used by the CPU path', () => {
    const hsl = Array.from({ length: 10 }, (_, index) => ({
      hue: index * 40,
      hueWidth: index === 0 ? 360 : 35,
      ...(index === 1 ? { hueShift: 220 } : {}),
      softness: 0.2,
      saturation: 0.1,
      luminance: -0.1,
    }));
    const grade: ColorGradeIR = { ...identity, hsl };
    const filter = buildPixiColorGradeFilter(grade)!;
    const uniforms = filter.resources.colorGradeUniforms.uniforms as {
      uHslBands: Float32Array;
    };
    const expected = new Float32Array(32);
    normalizeColorGradeHslBands(hsl).forEach((band, index) => {
      expected.set([band.hue, band.hueWidth, band.softness, band.hueShift], index * 4);
    });

    expect(uniforms.uHslBands).toEqual(expected);
    filter.destroy();
  });

  it('reuses curve resources for equivalent points in newly evaluated grades', () => {
    const curves = {
      rgb: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.4 },
        { x: 1, y: 1 },
      ],
      red: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      green: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      blue: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    } as const;
    const first = buildPixiColorGradeFilter({ ...identity, curves });
    const second = buildPixiColorGradeFilter({ ...identity, curves: structuredClone(curves) });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const texture = first!.resources.uCurveTexture;
    expect(second!.resources.uCurveTexture).toBe(texture);
    first!.destroy();
    expect(second!.resources.uCurveTexture).toBe(texture);
    second!.destroy();
    expect((texture as { destroyed?: boolean }).destroyed).toBe(true);
  });

  it('reuses a custom cube texture until its last filter is destroyed', () => {
    const cubeLut = {
      size: 2,
      domainMin: [0, 0, 0] as const,
      domainMax: [1, 1, 1] as const,
      data: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1,
      ]),
    };
    const grade: ColorGradeIR = {
      ...identity,
      lut: { assetId: 'lut-1', sha256: 'a'.repeat(64), intensity: 1 },
    };
    const first = buildPixiColorGradeFilter(grade, cubeLut)!;
    const second = buildPixiColorGradeFilter(grade, cubeLut)!;
    const texture = first.resources.uCubeLutTexture;

    expect(second.resources.uCubeLutTexture).toBe(texture);
    first.destroy();
    expect((texture as { destroyed?: boolean }).destroyed).not.toBe(true);

    const third = buildPixiColorGradeFilter(grade, cubeLut)!;
    expect(third.resources.uCubeLutTexture).toBe(texture);
    second.destroy();
    expect((texture as { destroyed?: boolean }).destroyed).not.toBe(true);
    third.destroy();
    expect((texture as { destroyed?: boolean }).destroyed).toBe(true);
  });
});
