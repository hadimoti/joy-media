import type { HslBand, HslBandId } from '@joy-media/project-schema';
import { HSL_BAND_IDS, IDENTITY_HSL_BANDS } from '@joy-media/project-schema';
import {
  circularHueDistance,
  colorGradeRgbToHsl,
  MAX_COLOR_GRADE_HSL_BANDS,
  normalizeColorGradeHslBands,
} from '@joy-media/renderer-pixi';

/**
 * The maths of the HSL bands and the eyedropper (T-K04).
 *
 * The hue of a picked pixel and the band it belongs to come from the colour
 * engine's own functions (`packages/renderer-pixi`): the same RGB to HSL
 * conversion, the same band centre normalisation and the same distance
 * around the colour circle, so the band the eyedropper opens is the band
 * that changes that colour in the preview and the export.
 */

export type HslBandKey = 'hue' | 'hueShift' | 'hueWidth' | 'softness' | 'saturation' | 'luminance';

export interface HslControl {
  readonly key: HslBandKey;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** How the keyframe stores the value: hues wrap around, scalars do not. */
  readonly valueKind: 'hue' | 'scalar';
  /** Shown first, open; the others sit under "Band shape". */
  readonly primary: boolean;
}

/** The controls of one band, in the order they are shown. */
export const HSL_CONTROLS: readonly HslControl[] = [
  {
    key: 'hueShift',
    label: 'Hue shift',
    min: -180,
    max: 180,
    step: 1,
    valueKind: 'hue',
    primary: true,
  },
  {
    key: 'saturation',
    label: 'Saturation',
    min: -1,
    max: 1,
    step: 0.01,
    valueKind: 'scalar',
    primary: true,
  },
  {
    key: 'luminance',
    label: 'Luminance',
    min: -1,
    max: 1,
    step: 0.01,
    valueKind: 'scalar',
    primary: true,
  },
  { key: 'hueWidth', label: 'Width', min: 1, max: 180, step: 1, valueKind: 'hue', primary: true },
  { key: 'hue', label: 'Hue', min: 0, max: 359, step: 1, valueKind: 'hue', primary: false },
  {
    key: 'softness',
    label: 'Softness',
    min: 0,
    max: 1,
    step: 0.01,
    valueKind: 'scalar',
    primary: false,
  },
];

/** Below this saturation a pixel is grey: it has no hue worth picking. */
export const MIN_PICK_SATURATION = 0.06;

/** "Red", "Orange", … */
export function hslBandLabel(id: HslBandId): string {
  return `${id[0]!.toUpperCase()}${id.slice(1)}`;
}

/** Wraps a hue into 0 up to (not including) 360. */
export function wrapHue(hue: number): number {
  if (!Number.isFinite(hue)) return 0;
  return ((hue % 360) + 360) % 360;
}

/**
 * The eight bands of a grade with their ids. A legacy grade without ids gets
 * them from its position; a missing band is the identity band.
 */
export function gradeHslBands(bands: readonly HslBand[] | undefined): readonly HslBand[] {
  return HSL_BAND_IDS.map((id, index) => {
    const band = bands?.[index];
    return band === undefined ? IDENTITY_HSL_BANDS[index]! : { ...band, id: band.id ?? id };
  });
}

/** The band as the grade starts it (identity), for the band's reset. */
export function identityHslBand(id: HslBandId): HslBand {
  return IDENTITY_HSL_BANDS.find((band) => band.id === id)!;
}

/** The value a control shows: hue shift, saturation and so on; 0 for a missing hue shift. */
export function hslBandValue(band: HslBand, key: HslBandKey): number {
  return key === 'hueShift' ? (band.hueShift ?? 0) : band[key];
}

/** A control's value, kept inside its range (hues wrap). */
export function clampHslValue(key: HslBandKey, value: number): number {
  const control = HSL_CONTROLS.find((entry) => entry.key === key)!;
  if (!Number.isFinite(value)) return hslBandValue(IDENTITY_HSL_BANDS[0]!, key);
  if (key === 'hue') return wrapHue(Math.round(value));
  return Math.max(control.min, Math.min(control.max, value));
}

/** The bands with one value of one band changed. */
export function withHslValue(
  bands: readonly HslBand[],
  index: number,
  key: HslBandKey,
  value: number,
): readonly HslBand[] {
  return bands.map((band, i) =>
    i === index ? { ...band, [key]: clampHslValue(key, value) } : band,
  );
}

/** The bands with one band put back to its identity values. */
export function withHslBandReset(bands: readonly HslBand[], index: number): readonly HslBand[] {
  return bands.map((band, i) => {
    if (i !== index) return band;
    const id = band.id ?? HSL_BAND_IDS[index]!;
    return identityHslBand(id);
  });
}

/** True when the band changes nothing and sits where it started. */
export function isIdentityHslBand(band: HslBand, index: number): boolean {
  const identity = IDENTITY_HSL_BANDS[index];
  if (identity === undefined) return false;
  return HSL_CONTROLS.every(
    (control) => hslBandValue(band, control.key) === hslBandValue(identity, control.key),
  );
}

export interface PickedColour {
  /** 0..255 per channel. */
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface PixelHue {
  /** Degrees, 0 up to 360. */
  readonly hue: number;
  /** 0..1. */
  readonly saturation: number;
  /** 0..1. */
  readonly lightness: number;
}

/** The hue of a picked pixel, with the colour engine's conversion. */
export function pixelHue(colour: PickedColour): PixelHue {
  const [hue, saturation, lightness] = colorGradeRgbToHsl(
    colour.r / 255,
    colour.g / 255,
    colour.b / 255,
  );
  return { hue, saturation, lightness };
}

/** True when the pixel has a hue (it is not a grey, a black or a white). */
export function hasPickableHue(colour: PickedColour): boolean {
  const { saturation, lightness } = pixelHue(colour);
  return saturation >= MIN_PICK_SATURATION && lightness > 0.02 && lightness < 0.98;
}

/**
 * The band whose centre is nearest to the hue, around the colour circle (so
 * 350° is next to red at 0°). On a tie the first band wins.
 */
export function nearestHslBand(bands: readonly HslBand[], hue: number): number {
  const centres = normalizeColorGradeHslBands(bands);
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  centres.forEach((band, index) => {
    const distance = circularHueDistance(band.hue, hue);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * A ninth "custom" band would need room in the stored model. The colour
 * engine draws at most eight bands and the grade has one slot per named
 * band, so there is no room: the eyedropper moves the nearest band instead.
 */
export function canAddCustomBand(bands: readonly HslBand[]): boolean {
  return bands.length < MAX_COLOR_GRADE_HSL_BANDS && bands.length < HSL_BAND_IDS.length;
}

/** The bands with one band's centre moved to the hue (whole degrees). */
export function withBandCentre(
  bands: readonly HslBand[],
  index: number,
  hue: number,
): readonly HslBand[] {
  return withHslValue(bands, index, 'hue', hue);
}

export interface EyedropperResult {
  readonly bands: readonly HslBand[];
  readonly index: number;
  readonly hue: number;
}

/**
 * What a pick does: the nearest band, moved so its centre sits on the picked
 * hue. `undefined` for a grey pixel, which has no hue to pick.
 */
export function pickHslBand(
  bands: readonly HslBand[],
  colour: PickedColour,
): EyedropperResult | undefined {
  if (!hasPickableHue(colour)) return undefined;
  const { hue } = pixelHue(colour);
  const index = nearestHslBand(bands, hue);
  const centred = Math.round(hue) % 360;
  return { bands: withBandCentre(bands, index, centred), index, hue: centred };
}

/** The band's centre colour, for its chip. */
export function hslBandChipColour(hue: number): string {
  return `hsl(${Math.round(wrapHue(hue))} 85% 55%)`;
}

/** A value the way the band row shows it. */
export function formatHslValue(control: HslControl, value: number): string {
  if (control.key === 'hueShift') return `${value > 0 ? '+' : ''}${Math.round(value)}°`;
  if (control.valueKind === 'hue') return `${Math.round(value)}°`;
  if (control.key === 'softness') return value.toFixed(2);
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}
