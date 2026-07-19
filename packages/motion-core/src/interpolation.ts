/**
 * Temporal interpolation math (pure). Given two keyframes and a time between
 * them, produce the interpolated scalar. Easing follows the CSS/AE cubic-bezier
 * convention: the segment's shape is owned by the *left* keyframe. No wall-clock,
 * no randomness, no I/O (§20.3 determinism).
 */

import type { BezierHandlesV1, KeyframeV1, TimeUs } from '@joy-media/project-schema';

/** Smooth ease-in-out used by the `'eased'` mode (CSS `ease-in-out`). */
export const EASED_HANDLES: BezierHandlesV1 = { x1: 0.42, y1: 0, x2: 0.58, y2: 1 };

/** One cubic-bezier axis with anchors pinned at 0 and 1 and two free controls. */
function sampleAxis(a1: number, a2: number, s: number): number {
  const c = 3 * a1;
  const b = 3 * (a2 - a1) - c;
  const a = 1 - c - b;
  return ((a * s + b) * s + c) * s;
}

function sampleAxisSlope(a1: number, a2: number, s: number): number {
  const c = 3 * a1;
  const b = 3 * (a2 - a1) - c;
  const a = 1 - c - b;
  return (3 * a * s + 2 * b) * s + c;
}

/** Solves for the bezier parameter `s` whose x-axis value equals `x` in [0, 1]. */
function solveForX(x1: number, x2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Newton-Raphson first — converges in a few steps for well-formed handles.
  let s = x;
  for (let i = 0; i < 8; i += 1) {
    const error = sampleAxis(x1, x2, s) - x;
    if (Math.abs(error) < 1e-7) return s;
    const slope = sampleAxisSlope(x1, x2, s);
    if (Math.abs(slope) < 1e-7) break;
    s -= error / slope;
  }
  // Bisection fallback keeps us correct when the derivative vanishes.
  let low = 0;
  let high = 1;
  s = x;
  for (let i = 0; i < 32; i += 1) {
    const value = sampleAxis(x1, x2, s);
    if (Math.abs(value - x) < 1e-7) return s;
    if (value < x) low = s;
    else high = s;
    s = (low + high) / 2;
  }
  return s;
}

/** Maps a normalized time fraction `t` in [0, 1] to an eased value fraction. */
export function cubicBezierEase(handles: BezierHandlesV1, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return sampleAxis(handles.y1, handles.y2, solveForX(handles.x1, handles.x2, t));
}

/** The eased value fraction for the segment leaving `left`, at time fraction `t`. */
export function segmentEaseFraction(
  interpolation: KeyframeV1['interpolation'],
  bezier: BezierHandlesV1 | undefined,
  t: number,
): number {
  switch (interpolation) {
    case 'hold':
      return 0;
    case 'linear':
      return t;
    case 'eased':
      return cubicBezierEase(EASED_HANDLES, t);
    case 'bezier':
      return cubicBezierEase(bezier ?? EASED_HANDLES, t);
    default:
      return t;
  }
}

/** Interpolates the scalar value inside the segment [left, right] at `timeUs`. */
export function interpolateSegment(left: KeyframeV1, right: KeyframeV1, timeUs: TimeUs): number {
  if (timeUs <= left.timeUs) return left.value;
  if (timeUs >= right.timeUs) return left.interpolation === 'hold' ? left.value : right.value;
  const span = right.timeUs - left.timeUs;
  const t = span <= 0 ? 0 : (timeUs - left.timeUs) / span;
  const fraction = segmentEaseFraction(left.interpolation, left.bezier, t);
  return left.value + (right.value - left.value) * fraction;
}
