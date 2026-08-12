import type { ColorGradeV1 } from './v1.js';

/**
 * Versioned SDR color model shared by the editor, Render IR, and export.
 * Values are display-referred Rec.709/sRGB controls. Optional sections keep
 * legacy projects compact and allow older agents to keep writing ColorGradeV1.
 */
export interface ColorAdjustments {
  readonly temperature: number;
  readonly tint: number;
  readonly exposure: number;
  readonly contrast: number;
  readonly pivot: number;
  readonly highlights: number;
  readonly shadows: number;
  readonly whites: number;
  readonly blacks: number;
  readonly saturation: number;
  readonly vibrance: number;
  readonly hue: number;
}

export interface ColorWheel {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly master: number;
}

export interface ColorWheels {
  readonly lift: ColorWheel;
  readonly gamma: ColorWheel;
  readonly gain: ColorWheel;
  readonly offset: ColorWheel;
}

export type ColorCurveChannel = 'rgb' | 'red' | 'green' | 'blue';

export interface ColorCurvePoint {
  readonly x: number;
  readonly y: number;
}

export type ColorCurves = Readonly<Record<ColorCurveChannel, readonly ColorCurvePoint[]>>;

export interface HslBand {
  readonly hue: number;
  readonly hueWidth: number;
  readonly softness: number;
  readonly saturation: number;
  readonly luminance: number;
}

export interface ColorLutReference {
  readonly assetId?: string;
  readonly sha256?: string;
  readonly builtIn?:
    'none' | 'clean-contrast' | 'soft-film' | 'warm-cinema' | 'cool-fade' | 'monochrome';
  readonly intensity: number;
}

export interface OutputSafety {
  readonly softClip: number;
  readonly legalRange: boolean;
}

export interface ColorGradeV2 {
  readonly version: 2;
  readonly enabled: boolean;
  readonly lift?: number;
  readonly gamma?: number;
  readonly gain?: number;
  readonly saturation?: number;
  readonly lutId?: 'none' | 'rec709' | 'contrast';
  readonly adjust?: ColorAdjustments;
  readonly wheels?: ColorWheels;
  readonly curves?: ColorCurves;
  readonly hsl?: readonly HslBand[];
  readonly lut?: ColorLutReference;
  readonly outputSafety?: OutputSafety;
}

export type ColorGrade = ColorGradeV1 | ColorGradeV2;

export const IDENTITY_COLOR_ADJUSTMENTS: ColorAdjustments = Object.freeze({
  temperature: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  pivot: 0.5,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  saturation: 1,
  vibrance: 0,
  hue: 0,
});

export const IDENTITY_COLOR_WHEEL: ColorWheel = Object.freeze({ r: 0, g: 0, b: 0, master: 0 });
export const IDENTITY_COLOR_WHEELS: ColorWheels = Object.freeze({
  lift: IDENTITY_COLOR_WHEEL,
  gamma: IDENTITY_COLOR_WHEEL,
  gain: IDENTITY_COLOR_WHEEL,
  offset: IDENTITY_COLOR_WHEEL,
});

export const IDENTITY_COLOR_CURVES: ColorCurves = Object.freeze({
  rgb: Object.freeze([
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ]),
  red: Object.freeze([
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ]),
  green: Object.freeze([
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ]),
  blue: Object.freeze([
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ]),
});

export function createIdentityColorGrade(): ColorGradeV2 {
  return {
    version: 2,
    enabled: true,
    adjust: IDENTITY_COLOR_ADJUSTMENTS,
    wheels: IDENTITY_COLOR_WHEELS,
    curves: IDENTITY_COLOR_CURVES,
    lut: { builtIn: 'none', intensity: 1 },
    outputSafety: { softClip: 0, legalRange: false },
  };
}

export function isColorGradeV2(value: unknown): value is ColorGradeV2 {
  return (
    typeof value === 'object' && value !== null && (value as { version?: unknown }).version === 2
  );
}
