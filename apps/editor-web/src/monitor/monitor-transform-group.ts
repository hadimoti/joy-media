import { rotatePointAbout, type NodePoint } from '@joy-media/render-ir';
import {
  angleFrom,
  finite,
  handlePoint,
  oppositeHandle,
  scaleTransform,
  smallestRatio,
  snapAngle,
  wrapDegrees,
  type DrawnTransform,
  type MonitorScaleHandle,
  type ScaleModifiers,
  type TransformBoxGeometry,
} from './monitor-transform-maths.js';

/**
 * Scale and rotate for a group of selected elements (ADR-0046 section 5.7,
 * T-M05b). Pure: no DOM, no React, no project.
 *
 * The group box is the straight (unturned) rectangle around every selected
 * box. Its handles work like one element's: a corner or edge scales from the
 * opposite handle (Alt: from the group centre, Shift keeps the proportions),
 * the rotate handle turns every element about the group centre (Shift snaps
 * the turn to 15 degree steps). Each element keeps its own values and changes
 * relative to them, as the property registry asks for position, scale and
 * rotation (`multiEditPolicy: 'relative'`): its anchor point moves with the
 * group, its scale is multiplied and its rotation added to.
 */

/** The straight box around every element, as a box geometry (rotation 0, anchor at the centre). */
export function groupGeometry(
  geometries: readonly TransformBoxGeometry[],
): TransformBoxGeometry | undefined {
  const points = geometries.flatMap((geometry) => geometry.corners);
  if (points.length === 0) return undefined;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return undefined;
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  return {
    transform: { x: minX, y: minY, scaleX: 1, scaleY: 1, rotationDeg: 0 },
    corners: [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ],
    center,
    origin: center,
  };
}

/** How a group handle drag scales: about `fixed`, by `kx` across and `ky` down the frame. */
export interface GroupScale {
  readonly fixed: NodePoint;
  readonly kx: number;
  readonly ky: number;
}

/**
 * The scale a group handle drag asks for, with the same rules as one element
 * (the group box is never turned, so its axes are the frame's). The group box
 * stops at 1 % of its size, never flips.
 */
export function groupScaleOf(
  group: TransformBoxGeometry,
  handle: MonitorScaleHandle,
  start: NodePoint,
  now: NodePoint,
  modifiers: ScaleModifiers,
): GroupScale {
  // The group box is scale 1, so the scale it reaches is the ratio itself.
  const scaled = scaleTransform(group, handle, start, now, modifiers);
  return {
    fixed: modifiers.alt ? group.center : handlePoint(group, oppositeHandle(handle)),
    kx: scaled.scaleX,
    ky: scaled.scaleY,
  };
}

/**
 * One element of a group scaled about `fixed` by `kx` and `ky` (frame axes).
 * Its anchor point moves with the group. Its own scale is multiplied by how
 * much the group stretches along the element's own sides: exactly `kx` and
 * `ky` when it is not turned (or turned a half turn), swapped at a quarter
 * turn, and the same for both axes when the group keeps its proportions.
 * A turned element under an uneven stretch keeps its shape (an element cannot
 * be skewed), so its sides follow the stretch as closely as a scale can. Each
 * scale stops at `MIN_SCALE`; nothing turns into NaN.
 */
export function scaleMemberAbout(
  geometry: TransformBoxGeometry,
  scale: GroupScale,
): DrawnTransform {
  const { transform, origin } = geometry;
  const { fixed, kx, ky } = scale;
  const radians = (transform.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const fx = Math.max(Math.hypot(kx * cos, ky * sin), smallestRatio(transform.scaleX));
  const fy = Math.max(Math.hypot(kx * sin, ky * cos), smallestRatio(transform.scaleY));
  const nextOrigin = {
    x: fixed.x + kx * (origin.x - fixed.x),
    y: fixed.y + ky * (origin.y - fixed.y),
  };
  // The anchor sits `scale * pivot` from the translate, whatever the rotation,
  // so the new translate puts the anchor at its new place.
  const next: DrawnTransform = {
    ...transform,
    scaleX: transform.scaleX * fx,
    scaleY: transform.scaleY * fy,
    x: nextOrigin.x - fx * (origin.x - transform.x),
    y: nextOrigin.y - fy * (origin.y - transform.y),
  };
  return finite(next) ? next : transform;
}

/**
 * The turn a group rotate drag asks for: the angle the pointer swept about
 * the group centre, in degrees. Shift snaps the turn to 15 degree steps (the
 * elements keep their own angles and all turn by the same amount).
 */
export function groupTurnOf(
  group: TransformBoxGeometry,
  start: NodePoint,
  now: NodePoint,
  modifiers: { readonly shift: boolean },
): number {
  const from = angleFrom(group.center, start);
  const to = angleFrom(group.center, now);
  if (from === undefined || to === undefined) return 0;
  const turned = wrapDegrees(to - from);
  const degrees = modifiers.shift ? snapAngle(turned) : turned;
  return Number.isFinite(degrees) ? degrees : 0;
}

/**
 * One element of a group turned by `degrees` about `center`: its anchor point
 * goes round the centre and the element turns by the same angle, so the group
 * turns as one piece.
 */
export function rotateMemberAbout(
  geometry: TransformBoxGeometry,
  center: NodePoint,
  degrees: number,
): DrawnTransform {
  const { transform, origin } = geometry;
  if (degrees === 0) return transform;
  const moved = rotatePointAbout(origin, center, degrees);
  const next: DrawnTransform = {
    ...transform,
    rotationDeg: transform.rotationDeg + degrees,
    x: transform.x + (moved.x - origin.x),
    y: transform.y + (moved.y - origin.y),
  };
  return finite(next) ? next : transform;
}
