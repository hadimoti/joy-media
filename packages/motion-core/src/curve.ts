/**
 * Pure editing and sampling of scalar animation curves. Curves are immutable;
 * every editor returns a new curve. Keyframes are always kept sorted and unique
 * in time, so sampling can assume a strictly increasing timeline.
 */

import type { AnimationCurveV1, KeyframeV1, TimeUs } from '@joy-media/project-schema';
import { interpolateSegment } from './interpolation.js';

/** Keyframes copied to a clipboard, with times made relative to the copy anchor. */
export interface KeyframeClipboard {
  /** Keyframes with `timeUs` measured from the earliest copied keyframe. */
  readonly relative: readonly KeyframeV1[];
}

function sortKeyframes(keyframes: readonly KeyframeV1[]): KeyframeV1[] {
  return [...keyframes].sort((left, right) => left.timeUs - right.timeUs);
}

/** Samples the curve at a document-local time. Flat before the first / after the last key. */
export function sampleCurve(curve: AnimationCurveV1, timeUs: TimeUs): number {
  const keyframes = curve.keyframes;
  const first = keyframes[0];
  if (first === undefined) throw new RangeError('animation curve has no keyframes');
  if (timeUs <= first.timeUs) return first.value;
  const last = keyframes[keyframes.length - 1]!;
  if (timeUs >= last.timeUs) return last.value;

  // Find the segment whose left keyframe is the greatest keyframe at or before
  // the sample time. Curves can grow large in a long composition, so keep the
  // evaluator logarithmic instead of walking every preceding segment.
  let low = 0;
  let high = keyframes.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (keyframes[middle]!.timeUs <= timeUs) low = middle;
    else high = middle;
  }
  return interpolateSegment(keyframes[low]!, keyframes[high]!, timeUs);
}

/** True when a keyframe exists exactly at `timeUs`. */
export function hasKeyframeAt(curve: AnimationCurveV1, timeUs: TimeUs): boolean {
  return curve.keyframes.some((keyframe) => keyframe.timeUs === timeUs);
}

/** Inserts or replaces the keyframe at `keyframe.timeUs`, returning a new curve. */
export function setKeyframe(
  curve: AnimationCurveV1 | undefined,
  keyframe: KeyframeV1,
): AnimationCurveV1 {
  const others = (curve?.keyframes ?? []).filter((item) => item.timeUs !== keyframe.timeUs);
  return { keyframes: sortKeyframes([...others, keyframe]) };
}

/**
 * Removes the keyframe at `timeUs`. Returns the reduced curve, or `undefined`
 * when the last keyframe is removed (an animation with no keyframes is not a
 * thing — the caller should drop the channel and fall back to the static value).
 */
export function removeKeyframe(
  curve: AnimationCurveV1,
  timeUs: TimeUs,
): AnimationCurveV1 | undefined {
  const kept = curve.keyframes.filter((keyframe) => keyframe.timeUs !== timeUs);
  return kept.length === 0 ? undefined : { keyframes: kept };
}

/**
 * Scales keyframe values around `pivot` by `factor` (value scaling, §20.3). The
 * curve's timing is untouched; only magnitudes change. `pivot` defaults to 0.
 */
export function scaleCurveValues(
  curve: AnimationCurveV1,
  factor: number,
  pivot = 0,
): AnimationCurveV1 {
  if (!Number.isFinite(factor)) throw new RangeError('scale factor must be finite');
  return {
    keyframes: curve.keyframes.map((keyframe) => ({
      ...keyframe,
      value: pivot + (keyframe.value - pivot) * factor,
    })),
  };
}

/** Copies keyframes within [startUs, endUs] to a time-relative clipboard. */
export function copyKeyframes(
  curve: AnimationCurveV1,
  startUs: TimeUs,
  endUs: TimeUs,
): KeyframeClipboard {
  const selected = curve.keyframes.filter(
    (keyframe) => keyframe.timeUs >= startUs && keyframe.timeUs <= endUs,
  );
  const anchor = selected[0]?.timeUs ?? 0;
  return {
    relative: selected.map((keyframe) => ({ ...keyframe, timeUs: keyframe.timeUs - anchor })),
  };
}

/**
 * Pastes a clipboard so its first keyframe lands at `atTimeUs`. Clipboard keys
 * replace any existing keys at colliding times. Times must stay non-negative.
 */
export function pasteKeyframes(
  curve: AnimationCurveV1 | undefined,
  clipboard: KeyframeClipboard,
  atTimeUs: TimeUs,
): AnimationCurveV1 {
  let next: AnimationCurveV1 = curve ?? { keyframes: [] };
  for (const keyframe of clipboard.relative) {
    const timeUs = atTimeUs + keyframe.timeUs;
    if (timeUs < 0) throw new RangeError('pasted keyframe time cannot be negative');
    next = setKeyframe(next, { ...keyframe, timeUs });
  }
  if (next.keyframes.length === 0) throw new RangeError('cannot paste an empty clipboard');
  return next;
}
