/**
 * Spatial interpolation: a 2D motion path where position keyframes carry
 * optional Bezier tangents, so a point can travel a curved trajectory rather
 * than a straight line between keys (§20.3 spatial interpolation). Temporal
 * easing still governs *how fast* the point moves along that path; the tangents
 * govern *the shape* of the path.
 *
 * WP-04.1 delivers the pure engine. Durable 2D-path storage and the graph
 * editor that authors these tangents are WP-04.2 (motion UI).
 */

import type { BezierHandlesV1, KeyframeInterpolationV1, TimeUs } from '@joy-media/project-schema';
import { segmentEaseFraction } from './interpolation.js';

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** A position keyframe on a 2D motion path. Tangents are offsets from the point. */
export interface SpatialKeyframe {
  readonly timeUs: TimeUs;
  readonly point: Vec2;
  readonly interpolation: KeyframeInterpolationV1;
  readonly bezier?: BezierHandlesV1;
  /** Outgoing tangent handle (offset from `point`); absent means a straight exit. */
  readonly outTangent?: Vec2;
  /** Incoming tangent handle (offset from `point`); absent means a straight entry. */
  readonly inTangent?: Vec2;
}

function cubicPoint(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, s: number): Vec2 {
  const u = 1 - s;
  const w0 = u * u * u;
  const w1 = 3 * u * u * s;
  const w2 = 3 * u * s * s;
  const w3 = s * s * s;
  return {
    x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
    y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
  };
}

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Samples the 2D path at `timeUs`. Flat before the first / after the last key. */
export function sampleSpatialPath(keyframes: readonly SpatialKeyframe[], timeUs: TimeUs): Vec2 {
  const first = keyframes[0];
  if (first === undefined) throw new RangeError('spatial path has no keyframes');
  if (timeUs <= first.timeUs) return first.point;
  const last = keyframes[keyframes.length - 1]!;
  if (timeUs >= last.timeUs) return last.point;
  for (let i = 0; i < keyframes.length - 1; i += 1) {
    const left = keyframes[i]!;
    const right = keyframes[i + 1]!;
    if (timeUs >= right.timeUs) continue;
    if (left.interpolation === 'hold') return left.point;
    const span = right.timeUs - left.timeUs;
    const t = span <= 0 ? 0 : (timeUs - left.timeUs) / span;
    const s = segmentEaseFraction(left.interpolation, left.bezier, t);
    if (left.outTangent === undefined && right.inTangent === undefined)
      return lerp(left.point, right.point, s);
    const control1 = left.outTangent
      ? { x: left.point.x + left.outTangent.x, y: left.point.y + left.outTangent.y }
      : left.point;
    const control2 = right.inTangent
      ? { x: right.point.x + right.inTangent.x, y: right.point.y + right.inTangent.y }
      : right.point;
    return cubicPoint(left.point, control1, control2, right.point, s);
  }
  return last.point;
}
