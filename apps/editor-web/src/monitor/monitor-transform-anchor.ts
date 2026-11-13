import type { NodePoint } from '@joy-media/render-ir';
import {
  cleanNumber,
  finite,
  turn,
  type DrawnTransform,
  type TransformBoxGeometry,
} from './monitor-transform-maths.js';

/**
 * The anchor point on the Monitor (ADR-0046 sections 5.2 and 5.8, T-M05b).
 * Pure: no DOM, no React, no project.
 *
 * The anchor is saved as a fraction of the element's drawn (cropped) box
 * (`anchorX`, `anchorY`; the centre, 0.5, when absent) and drawn as the
 * render origin: the point the element turns about, and with Alt the point a
 * scale handle scales about. Moving it never moves the picture: when the
 * element is turned, the position changes by exactly what keeps every pixel
 * in place.
 */

const EPSILON = 1e-9;

/** Where a box fraction (`0..1` across and down the box) is drawn, in canvas pixels. */
export function anchorPointOf(geometry: TransformBoxGeometry, fraction: NodePoint): NodePoint {
  const [tl, tr, , bl] = geometry.corners;
  return {
    x: tl.x + fraction.x * (tr.x - tl.x) + fraction.y * (bl.x - tl.x),
    y: tl.y + fraction.x * (tr.y - tl.y) + fraction.y * (bl.y - tl.y),
  };
}

/**
 * The box fraction of a canvas point (the inverse of `anchorPointOf`), or
 * `undefined` when the box has no size (a fraction means nothing then).
 */
export function anchorFractionAt(
  geometry: TransformBoxGeometry,
  point: NodePoint,
): NodePoint | undefined {
  const [tl, tr, , bl] = geometry.corners;
  const across = { x: tr.x - tl.x, y: tr.y - tl.y };
  const down = { x: bl.x - tl.x, y: bl.y - tl.y };
  const determinant = across.x * down.y - across.y * down.x;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < EPSILON) return undefined;
  const offset = { x: point.x - tl.x, y: point.y - tl.y };
  const u = (offset.x * down.y - offset.y * down.x) / determinant;
  const v = (across.x * offset.y - across.y * offset.x) / determinant;
  return Number.isFinite(u) && Number.isFinite(v) ? { x: u, y: v } : undefined;
}

export interface AnchorMove {
  /** The drawn values after the move (only the position changes, and only when turned). */
  readonly transform: DrawnTransform;
  /** The new anchor as box fractions. */
  readonly anchor: NodePoint;
}

/**
 * Drag the anchor point from `start` to `now` (canvas pixels): it follows the
 * pointer, and the picture stays where it is. With the anchor moved by `d` on
 * screen and the element turned by `R`, the renderer draws a local point at
 * `translate + S*pivot + R(S*(p - pivot))`; keeping that still while the pivot
 * moves needs the translate to move by `d - R^-1 d` (nothing when not turned).
 * `undefined` when the box has no size.
 */
export function moveAnchor(
  geometry: TransformBoxGeometry,
  start: NodePoint,
  now: NodePoint,
): AnchorMove | undefined {
  const delta = { x: now.x - start.x, y: now.y - start.y };
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return undefined;
  const target = { x: geometry.origin.x + delta.x, y: geometry.origin.y + delta.y };
  const fraction = anchorFractionAt(geometry, target);
  if (fraction === undefined) return undefined;
  const { transform } = geometry;
  const unturned = turn(delta, -transform.rotationDeg);
  const next: DrawnTransform = {
    ...transform,
    x: transform.x + (delta.x - unturned.x),
    y: transform.y + (delta.y - unturned.y),
  };
  if (!finite(next)) return undefined;
  return {
    transform: next,
    anchor: { x: cleanNumber(fraction.x), y: cleanNumber(fraction.y) },
  };
}
