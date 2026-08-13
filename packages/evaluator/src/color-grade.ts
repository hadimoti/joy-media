/**
 * Universal Color-grade evaluation. This is deliberately pure: the same
 * resolved V2 grade can be consumed by the Program monitor and browser export
 * without either path mutating project state.
 */
import { sampleAnimationValue } from '@joy-media/motion-core';
import {
  canonicalBindingKey,
  colorPropertyBinding,
  HSL_BAND_IDS,
  IDENTITY_COLOR_ADJUSTMENTS,
  IDENTITY_COLOR_WHEELS,
  IDENTITY_HSL_BANDS,
  type ColorGradeV2,
  type ColorPropertyScopeV2,
  type HslBand,
  type NormalizedPropertyAnimationsV2,
  type ColorWheels,
} from '@joy-media/project-schema';
import type { PropertyAnimationTimeContext } from './property-time-domain.js';
import { resolvePropertyAnimationTime } from './property-time-domain.js';

export interface ColorGradeEvaluationTarget {
  readonly scope: ColorPropertyScopeV2;
  /** Required only for the Clip target. */
  readonly clipId?: string;
}

/**
 * Samples the continuous WP34 Color controls at an explicit time domain.
 * Curves and LUT reference changes remain static until their dedicated
 * snapshot/hold packets; this function handles Adjust, Wheels, HSL, and LUT
 * intensity only.
 */
export function evaluateColorGradeAtTime(
  grade: ColorGradeV2,
  animations: NormalizedPropertyAnimationsV2 | undefined,
  target: ColorGradeEvaluationTarget,
  time: PropertyAnimationTimeContext,
): ColorGradeV2 {
  const binding = (propertyId: string) =>
    colorPropertyBinding(target.scope, propertyId, target.clipId);
  const sampleNumber = (propertyId: string, fallback: number): number => {
    const animation = animations?.[canonicalBindingKey(binding(propertyId))];
    if (animation === undefined) return fallback;
    const resolved = resolvePropertyAnimationTime(animation.binding.timeDomain, time);
    const value = sampleAnimationValue(animation.value, resolved.timeUs);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  const sampleColor = (
    propertyId: string,
    fallback: Readonly<Record<'r' | 'g' | 'b', number>>,
  ): Readonly<Record<'r' | 'g' | 'b', number>> => {
    const animation = animations?.[canonicalBindingKey(binding(propertyId))];
    if (animation === undefined) return fallback;
    const resolved = resolvePropertyAnimationTime(animation.binding.timeDomain, time);
    const value = sampleAnimationValue(animation.value, resolved.timeUs);
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !['r', 'g', 'b'].every((channel) => Number.isFinite(value[channel]))
    )
      return fallback;
    return { r: value.r as number, g: value.g as number, b: value.b as number };
  };

  const staticAdjust = { ...IDENTITY_COLOR_ADJUSTMENTS, ...(grade.adjust ?? {}) };
  const adjust = {
    ...staticAdjust,
    ...Object.fromEntries(
      Object.entries(staticAdjust).map(([key, value]) => [
        key,
        sampleNumber(`adjust.${key}`, value),
      ]),
    ),
  };
  const staticWheels = { ...IDENTITY_COLOR_WHEELS, ...(grade.wheels ?? {}) };
  const wheel = (name: keyof ColorWheels) => {
    const staticWheel = staticWheels[name];
    const color = sampleColor(`wheels.${name}.color`, staticWheel);
    return {
      ...staticWheel,
      ...color,
      master: sampleNumber(`wheels.${name}.master`, staticWheel.master),
    };
  };
  const wheels: ColorWheels = {
    lift: wheel('lift'),
    gamma: wheel('gamma'),
    gain: wheel('gain'),
    offset: wheel('offset'),
  };

  const staticBands = grade.hsl ?? IDENTITY_HSL_BANDS;
  const hsl = staticBands.map((band, index) => {
    const id = band.id ?? HSL_BAND_IDS[index]!;
    const property = (
      key: keyof Pick<HslBand, 'hue' | 'hueWidth' | 'softness' | 'saturation' | 'luminance'>,
    ) => sampleNumber(`hsl.${id}.${key}`, band[key]);
    return {
      id,
      hue: property('hue'),
      hueWidth: property('hueWidth'),
      softness: property('softness'),
      saturation: property('saturation'),
      luminance: property('luminance'),
    };
  });
  const lut =
    grade.lut === undefined
      ? undefined
      : { ...grade.lut, intensity: sampleNumber('lut.intensity', grade.lut.intensity) };

  return {
    ...grade,
    adjust,
    wheels,
    hsl,
    ...(lut === undefined ? {} : { lut }),
  };
}
