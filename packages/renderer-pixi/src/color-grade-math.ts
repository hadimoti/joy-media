import type { ColorGradeIR } from '@joy-media/render-ir';
import type { ParsedCubeLut } from './lut.js';
import { sampleCubeLut } from './lut.js';

export type Rgb = readonly [number, number, number];
const curveLutCache = new WeakMap<
  object,
  Readonly<Record<'rgb' | 'red' | 'green' | 'blue', Uint8Array>>
>();

/** Applies the v2 grade in the documented, shared CPU/GPU operation order. */
export function applyColorGradeV2(
  r: number,
  g: number,
  b: number,
  grade: ColorGradeIR,
  cubeLut?: ParsedCubeLut,
): Rgb {
  const adjust = grade.adjust;
  const exposure = 2 ** (adjust?.exposure ?? 0);
  const temperature = adjust?.temperature ?? 0;
  const tint = adjust?.tint ?? 0;
  let rgb: [number, number, number] = [
    r * exposure + temperature * 0.06 + tint * 0.02,
    g * exposure - tint * 0.03,
    b * exposure - temperature * 0.06 - tint * 0.02,
  ];

  // Lift, gamma, gain and offset. Each wheel's RGB values act independently;
  // master is applied equally to all three channels.
  const wheels = grade.wheels;
  if (wheels !== undefined) {
    rgb = rgb.map((value, channel) => {
      const lift = wheels.lift;
      const gamma = wheels.gamma;
      const gain = wheels.gain;
      const offset = wheels.offset;
      const liftColor = [lift.r, lift.g, lift.b][channel]! + lift.master;
      const gammaColor = [gamma.r, gamma.g, gamma.b][channel]! + gamma.master;
      const gainColor = [gain.r, gain.g, gain.b][channel]! + gain.master;
      const offsetColor = [offset.r, offset.g, offset.b][channel]! + offset.master;
      const lifted = value + liftColor * (1 - value) ** 2;
      const gammaCorrected = Math.pow(Math.max(0, lifted), 1 / Math.max(0.05, 1 + gammaColor));
      return gammaCorrected * (1 + gainColor) + offsetColor;
    }) as [number, number, number];
  }

  // Contrast pivots around the selected tonal pivot.
  const pivot = adjust?.pivot ?? 0.5;
  const contrast = 1 + (adjust?.contrast ?? 0);
  rgb = rgb.map((value) => pivot + (value - pivot) * contrast) as [number, number, number];

  // Tonal range controls share luminance weights so neutral patches stay neutral.
  let luminance = luma(rgb);
  const shadowWeight = (1 - smoothstep(0.02, 0.45, luminance)) ** 2;
  const highlightWeight = smoothstep(0.55, 0.98, luminance) ** 2;
  const blackWeight = (1 - smoothstep(0.08, 0.55, luminance)) ** 2;
  const whiteWeight = smoothstep(0.45, 0.92, luminance) ** 2;
  const tonalDelta =
    (adjust?.shadows ?? 0) * shadowWeight * 0.25 +
    (adjust?.highlights ?? 0) * highlightWeight * 0.25 +
    (adjust?.blacks ?? 0) * blackWeight * 0.25 +
    (adjust?.whites ?? 0) * whiteWeight * 0.25;
  rgb = rgb.map((value) => value + tonalDelta) as [number, number, number];

  // Curves are evaluated from a 256-sample monotone cubic spline LUT.
  const curves = grade.curves;
  if (curves !== undefined) {
    let tables = curveLutCache.get(curves);
    if (tables === undefined) {
      tables = {
        rgb: buildColorCurveLut(curves.rgb),
        red: buildColorCurveLut(curves.red),
        green: buildColorCurveLut(curves.green),
        blue: buildColorCurveLut(curves.blue),
      };
      curveLutCache.set(curves, tables);
    }
    rgb = rgb.map((value, channel) => {
      const channelName = (['red', 'green', 'blue'] as const)[channel]!;
      const common = sampleCurveLut(tables!.rgb, value);
      return sampleCurveLut(tables![channelName], common);
    }) as [number, number, number];
  }

  // HSL selectors use circular hue distance and a smooth edge around each band.
  if (grade.hsl !== undefined && grade.hsl.length > 0) {
    let hsl = rgbToHsl(...rgb);
    for (const band of grade.hsl) {
      const distance = circularDistance(hsl[0], wrapHue(band.hue));
      const halfWidth = Math.max(0.001, Math.min(180, band.hueWidth) / 2);
      const softness = Math.max(0, Math.min(1, band.softness));
      const feather = Math.max(0.5, halfWidth * softness);
      const weight = 1 - smoothstep(halfWidth - feather, halfWidth + feather, distance);
      hsl = [
        wrapHue(hsl[0] + (band.hueShift ?? 0) * weight),
        Math.max(0, Math.min(1, hsl[1] * (1 + band.saturation * weight))),
        Math.max(0, Math.min(1, hsl[2] + band.luminance * weight)),
      ];
    }
    rgb = hslToRgb(...hsl);
  }

  // Global saturation, vibrance, then hue rotation.
  luminance = luma(rgb);
  const saturation = adjust?.saturation ?? grade.saturation;
  const chroma = Math.max(...rgb) - Math.min(...rgb);
  const vibrance = (adjust?.vibrance ?? 0) * (1 - chroma);
  rgb = rgb.map((value) => luminance + (value - luminance) * (saturation + vibrance)) as [
    number,
    number,
    number,
  ];
  if ((adjust?.hue ?? 0) !== 0) {
    const hsl = rgbToHsl(...rgb);
    rgb = hslToRgb(wrapHue(hsl[0] + (adjust?.hue ?? 0)), hsl[1], hsl[2]);
  }

  // Built-in looks are deterministic transforms with an independently adjustable mix.
  const lut = grade.lut;
  const intensity = Math.max(0, Math.min(1, lut?.intensity ?? 1));
  const look = applyBuiltInLook(rgb, lut?.builtIn ?? grade.lutId ?? 'none');
  rgb = rgb.map((value, channel) => value + (look[channel]! - value) * intensity) as [
    number,
    number,
    number,
  ];
  if (cubeLut !== undefined && lut?.assetId !== undefined) {
    const sampled = sampleCubeLut(cubeLut, ...rgb);
    rgb = rgb.map((value, channel) => value + (sampled[channel]! - value) * intensity) as [
      number,
      number,
      number,
    ];
  }

  // Soft clip and legal range are the final output operations.
  const softClip = Math.max(0, grade.outputSafety?.softClip ?? 0);
  rgb = rgb.map((value) =>
    softClip > 0 ? value / (1 + softClip * Math.max(0, value)) : value,
  ) as [number, number, number];
  if (grade.outputSafety?.legalRange === true)
    rgb = rgb.map((value) => Math.max(16 / 255, Math.min(235 / 255, value))) as [
      number,
      number,
      number,
    ];
  return rgb.map(clamp01) as [number, number, number];
}

/** Builds a 256-entry, channel-addressable LUT from monotone cubic splines. */
export function buildColorCurveLut(points: readonly { x: number; y: number }[]): Uint8Array {
  return Uint8Array.from({ length: 256 }, (_, index) =>
    Math.round(sampleColorCurve(points, index / 255) * 255),
  );
}

export function sampleColorCurve(
  points: readonly { x: number; y: number }[],
  input: number,
): number {
  if (points.length < 2) return clamp01(input);
  const sorted = points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: clamp01(point.x), y: clamp01(point.y) }))
    .sort((left, right) => left.x - right.x)
    .filter((point, index, values) => index === 0 || point.x > values[index - 1]!.x);
  if (sorted.length < 2) return clamp01(input);
  const x = clamp01(input);
  if (x <= sorted[0]!.x) return sorted[0]!.y;
  const lastIndex = sorted.length - 1;
  if (x >= sorted[lastIndex]!.x) return sorted[lastIndex]!.y;
  const slopes = sorted.slice(0, -1).map((point, index) => {
    const next = sorted[index + 1]!;
    return (next.y - point.y) / (next.x - point.x);
  });
  const tangents = sorted.map((_, index) => {
    if (index === 0) return slopes[0]!;
    if (index === lastIndex) return slopes[lastIndex - 1]!;
    const before = slopes[index - 1]!;
    const after = slopes[index]!;
    if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) return 0;
    const h0 = sorted[index]!.x - sorted[index - 1]!.x;
    const h1 = sorted[index + 1]!.x - sorted[index]!.x;
    const w1 = 2 * h1 + h0;
    const w2 = h1 + 2 * h0;
    return (w1 + w2) / (w1 / before + w2 / after);
  });
  for (let index = 0; index < lastIndex; index += 1) {
    const left = sorted[index]!;
    const right = sorted[index + 1]!;
    if (x > right.x) continue;
    const width = right.x - left.x;
    const t = (x - left.x) / width;
    const t2 = t * t;
    const t3 = t2 * t;
    return clamp01(
      (2 * t3 - 3 * t2 + 1) * left.y +
        (t3 - 2 * t2 + t) * width * tangents[index]! +
        (-2 * t3 + 3 * t2) * right.y +
        (t3 - t2) * width * tangents[index + 1]!,
    );
  }
  return sorted[lastIndex]!.y;
}

function applyBuiltInLook(rgb: Rgb, look: string): Rgb {
  const [r, g, b] = rgb;
  const lum = luma(rgb);
  switch (look) {
    case 'clean-contrast':
    case 'contrast':
      return rgb.map((value) => 0.5 + (value - 0.5) * 1.22) as [number, number, number];
    case 'rec709':
      return rgb.map((value) => 0.5 + (value - 0.5) * 1.1) as [number, number, number];
    case 'soft-film':
      return [
        0.035 + 0.91 * Math.pow(clamp01(r), 0.92),
        0.03 + 0.91 * Math.pow(clamp01(g), 0.96),
        0.025 + 0.91 * Math.pow(clamp01(b), 1.04),
      ];
    case 'warm-cinema':
      return [r + 0.055 * (1 - lum), g + 0.012 * (1 - lum), b - 0.045 * lum];
    case 'cool-fade':
      return [r + 0.025 * (1 - lum), g + 0.02 * (1 - lum), b + 0.055 * (1 - lum)];
    case 'monochrome':
      return [lum, lum, lum];
    default:
      return rgb;
  }
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) return [0, 0, lightness];
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue =
    max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue *= 60;
  return [wrapHue(hue), saturation, lightness];
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = wrapHue(hue) / 60;
  const second = chroma * (1 - Math.abs((segment % 2) - 1));
  const offset = lightness - chroma / 2;
  const values =
    segment < 1
      ? [chroma, second, 0]
      : segment < 2
        ? [second, chroma, 0]
        : segment < 3
          ? [0, chroma, second]
          : segment < 4
            ? [0, second, chroma]
            : segment < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  return [values[0]! + offset, values[1]! + offset, values[2]! + offset];
}

function luma(rgb: Rgb): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function sampleCurveLut(table: Uint8Array, value: number): number {
  const position = clamp01(value) * 255;
  const lower = Math.floor(position);
  const upper = Math.min(255, lower + 1);
  const amount = position - lower;
  return (table[lower]! + (table[upper]! - table[lower]!) * amount) / 255;
}
function circularDistance(a: number, b: number): number {
  const distance = Math.abs(a - b) % 360;
  return Math.min(distance, 360 - distance);
}
function wrapHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}
function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const x = clamp01((value - edge0) / (edge1 - edge0));
  return x * x * (3 - 2 * x);
}
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
