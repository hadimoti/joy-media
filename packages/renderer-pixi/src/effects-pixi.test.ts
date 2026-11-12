import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColorGradeIR } from '@joy-media/render-ir';
import { buildPixiColorGradeFilter } from './effects-pixi.js';
import { normalizeColorGradeHslBands } from './color-grade-math.js';

const identity: ColorGradeIR = {
  version: 2,
  enabled: true,
  lift: 0,
  gamma: 1,
  gain: 1,
  saturation: 1,
};

describe('Pixi color-grade filter inputs', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => ({ getContext: () => null }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

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
