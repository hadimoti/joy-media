import type { ColorGradeV1 } from './v1.js';
import type { PropertyBindingV2 } from './property-animation.js';

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
/** Fixed sample count for durable animated Color curve snapshots. */
export const COLOR_CURVE_SNAPSHOT_SAMPLES = 256;

export const HSL_BAND_IDS = [
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'magenta',
] as const;

/** Stable semantic owner ids for the eight HSL bands. */
export type HslBandId = (typeof HSL_BAND_IDS)[number];

export interface HslBand {
  /**
   * Optional for legacy V2 projects. New grades always carry a semantic id so
   * a band can be addressed without relying on its array index.
   */
  readonly id?: HslBandId;
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

export type ColorPropertyScopeV2 = 'output' | 'clip';
export type ColorPropertyValueKindV2 = 'scalar' | 'hue' | 'color' | 'curve-snapshot' | 'string';

/**
 * Classification for every creative WP-33 control. Monitor diagnostics and
 * layout preferences are intentionally absent: they are local UI state, not
 * project animation targets.
 */
export interface ColorPropertyDescriptorV2 {
  readonly id: string;
  readonly label: string;
  readonly valueKind: ColorPropertyValueKindV2;
  readonly scopes: readonly ColorPropertyScopeV2[];
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

/**
 * Converts a sparse, ordered curve into the fixed 256-value representation
 * used by universal curve-snapshot animation. Values are bounded to the SDR
 * curve domain and interpolation is deterministic between knots.
 */
export function colorCurveToSnapshot(points: readonly ColorCurvePoint[]): readonly number[] {
  const normalized = normalizeColorCurvePoints(points);
  return Array.from({ length: COLOR_CURVE_SNAPSHOT_SAMPLES }, (_, index) =>
    sampleColorCurve(normalized, index / (COLOR_CURVE_SNAPSHOT_SAMPLES - 1)),
  );
}

/** Converts a bounded snapshot back into a uniform curve for the renderer/UI. */
export function colorCurveFromSnapshot(snapshot: readonly number[]): readonly ColorCurvePoint[] {
  if (snapshot.length !== COLOR_CURVE_SNAPSHOT_SAMPLES)
    throw new RangeError(
      `color curve snapshots must contain ${COLOR_CURVE_SNAPSHOT_SAMPLES} samples`,
    );
  if (!snapshot.every(Number.isFinite))
    throw new RangeError('color curve snapshots must be finite');
  return snapshot.map((y, index) => ({
    x: index / (COLOR_CURVE_SNAPSHOT_SAMPLES - 1),
    y: clampUnit(y),
  }));
}

/** Keeps curve knots ordered and bounded before snapshotting or rendering. */
export function normalizeColorCurvePoints(
  points: readonly ColorCurvePoint[],
): readonly ColorCurvePoint[] {
  if (points.length < 2) return IDENTITY_COLOR_CURVES.rgb;
  const sorted = [...points]
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: clampUnit(point.x), y: clampUnit(point.y) }))
    .sort((left, right) => left.x - right.x);
  const distinct = sorted.filter((point, index) => index === 0 || point.x > sorted[index - 1]!.x);
  if (distinct.length < 2) return IDENTITY_COLOR_CURVES.rgb;
  return distinct;
}

function sampleColorCurve(points: readonly ColorCurvePoint[], x: number): number {
  if (x <= points[0]!.x) return points[0]!.y;
  const last = points[points.length - 1]!;
  if (x >= last.x) return last.y;
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index]!;
    const right = points[index + 1]!;
    if (x > right.x) continue;
    const fraction = (x - left.x) / (right.x - left.x);
    return left.y + (right.y - left.y) * fraction;
  }
  return last.y;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export const IDENTITY_HSL_BANDS: readonly HslBand[] = Object.freeze(
  HSL_BAND_IDS.map((id, index) =>
    Object.freeze({
      id,
      hue: index * 45,
      hueWidth: 35,
      softness: 0.2,
      saturation: 0,
      luminance: 0,
    }),
  ),
);

const COLOR_SCOPES: readonly ColorPropertyScopeV2[] = Object.freeze(['output', 'clip']);
const ADJUSTMENT_DEFINITIONS = [
  ['temperature', 'Temperature', 'scalar'],
  ['tint', 'Tint', 'scalar'],
  ['exposure', 'Exposure', 'scalar'],
  ['contrast', 'Contrast', 'scalar'],
  ['pivot', 'Pivot', 'scalar'],
  ['highlights', 'Highlights', 'scalar'],
  ['shadows', 'Shadows', 'scalar'],
  ['whites', 'Whites', 'scalar'],
  ['blacks', 'Blacks', 'scalar'],
  ['saturation', 'Saturation', 'scalar'],
  ['vibrance', 'Vibrance', 'scalar'],
  ['hue', 'Hue', 'hue'],
] as const;
const ADJUST_DESCRIPTORS: readonly ColorPropertyDescriptorV2[] = ADJUSTMENT_DEFINITIONS.map(
  ([id, label, valueKind]) => ({
    id: `adjust.${id}`,
    label,
    valueKind,
    scopes: COLOR_SCOPES,
  }),
);

const WHEEL_DESCRIPTORS: readonly ColorPropertyDescriptorV2[] = (
  ['lift', 'gamma', 'gain', 'offset'] as const
).flatMap((wheel) => [
  {
    id: `wheels.${wheel}.color`,
    label: `${wheel[0]!.toUpperCase()}${wheel.slice(1)} color`,
    valueKind: 'color' as const,
    scopes: COLOR_SCOPES,
  },
  {
    id: `wheels.${wheel}.master`,
    label: `${wheel[0]!.toUpperCase()}${wheel.slice(1)} master`,
    valueKind: 'scalar' as const,
    scopes: COLOR_SCOPES,
  },
]);

const HSL_PROPERTY_DEFINITIONS = [
  ['hue', 'Hue', 'hue'],
  ['hueWidth', 'Range', 'hue'],
  ['softness', 'Softness', 'scalar'],
  ['saturation', 'Saturation', 'scalar'],
  ['luminance', 'Luminance', 'scalar'],
] as const;
const HSL_DESCRIPTORS: readonly ColorPropertyDescriptorV2[] = HSL_BAND_IDS.flatMap((band) =>
  HSL_PROPERTY_DEFINITIONS.map(([property, label, valueKind]) => ({
    id: `hsl.${band}.${property}`,
    label: `${band[0]!.toUpperCase()}${band.slice(1)} ${label}`,
    valueKind,
    scopes: COLOR_SCOPES,
  })),
);

export const COLOR_PROPERTY_DESCRIPTORS: readonly ColorPropertyDescriptorV2[] = Object.freeze([
  ...ADJUST_DESCRIPTORS,
  ...WHEEL_DESCRIPTORS,
  ...(['rgb', 'red', 'green', 'blue'] as const).map((channel) => ({
    id: `curves.${channel}`,
    label: `${channel.toUpperCase()} curve`,
    valueKind: 'curve-snapshot' as const,
    scopes: COLOR_SCOPES,
  })),
  ...HSL_DESCRIPTORS,
  { id: 'lut.reference', label: 'Look or LUT', valueKind: 'string', scopes: COLOR_SCOPES },
  { id: 'lut.intensity', label: 'LUT intensity', valueKind: 'scalar', scopes: COLOR_SCOPES },
]);

export function findColorPropertyDescriptor(id: string): ColorPropertyDescriptorV2 | undefined {
  return COLOR_PROPERTY_DESCRIPTORS.find((descriptor) => descriptor.id === id);
}

/** Builds the stable universal animation binding for a Color control. */
export function colorPropertyBinding(
  scope: ColorPropertyScopeV2,
  propertyId: string,
  clipId?: string,
): PropertyBindingV2 {
  if (findColorPropertyDescriptor(propertyId) === undefined)
    throw new RangeError(`unknown color property "${propertyId}"`);
  if (scope === 'clip' && (clipId === undefined || clipId.trim().length === 0))
    throw new RangeError('clip color bindings require a clip id');
  return {
    ownerKind: scope === 'output' ? 'color-output' : 'color-clip',
    ownerId: scope === 'output' ? 'output' : clipId!,
    propertyId,
    timeDomain: scope === 'output' ? 'output' : 'clip-local',
  };
}

/** Fails fast if a caller supplies a duplicate or incomplete descriptor list. */
export function assertColorPropertyDescriptorCoverage(
  descriptors: readonly ColorPropertyDescriptorV2[] = COLOR_PROPERTY_DESCRIPTORS,
): void {
  const ids = new Set<string>();
  for (const descriptor of descriptors) {
    if (ids.has(descriptor.id)) throw new RangeError(`duplicate color property "${descriptor.id}"`);
    ids.add(descriptor.id);
    if (descriptor.scopes.length === 0)
      throw new RangeError(`color property "${descriptor.id}" has no target scope`);
  }
  for (const descriptor of COLOR_PROPERTY_DESCRIPTORS)
    if (!ids.has(descriptor.id)) throw new RangeError(`missing color property "${descriptor.id}"`);
}

export function createIdentityColorGrade(): ColorGradeV2 {
  return {
    version: 2,
    enabled: true,
    adjust: IDENTITY_COLOR_ADJUSTMENTS,
    wheels: IDENTITY_COLOR_WHEELS,
    curves: IDENTITY_COLOR_CURVES,
    hsl: IDENTITY_HSL_BANDS,
    lut: { builtIn: 'none', intensity: 1 },
    outputSafety: { softClip: 0, legalRange: false },
  };
}

export function isColorGradeV2(value: unknown): value is ColorGradeV2 {
  return (
    typeof value === 'object' && value !== null && (value as { version?: unknown }).version === 2
  );
}
