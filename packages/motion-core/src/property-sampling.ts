/**
 * Pure samplers for WP34's compound and discrete animation values. These are
 * deliberately independent from project mutation, renderers, and wall clock.
 * All public entry points validate the small runtime boundary first so malformed
 * persisted values fail deterministically instead of producing NaN pixels.
 */

import type {
  AnimationCurveV1,
  AnimationValueV2,
  CurveSnapshotKeyV2,
  DiscreteKeyV2,
  TimeUs,
} from '@joy-media/project-schema';
import { sampleCurve } from './curve.js';
import { segmentEaseFraction } from './interpolation.js';

export type SampledAnimationValueV2 =
  | number
  | boolean
  | string
  | Readonly<Record<string, number>>
  | Readonly<Record<string, readonly number[]>>;

/** Samples any WP34 value at a document-local time without mutating its source. */
export function sampleAnimationValue(
  value: AnimationValueV2,
  timeUs: TimeUs,
): SampledAnimationValueV2 {
  assertFiniteTime(timeUs, 'sample time');
  switch (value.kind) {
    case 'scalar':
      return sampleValidatedCurve(value.curve, timeUs);
    case 'angle':
    case 'hue':
      return sampleWrappedCurve(value.curve, timeUs);
    case 'vector':
    case 'color':
      return sampleChannels(value.curve, timeUs);
    case 'boolean':
    case 'string':
      return sampleDiscreteKeys(value.keys, timeUs);
    case 'curve-snapshot':
      return sampleCurveSnapshots(value.samples, timeUs);
  }
}

/** Samples a vector or linear-RGB color record atomically, channel by channel. */
export function sampleChannels(
  channels: Readonly<Record<string, AnimationCurveV1>>,
  timeUs: TimeUs,
): Readonly<Record<string, number>> {
  assertFiniteTime(timeUs, 'sample time');
  const entries = Object.entries(channels);
  if (entries.length === 0)
    throw new RangeError('compound animation must contain at least one channel');
  const sampled: Record<string, number> = {};
  for (const [name, curve] of entries) {
    if (name.trim().length === 0)
      throw new RangeError('compound animation channel name is required');
    sampled[name] = sampleValidatedCurve(curve, timeUs);
  }
  return sampled;
}

/**
 * Samples a circular degree curve on the shortest arc and normalizes to
 * [0, 360). This is shared by hue and angle so 350° -> 10° crosses 0°, not 180°.
 */
export function sampleWrappedCurve(curve: AnimationCurveV1, timeUs: TimeUs): number {
  assertFiniteTime(timeUs, 'sample time');
  assertCurve(curve);
  const first = curve.keyframes[0]!;
  const last = curve.keyframes[curve.keyframes.length - 1]!;
  if (timeUs <= first.timeUs) return wrapDegrees(first.value);
  if (timeUs >= last.timeUs) return wrapDegrees(last.value);

  for (let index = 0; index < curve.keyframes.length - 1; index += 1) {
    const left = curve.keyframes[index]!;
    const right = curve.keyframes[index + 1]!;
    if (timeUs >= right.timeUs) continue;
    if (left.interpolation === 'hold') return wrapDegrees(left.value);
    const fraction = segmentEaseFraction(
      left.interpolation,
      left.bezier,
      (timeUs - left.timeUs) / (right.timeUs - left.timeUs),
    );
    const delta = wrapSignedDegrees(right.value - left.value);
    return wrapDegrees(left.value + delta * fraction);
  }
  return wrapDegrees(last.value);
}

/** Samples a boolean or string hold channel; values hold between keys. */
export function sampleDiscreteKeys(
  keys: readonly DiscreteKeyV2[],
  timeUs: TimeUs,
): boolean | string {
  assertFiniteTime(timeUs, 'sample time');
  assertDiscreteKeys(keys);
  const first = keys[0]!;
  if (timeUs <= first.timeUs) return first.value;
  let current = first;
  for (let index = 1; index < keys.length; index += 1) {
    const next = keys[index]!;
    if (timeUs < next.timeUs) return current.value;
    current = next;
  }
  return current.value;
}

/**
 * Samples immutable curve-snapshot tables. The left snapshot's `interpolation`
 * controls the segment: `hold` preserves its table; every other accepted
 * interpolation label is linearly blended. Tables must have identical channels
 * and lengths inside an interpolated segment.
 */
export function sampleCurveSnapshots(
  samples: readonly CurveSnapshotKeyV2[],
  timeUs: TimeUs,
): Readonly<Record<string, readonly number[]>> {
  assertFiniteTime(timeUs, 'sample time');
  assertSnapshots(samples);
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  if (timeUs <= first.timeUs) return cloneChannels(first.channels);
  if (timeUs >= last.timeUs) return cloneChannels(last.channels);

  for (let index = 0; index < samples.length - 1; index += 1) {
    const left = samples[index]!;
    const right = samples[index + 1]!;
    if (timeUs >= right.timeUs) continue;
    if (left.interpolation === 'hold') return cloneChannels(left.channels);
    const fraction = (timeUs - left.timeUs) / (right.timeUs - left.timeUs);
    return interpolateSnapshotChannels(left.channels, right.channels, fraction);
  }
  return cloneChannels(last.channels);
}

function sampleValidatedCurve(curve: AnimationCurveV1, timeUs: TimeUs): number {
  assertCurve(curve);
  return sampleCurve(curve, timeUs);
}

function assertCurve(curve: AnimationCurveV1): void {
  if (!Array.isArray(curve.keyframes) || curve.keyframes.length === 0)
    throw new RangeError('animation curve must contain at least one keyframe');
  let previousTime = -Infinity;
  for (const keyframe of curve.keyframes) {
    assertFiniteTime(keyframe.timeUs, 'keyframe time');
    if (keyframe.timeUs <= previousTime)
      throw new RangeError('animation curve keyframe times must be strictly increasing');
    previousTime = keyframe.timeUs;
    if (!Number.isFinite(keyframe.value))
      throw new RangeError('animation curve values must be finite');
    if (!['hold', 'linear', 'eased', 'bezier'].includes(keyframe.interpolation))
      throw new RangeError('animation curve interpolation is invalid');
    if (keyframe.bezier !== undefined) {
      const { x1, y1, x2, y2 } = keyframe.bezier;
      if (![x1, y1, x2, y2].every(Number.isFinite))
        throw new RangeError('bezier handles must be finite');
      if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1)
        throw new RangeError('bezier handle x coordinates must be in [0, 1]');
    }
  }
}

function assertDiscreteKeys(keys: readonly DiscreteKeyV2[]): void {
  if (!Array.isArray(keys) || keys.length === 0)
    throw new RangeError('discrete animation must contain at least one key');
  let previousTime = -Infinity;
  for (const key of keys) {
    assertFiniteTime(key.timeUs, 'discrete key time');
    if (key.timeUs <= previousTime)
      throw new RangeError('discrete animation key times must be strictly increasing');
    previousTime = key.timeUs;
    if (typeof key.value !== 'boolean' && typeof key.value !== 'string')
      throw new RangeError('discrete animation values must be boolean or string');
  }
}

function assertSnapshots(samples: readonly CurveSnapshotKeyV2[]): void {
  if (!Array.isArray(samples) || samples.length === 0)
    throw new RangeError('curve snapshot animation must contain at least one sample');
  let previousTime = -Infinity;
  for (const sample of samples) {
    assertFiniteTime(sample.timeUs, 'curve snapshot time');
    if (sample.timeUs <= previousTime)
      throw new RangeError('curve snapshot times must be strictly increasing');
    previousTime = sample.timeUs;
    if (typeof sample.interpolation !== 'string' || sample.interpolation.trim().length === 0)
      throw new RangeError('curve snapshot interpolation is required');
    assertSnapshotChannels(sample.channels);
  }
}

function assertSnapshotChannels(channels: Readonly<Record<string, readonly number[]>>): void {
  const entries = Object.entries(channels);
  if (entries.length === 0)
    throw new RangeError('curve snapshot must contain at least one channel');
  for (const [name, values] of entries) {
    if (name.trim().length === 0 || !Array.isArray(values) || values.length === 0)
      throw new RangeError('curve snapshot channels require named, non-empty tables');
    if (!values.every(Number.isFinite))
      throw new RangeError('curve snapshot table values must be finite');
  }
}

function interpolateSnapshotChannels(
  left: Readonly<Record<string, readonly number[]>>,
  right: Readonly<Record<string, readonly number[]>>,
  fraction: number,
): Readonly<Record<string, readonly number[]>> {
  const leftNames = Object.keys(left).sort();
  const rightNames = Object.keys(right).sort();
  if (
    leftNames.length !== rightNames.length ||
    leftNames.some((name, index) => name !== rightNames[index])
  )
    throw new RangeError('curve snapshot channels must match to interpolate');
  const result: Record<string, readonly number[]> = {};
  for (const name of leftNames) {
    const from = left[name]!;
    const to = right[name]!;
    if (from.length !== to.length)
      throw new RangeError('curve snapshot channel table lengths must match to interpolate');
    result[name] = from.map((value, index) => value + (to[index]! - value) * fraction);
  }
  return result;
}

function cloneChannels(
  channels: Readonly<Record<string, readonly number[]>>,
): Readonly<Record<string, readonly number[]>> {
  return Object.fromEntries(Object.entries(channels).map(([name, values]) => [name, [...values]]));
}

function assertFiniteTime(timeUs: number, label: string): void {
  if (!Number.isFinite(timeUs) || !Number.isInteger(timeUs))
    throw new RangeError(`${label} must be a finite integer microsecond value`);
}

function wrapDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function wrapSignedDegrees(value: number): number {
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 && value > 0 ? 180 : wrapped;
}
