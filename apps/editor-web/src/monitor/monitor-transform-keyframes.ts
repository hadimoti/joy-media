import type {
  AnimatablePropertyV1,
  AnimationCurveV1,
  KeyframeV1,
  VisualObjectTransformV1,
  VisualObjectV1,
} from '@joy-media/project-schema';
import { DEFAULT_TRANSFORM_ANCHOR } from '@joy-media/project-schema';
import { sampleCurve, setKeyframe } from '@joy-media/motion-core';
import type { LocalTransform } from './monitor-transform-maths.js';

/**
 * Writing a Monitor gesture into an object (ADR-0046 section 5.6, T-M05b).
 *
 * "The stopwatch is on" means the channel has a curve (`object.animations`),
 * exactly as the Inspector's diamond reads it. For such a channel the gesture
 * writes a keyframe at the playhead: the key that is there gets the new value
 * and keeps its interpolation; a new key takes the interpolation of the key
 * before it (or the first key), so the curve keeps its character. A channel
 * without a curve gets its static value. A gesture never creates a curve and
 * never removes a key, and a channel it did not change is left alone.
 */

/** The new values of one object: its own (local) values at the playhead, and maybe the anchor. */
export interface TransformPatch extends LocalTransform {
  /** The new anchor point as box fractions (only an anchor drag sets these). */
  readonly anchorX?: number;
  readonly anchorY?: number;
}

/** The channels a Monitor gesture can write. */
export const MONITOR_TRANSFORM_CHANNELS = [
  'x',
  'y',
  'scaleX',
  'scaleY',
  'rotationDeg',
] as const satisfies readonly (keyof LocalTransform & AnimatablePropertyV1)[];

/** Keyframes are written on whole microseconds, never before 0 (as the Inspector does). */
export function keyframeTime(timeUs: number): number {
  return Math.max(0, Math.round(timeUs));
}

/**
 * The keyframe a gesture writes at `timeUs`: the existing key with the new
 * value, or a new key with the interpolation (and handles) of the key before
 * it, or of the first key when the playhead is before every key.
 */
export function gestureKeyframe(
  curve: AnimationCurveV1,
  timeUs: number,
  value: number,
): KeyframeV1 {
  const existing = curve.keyframes.find((keyframe) => keyframe.timeUs === timeUs);
  if (existing !== undefined) return { ...existing, value };
  const before = curve.keyframes.filter((keyframe) => keyframe.timeUs <= timeUs).at(-1);
  const model = before ?? curve.keyframes[0];
  return {
    timeUs,
    value,
    interpolation: model?.interpolation ?? 'linear',
    ...(model?.bezier === undefined ? {} : { bezier: model.bezier }),
  };
}

function withAnchor(
  transform: VisualObjectTransformV1,
  patch: TransformPatch,
): VisualObjectTransformV1 {
  if (patch.anchorX === undefined && patch.anchorY === undefined) return transform;
  const x = patch.anchorX ?? transform.anchorX ?? DEFAULT_TRANSFORM_ANCHOR;
  const y = patch.anchorY ?? transform.anchorY ?? DEFAULT_TRANSFORM_ANCHOR;
  const { anchorX: _x, anchorY: _y, ...rest } = transform;
  // Back at the centre the anchor is dropped again, so the object is saved
  // exactly as one that never had an anchor.
  return x === DEFAULT_TRANSFORM_ANCHOR && y === DEFAULT_TRANSFORM_ANCHOR
    ? rest
    : { ...rest, anchorX: x, anchorY: y };
}

/**
 * The object with a gesture's values written in. Without `timeUs` every value
 * is written as a static value (the T-M05a behaviour, used where no playhead
 * applies). With `timeUs` a channel that has a curve gets a keyframe at that
 * time instead, but only when its value there changes.
 */
export function applyTransformPatch(
  object: VisualObjectV1,
  patch: TransformPatch,
  timeUs?: number,
): VisualObjectV1 {
  let transform: VisualObjectTransformV1 = { ...object.transform };
  let animations = object.animations;
  const at = timeUs === undefined ? undefined : keyframeTime(timeUs);
  for (const channel of MONITOR_TRANSFORM_CHANNELS) {
    const value = patch[channel];
    const curve = at === undefined ? undefined : object.animations?.[channel];
    if (curve === undefined || at === undefined) {
      transform = { ...transform, [channel]: value };
      continue;
    }
    if (curve.keyframes.length === 0 || sampleCurve(curve, at) === value) continue;
    animations = {
      ...animations,
      [channel]: setKeyframe(curve, gestureKeyframe(curve, at, value)),
    };
  }
  transform = withAnchor(transform, patch);
  return {
    ...object,
    transform,
    ...(animations === object.animations || animations === undefined ? {} : { animations }),
  };
}

/** The object's own values at `timeUs`: a channel with a curve is read from the curve. */
export function localValuesAt(object: VisualObjectV1, timeUs: number): LocalTransform {
  const at = keyframeTime(timeUs);
  const read = (channel: (typeof MONITOR_TRANSFORM_CHANNELS)[number]) => {
    const curve = object.animations?.[channel];
    return curve === undefined || curve.keyframes.length === 0
      ? object.transform[channel]
      : sampleCurve(curve, at);
  };
  return {
    x: read('x'),
    y: read('y'),
    scaleX: read('scaleX'),
    scaleY: read('scaleY'),
    rotationDeg: read('rotationDeg'),
  };
}
