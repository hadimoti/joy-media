import { describe, expect, it } from 'vitest';
import type { ColorGradeIR } from '@joy-media/render-ir';
import { applyColorGradeToPixels, isIdentityColorGrade } from './effects-cpu.js';
import { parseCubeLut } from './lut.js';
import { getColorCurveLuts } from './color-grade-math.js';

const identity: ColorGradeIR = {
  version: 2,
  enabled: true,
  lift: 0,
  gamma: 1,
  gain: 1,
  saturation: 1,
};

function gradePixel(
  grade: ColorGradeIR,
  rgb: readonly [number, number, number],
  lut?: ReturnType<typeof parseCubeLut>,
): number[] {
  const pixels = Uint8Array.of(rgb[0], rgb[1], rgb[2], 255);
  applyColorGradeToPixels(pixels, grade, lut);
  return [...pixels.slice(0, 3)];
}

const PATCH_CHART = {
  black: [0, 0, 0],
  shadow: [32, 32, 32],
  midGrey: [128, 128, 128],
  highlight: [224, 224, 224],
  white: [255, 255, 255],
  red: [220, 65, 35],
  mutedRed: [160, 120, 120],
} as const;

type ColorPatch = readonly [number, number, number];
type AdjustmentPatchCase = {
  readonly label: string;
  readonly adjust: NonNullable<ColorGradeIR['adjust']>;
  readonly input: ColorPatch;
  readonly assertDirection: (output: number[], input: ColorPatch) => void;
};

const adjustmentPatchCases: readonly AdjustmentPatchCase[] = [
  {
    label: 'temperature',
    adjust: { temperature: 1 },
    input: PATCH_CHART.midGrey,
    assertDirection: (output) => expect(output[0]).toBeGreaterThan(output[2]!),
  },
  {
    label: 'tint',
    adjust: { tint: 1 },
    input: PATCH_CHART.midGrey,
    assertDirection: (output) => {
      expect(output[0]).toBeGreaterThan(output[2]!);
      expect(output[2]).toBeGreaterThan(output[1]!);
    },
  },
  {
    label: 'exposure',
    adjust: { exposure: 1 },
    input: PATCH_CHART.midGrey,
    assertDirection: (output, input) => expect(output[0]).toBeGreaterThan(input[0]),
  },
  {
    label: 'contrast',
    adjust: { contrast: 0.5 },
    input: PATCH_CHART.highlight,
    assertDirection: (output, input) => expect(output[0]).toBeGreaterThan(input[0]),
  },
  {
    label: 'highlights',
    adjust: { highlights: 1 },
    input: PATCH_CHART.highlight,
    assertDirection: (output, input) => expect(output[0]).toBeGreaterThan(input[0]),
  },
  {
    label: 'shadows',
    adjust: { shadows: 1 },
    input: PATCH_CHART.shadow,
    assertDirection: (output, input) => expect(output[0]).toBeGreaterThan(input[0]),
  },
  {
    label: 'whites',
    adjust: { whites: 1 },
    input: PATCH_CHART.highlight,
    assertDirection: (output, input) => expect(output[0]).toBeGreaterThan(input[0]),
  },
  {
    label: 'blacks',
    adjust: { blacks: -1 },
    input: PATCH_CHART.shadow,
    assertDirection: (output, input) => expect(output[0]).toBeLessThan(input[0]),
  },
  {
    label: 'saturation',
    adjust: { saturation: 2 },
    input: PATCH_CHART.red,
    assertDirection: (output, input) => expect(output[0]).toBeGreaterThan(input[0]),
  },
  {
    label: 'vibrance',
    adjust: { vibrance: 1 },
    input: PATCH_CHART.mutedRed,
    assertDirection: (output, input) => expect(output[0]).toBeGreaterThan(input[0]),
  },
  {
    label: 'hue',
    adjust: { hue: 120 },
    input: PATCH_CHART.red,
    assertDirection: (output) => expect(output[1]).toBeGreaterThan(output[0]!),
  },
];

const lookPatchCases: readonly {
  readonly label: string;
  readonly look: string;
  readonly assertDirection: (render: (patch: ColorPatch) => number[]) => void;
}[] = [
  {
    label: 'None',
    look: 'none',
    assertDirection: (render) => expect(render(PATCH_CHART.red)).toEqual([...PATCH_CHART.red]),
  },
  {
    label: 'Clean Contrast',
    look: 'clean-contrast',
    assertDirection: (render) => {
      expect(render(PATCH_CHART.shadow)[0]).toBeLessThan(PATCH_CHART.shadow[0]);
      expect(render(PATCH_CHART.highlight)[0]).toBeGreaterThan(PATCH_CHART.highlight[0]);
    },
  },
  {
    label: 'Soft Film',
    look: 'soft-film',
    assertDirection: (render) => {
      expect(render(PATCH_CHART.black)[0]).toBeGreaterThan(0);
      expect(render(PATCH_CHART.white)[0]).toBeLessThan(255);
    },
  },
  {
    label: 'Warm Cinema',
    look: 'warm-cinema',
    assertDirection: (render) => {
      const [red, green, blue] = render(PATCH_CHART.shadow);
      expect(red).toBeGreaterThan(green!);
      expect(green).toBeGreaterThan(blue!);
    },
  },
  {
    label: 'Cool Fade',
    look: 'cool-fade',
    assertDirection: (render) => {
      const [red, green, blue] = render(PATCH_CHART.shadow);
      expect(blue).toBeGreaterThan(red!);
      expect(red).toBeGreaterThan(green!);
    },
  },
  {
    label: 'Monochrome',
    look: 'monochrome',
    assertDirection: (render) => {
      const [red, green, blue] = render(PATCH_CHART.red);
      expect(red).toBe(green);
      expect(green).toBe(blue);
    },
  },
];

describe('v2 color grade tools', () => {
  it.each(adjustmentPatchCases)(
    'changes the $label patch in the expected direction',
    ({ adjust, input, assertDirection }) => {
      const output = gradePixel({ ...identity, adjust }, input);
      expect(output).not.toEqual(input);
      assertDirection(output, input);
    },
  );

  it('uses Pivot to move the contrast response around the selected grey', () => {
    const lowerPivot = gradePixel(
      { ...identity, adjust: { contrast: 0.5, pivot: 0.3 } },
      PATCH_CHART.midGrey,
    );
    const higherPivot = gradePixel(
      { ...identity, adjust: { contrast: 0.5, pivot: 0.7 } },
      PATCH_CHART.midGrey,
    );
    expect(higherPivot).not.toEqual(lowerPivot);
    expect(higherPivot[0]).toBeLessThan(lowerPivot[0]!);
  });

  it.each(lookPatchCases)('$label look behaves on the patch chart', ({ look, assertDirection }) => {
    const render = (patch: ColorPatch) =>
      gradePixel({ ...identity, lut: { builtIn: look, intensity: 1 } }, patch);
    assertDirection(render);
  });

  it('mixes a built-in look and a .cube LUT by their intensity', () => {
    const patch = PATCH_CHART.red;
    const unchanged = gradePixel(
      { ...identity, lut: { builtIn: 'clean-contrast', intensity: 0 } },
      patch,
    );
    const partial = gradePixel(
      { ...identity, lut: { builtIn: 'clean-contrast', intensity: 0.5 } },
      patch,
    );
    const full = gradePixel(
      { ...identity, lut: { builtIn: 'clean-contrast', intensity: 1 } },
      patch,
    );
    expect(unchanged).toEqual(patch);
    expect(partial[0]).toBeGreaterThan(unchanged[0]!);
    expect(partial[0]).toBeLessThan(full[0]!);

    const cubeLut = parseCubeLut(
      `LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1`,
    );
    const cubePatch = [64, 128, 192] as const;
    const halfCube = gradePixel(
      {
        ...identity,
        lut: { assetId: 'test-lut', sha256: 'a'.repeat(64), intensity: 0.5 },
      },
      cubePatch,
      cubeLut,
    );
    expect(halfCube).toEqual([128, 128, 128]);
  });

  it('keeps an identity grade byte-exact and recognized as free', () => {
    const input = Uint8Array.of(13, 82, 197, 255);
    const before = [...input];
    expect(isIdentityColorGrade(identity)).toBe(true);
    applyColorGradeToPixels(input, identity);
    expect([...input]).toEqual(before);
  });

  it('uses whites and blacks to move the expected tonal regions', () => {
    const grade: ColorGradeIR = {
      ...identity,
      adjust: { whites: 0.4, blacks: -0.4 },
    };
    expect(gradePixel(grade, [235, 235, 235])[0]).toBeGreaterThan(235);
    expect(gradePixel(grade, [5, 5, 5])[0]).toBeLessThan(5);
  });

  it('applies per-channel lift and master offset independently', () => {
    const grade: ColorGradeIR = {
      ...identity,
      wheels: {
        lift: { r: 0.2, g: 0, b: 0, master: 0 },
        gamma: { r: 0, g: 0, b: 0, master: 0 },
        gain: { r: 0, g: 0, b: 0, master: 0 },
        offset: { r: 0, g: 0, b: 0, master: 0.1 },
      },
    };
    const input = gradePixel(grade, [80, 80, 80]);
    expect(input[0]!).toBeGreaterThan(input[1]!);
    expect(input[1]!).toBeGreaterThan(80);
    expect(input[2]!).toBe(input[1]);
  });

  it('moves exposure, white balance, contrast, saturation, vibrance and soft clip as directed', () => {
    expect(gradePixel({ ...identity, adjust: { exposure: 1 } }, [64, 64, 64])[0]!).toBeGreaterThan(
      64,
    );
    const warm = gradePixel({ ...identity, adjust: { temperature: 1 } }, [128, 128, 128]);
    expect(warm[0]!).toBeGreaterThan(warm[2]!);
    expect(
      gradePixel({ ...identity, adjust: { contrast: 0.5 } }, [200, 200, 200])[0]!,
    ).toBeGreaterThan(200);
    expect(gradePixel({ ...identity, adjust: { contrast: 0.5 } }, [55, 55, 55])[0]!).toBeLessThan(
      55,
    );
    expect(
      gradePixel({ ...identity, adjust: { saturation: 1.5 } }, [180, 100, 100])[0]!,
    ).toBeGreaterThan(180);
    expect(
      gradePixel({ ...identity, adjust: { vibrance: 1 } }, [160, 120, 120])[0]!,
    ).toBeGreaterThan(160);
    expect(
      gradePixel(
        { ...identity, outputSafety: { softClip: 1, legalRange: false } },
        [240, 240, 240],
      )[0]!,
    ).toBeLessThan(240);
  });

  it('selects an HSL band by centre and softness before changing its chroma', () => {
    const grade: ColorGradeIR = {
      ...identity,
      hsl: [
        {
          hue: 0,
          hueShift: 0,
          hueWidth: 70,
          softness: 0.2,
          saturation: 1,
          luminance: 0,
        },
      ],
    };
    expect(gradePixel(grade, [180, 90, 90])[0]!).toBeGreaterThan(180);
    expect(gradePixel(grade, [90, 180, 90])).toEqual([90, 180, 90]);
  });

  it('ignores HSL bands beyond the shared eight-band limit', () => {
    const neutralBand = {
      hue: 0,
      hueWidth: 35,
      softness: 0.2,
      saturation: 0,
      luminance: 0,
    };
    const firstEight: ColorGradeIR = {
      ...identity,
      hsl: Array.from({ length: 8 }, () => neutralBand),
    };
    const withNinthBand: ColorGradeIR = {
      ...identity,
      hsl: [
        ...Array.from({ length: 8 }, () => neutralBand),
        { ...neutralBand, hueWidth: 360, hueShift: 120 },
      ],
    };
    expect(gradePixel(withNinthBand, [255, 0, 0])).toEqual(gradePixel(firstEight, [255, 0, 0]));
  });

  it('maps curve points with a monotone spline', () => {
    const grade: ColorGradeIR = {
      ...identity,
      curves: {
        rgb: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0.25 },
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
      },
    };
    expect(gradePixel(grade, [128, 128, 128])[0]).toBeLessThan(128);
    expect(gradePixel(grade, [128, 128, 128])[0]).toBe(gradePixel(grade, [128, 128, 128])[1]);
  });

  it('reuses curve tables for unchanged points in newly evaluated grades', () => {
    const curves: NonNullable<ColorGradeIR['curves']> = {
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
    };

    expect(getColorCurveLuts(structuredClone(curves))).toBe(getColorCurveLuts(curves));
  });

  it('applies hue adjustment while preserving neutral grey', () => {
    const grade: ColorGradeIR = { ...identity, adjust: { hue: 120 } };
    const shifted = gradePixel(grade, [220, 32, 32]);
    expect(shifted[1]!).toBeGreaterThan(shifted[0]!);
    expect(gradePixel(grade, [128, 128, 128])).toEqual([128, 128, 128]);
  });

  it('applies each supported built-in look with its intensity', () => {
    for (const builtIn of [
      'clean-contrast',
      'soft-film',
      'warm-cinema',
      'cool-fade',
      'monochrome',
    ]) {
      const grade: ColorGradeIR = { ...identity, lut: { builtIn, intensity: 1 } };
      expect(gradePixel(grade, [220, 65, 35])).not.toEqual([220, 65, 35]);
    }
    const neutral = gradePixel(
      { ...identity, lut: { builtIn: 'monochrome', intensity: 0 } },
      [220, 65, 35],
    );
    expect(neutral).toEqual([220, 65, 35]);
  });

  it('applies a parsed 3D cube LUT with its intensity', () => {
    const lut = parseCubeLut(
      `LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1`,
    );
    const grade: ColorGradeIR = {
      ...identity,
      lut: { assetId: 'test-lut', sha256: 'a'.repeat(64), intensity: 1 },
    };
    expect(gradePixel(grade, [64, 128, 192], lut)).toEqual([192, 128, 64]);
  });

  it('does not treat a diagonal curve without both endpoints as identity', () => {
    const grade: ColorGradeIR = {
      ...identity,
      curves: {
        rgb: [
          { x: 0.5, y: 0.5 },
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
      },
    };
    expect(isIdentityColorGrade(grade)).toBe(false);
  });
});
