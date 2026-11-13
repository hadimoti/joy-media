import {
  frameToLocalPoint,
  rotatePointAbout,
  type NodeBounds,
  type NodePoint,
  type NodeRect,
  type Transform2D,
} from '@joy-media/render-ir';

/**
 * The free-transform box maths (ADR-0046 section 5, review B2 and B4, T-M05a).
 * Pure: no DOM, no React, no project. Every rotation formula of the box lives
 * here and in `@joy-media/render-ir` (node-geometry), which the renderer uses
 * too, so the box turns exactly like the picture.
 *
 * The box never needs the node's local box. It works from what the renderer
 * reports (`nodeBounds(id)`: the four corners and the origin, the point the
 * node turns about) plus the drawn transform. With `A` the origin, `R` the
 * rotation and `S` the scale, a local point `p` is drawn at
 * `A + R(S * (p - pivot))`, so a corner's offset from the origin, turned back
 * by `-R`, is `S * (p - pivot)`: scaling about any fixed point is a ratio of
 * those offsets, whatever the node's size or kind.
 */

/** The eight scale handles: corners and edge midpoints, by compass point. */
export type MonitorScaleHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type MonitorHandle = MonitorScaleHandle | 'rotate';

export const MONITOR_SCALE_HANDLES: readonly MonitorScaleHandle[] = [
  'nw',
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
];

/** Shift while rotating snaps to this step. */
export const ROTATE_SNAP_DEGREES = 15;
/** Arrow keys nudge this many frame pixels; with Shift ten times as many. */
export const NUDGE_PIXELS = 1;
export const NUDGE_SHIFT_PIXELS = 10;

const EPSILON = 1e-9;

/**
 * The smallest scale a handle drag can reach. v1.1.1 has no flip: the project
 * (`validateJoyProjectV1`) and the render frame (`validateRenderFrameIR`)
 * accept positive scales only, so a handle dragged past the opposite side
 * stops the box at this size instead of turning it inside out.
 */
export const MIN_SCALE = 0.01;

/** The drawn (world) values of one element: what the renderer draws with. */
export interface DrawnTransform {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotationDeg: number;
}

/** The box of one drawn element, in frame (canvas) pixels. */
export interface TransformBoxGeometry {
  readonly transform: DrawnTransform;
  /** Local top-left, top-right, bottom-right, bottom-left (as `nodeBounds`). */
  readonly corners: readonly [NodePoint, NodePoint, NodePoint, NodePoint];
  readonly center: NodePoint;
  /** The point the element turns about (`nodeBounds(id).origin`). */
  readonly origin: NodePoint;
}

/** The drawn values of a render transform (rotation absent means 0). */
export function drawnTransformOf(transform: Transform2D): DrawnTransform {
  return {
    x: transform.translateX,
    y: transform.translateY,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    rotationDeg: transform.rotationDeg ?? 0,
  };
}

/** The box of an element from the renderer's bounds and the transform it drew with. */
export function boxGeometry(bounds: NodeBounds, transform: Transform2D): TransformBoxGeometry {
  return {
    transform: drawnTransformOf(transform),
    corners: bounds.corners,
    center: bounds.center,
    origin: bounds.origin,
  };
}

/**
 * A canvas point in the element's own (local, unscaled, unrotated) space: the
 * inverse of the element transform, through the same maths as the renderer.
 */
export function elementLocalPoint(
  transform: Transform2D,
  localBox: NodeRect,
  canvasPoint: NodePoint,
): NodePoint {
  return frameToLocalPoint(transform, localBox, canvasPoint);
}

function midpoint(a: NodePoint, b: NodePoint): NodePoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function sub(a: NodePoint, b: NodePoint): NodePoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

function add(a: NodePoint, b: NodePoint): NodePoint {
  return { x: a.x + b.x, y: a.y + b.y };
}

const ZERO: NodePoint = { x: 0, y: 0 };

/** Turns a vector by `degrees` (clockwise on screen, y down). */
function turn(vector: NodePoint, degrees: number): NodePoint {
  return rotatePointAbout(vector, ZERO, degrees);
}

function finite(transform: DrawnTransform): boolean {
  return (
    Number.isFinite(transform.x) &&
    Number.isFinite(transform.y) &&
    Number.isFinite(transform.scaleX) &&
    Number.isFinite(transform.scaleY) &&
    Number.isFinite(transform.rotationDeg)
  );
}

/** Where a scale handle sits on the box, in canvas pixels. */
export function handlePoint(geometry: TransformBoxGeometry, handle: MonitorScaleHandle): NodePoint {
  const [tl, tr, br, bl] = geometry.corners;
  switch (handle) {
    case 'nw':
      return tl;
    case 'ne':
      return tr;
    case 'se':
      return br;
    case 'sw':
      return bl;
    case 'n':
      return midpoint(tl, tr);
    case 'e':
      return midpoint(tr, br);
    case 's':
      return midpoint(br, bl);
    case 'w':
      return midpoint(bl, tl);
  }
}

const OPPOSITE: Readonly<Record<MonitorScaleHandle, MonitorScaleHandle>> = {
  nw: 'se',
  n: 's',
  ne: 'sw',
  e: 'w',
  se: 'nw',
  s: 'n',
  sw: 'ne',
  w: 'e',
};

/** The handle across the box (the point that stays still without Alt). */
export function oppositeHandle(handle: MonitorScaleHandle): MonitorScaleHandle {
  return OPPOSITE[handle];
}

/** Which local axes a handle scales: corners both, edges one. */
export function handleAxes(handle: MonitorScaleHandle): {
  readonly x: boolean;
  readonly y: boolean;
} {
  if (handle === 'n' || handle === 's') return { x: false, y: true };
  if (handle === 'e' || handle === 'w') return { x: true, y: false };
  return { x: true, y: true };
}

export function isCornerHandle(handle: MonitorScaleHandle): boolean {
  const axes = handleAxes(handle);
  return axes.x && axes.y;
}

/**
 * Where the rotate handle sits: `offset` canvas pixels beyond the middle of the
 * top edge, away from the centre (so it follows the box when turned).
 */
export function rotateHandlePoint(geometry: TransformBoxGeometry, offset: number): NodePoint {
  const top = handlePoint(geometry, 'n');
  const away = sub(top, geometry.center);
  const length = Math.hypot(away.x, away.y);
  const direction =
    length > EPSILON
      ? { x: away.x / length, y: away.y / length }
      : turn({ x: 0, y: -1 }, geometry.transform.rotationDeg);
  return { x: top.x + direction.x * offset, y: top.y + direction.y * offset };
}

/** Drag inside the box: the element moves with the pointer. */
export function moveTransform(transform: DrawnTransform, delta: NodePoint): DrawnTransform {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return transform;
  return { ...transform, x: transform.x + delta.x, y: transform.y + delta.y };
}

export interface ScaleModifiers {
  /** Keep the proportions. */
  readonly shift: boolean;
  /** Scale about the centre instead of the opposite handle. */
  readonly alt: boolean;
}

/**
 * Drag a scale handle from `start` to `now` (canvas pixels). The opposite
 * handle (or the centre with Alt) stays where it is; the handle follows the
 * pointer along the box's own axes, so a turned box scales along its turned
 * sides. Shift keeps the proportions. There is no flip in v1.1.1: dragging
 * towards or past the fixed point stops each scale at `MIN_SCALE` (a scale
 * already below it cannot shrink further). An axis with no size (a zero scale or an empty
 * box) cannot be dragged: it keeps its value, except that Shift carries the
 * other axis's ratio over to keep the proportions (a zero scale stays zero).
 * Nothing ever turns into NaN.
 */
export function scaleTransform(
  geometry: TransformBoxGeometry,
  handle: MonitorScaleHandle,
  start: NodePoint,
  now: NodePoint,
  modifiers: ScaleModifiers,
): DrawnTransform {
  const { transform, origin } = geometry;
  const rotation = transform.rotationDeg;
  const toBox = (vector: NodePoint) => turn(vector, -rotation);
  const fixedPoint = modifiers.alt
    ? geometry.center
    : handlePoint(geometry, oppositeHandle(handle));
  const handleOffset = toBox(sub(handlePoint(geometry, handle), origin));
  const fixedOffset = toBox(sub(fixedPoint, origin));
  const span = sub(handleOffset, fixedOffset);
  const target = add(span, toBox(sub(now, start)));
  const axes = handleAxes(handle);
  let kx = axes.x && Math.abs(span.x) > EPSILON ? target.x / span.x : 1;
  let ky = axes.y && Math.abs(span.y) > EPSILON ? target.y / span.y : 1;
  if (modifiers.shift) {
    if (isCornerHandle(handle)) {
      const length = span.x * span.x + span.y * span.y;
      const k = length > EPSILON ? (target.x * span.x + target.y * span.y) / length : 1;
      kx = k;
      ky = k;
    } else {
      const k = axes.x ? kx : ky;
      kx = k;
      ky = k;
    }
  }
  // No flip: each scale stops at its smallest allowed value. With Shift both
  // axes stop together, so the proportions stay.
  const floorX = smallestRatio(transform.scaleX);
  const floorY = smallestRatio(transform.scaleY);
  if (modifiers.shift) {
    const k = Math.max(kx, floorX, floorY);
    kx = k;
    ky = k;
  } else {
    kx = Math.max(kx, floorX);
    ky = Math.max(ky, floorY);
  }
  // The fixed point keeps its place: A' = F - R(k * fixedOffset), and the
  // translate keeps the origin at the same place inside the box.
  const nextOrigin = sub(
    fixedPoint,
    turn({ x: kx * fixedOffset.x, y: ky * fixedOffset.y }, rotation),
  );
  const next: DrawnTransform = {
    ...transform,
    scaleX: transform.scaleX * kx,
    scaleY: transform.scaleY * ky,
    x: nextOrigin.x - kx * (origin.x - transform.x),
    y: nextOrigin.y - ky * (origin.y - transform.y),
  };
  return finite(next) ? next : transform;
}

/**
 * The smallest ratio a positive scale can be multiplied by: down to
 * `MIN_SCALE`, or not below where it already is when it is smaller. A zero
 * (or invalid) scale is not limited: a ratio cannot change it into a valid one.
 */
function smallestRatio(scale: number): number {
  return scale > 0 ? Math.min(MIN_SCALE, scale) / scale : Number.NEGATIVE_INFINITY;
}

/** The angle, in degrees, of `point` seen from `center` (clockwise on screen). */
function angleFrom(center: NodePoint, point: NodePoint): number | undefined {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  if (Math.hypot(dx, dy) < 1e-6) return undefined;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/** Wraps an angle difference into (-180, 180]. */
function wrapDegrees(degrees: number): number {
  let wrapped = degrees % 360;
  if (wrapped <= -180) wrapped += 360;
  if (wrapped > 180) wrapped -= 360;
  return wrapped;
}

/** Rounds to the nearest multiple of `step` degrees. */
export function snapAngle(degrees: number, step = ROTATE_SNAP_DEGREES): number {
  const snapped = Math.round(degrees / step) * step;
  return snapped === 0 ? 0 : snapped;
}

/**
 * Drag the rotate handle from `start` to `now`: the element turns about its
 * origin (the centre by default) by the angle the pointer swept. Shift snaps
 * the resulting rotation to 15 degree steps. The origin stays in place, so
 * only the rotation changes.
 */
export function rotateTransform(
  geometry: TransformBoxGeometry,
  start: NodePoint,
  now: NodePoint,
  modifiers: { readonly shift: boolean },
): DrawnTransform {
  const { transform, origin } = geometry;
  const from = angleFrom(origin, start);
  const to = angleFrom(origin, now);
  if (from === undefined || to === undefined) return transform;
  const turned = transform.rotationDeg + wrapDegrees(to - from);
  const rotationDeg = modifiers.shift ? snapAngle(turned) : turned;
  return Number.isFinite(rotationDeg) ? { ...transform, rotationDeg } : transform;
}

/** The movement an arrow key asks for, in frame pixels, or `undefined` for other keys. */
export function nudgeDelta(key: string, shift: boolean): NodePoint | undefined {
  const step = shift ? NUDGE_SHIFT_PIXELS : NUDGE_PIXELS;
  switch (key) {
    case 'ArrowLeft':
      return { x: -step, y: 0 };
    case 'ArrowRight':
      return { x: step, y: 0 };
    case 'ArrowUp':
      return { x: 0, y: -step };
    case 'ArrowDown':
      return { x: 0, y: step };
    default:
      return undefined;
  }
}

/** The world transform of an element's parent (ADR-0046 review B4). */
export type ParentTransform = DrawnTransform;

/**
 * A movement in the frame, expressed in the parent's space: the inverse of
 * how a parent places its child (`composeTransforms` in motion-core: turn by
 * the parent's rotation, then multiply by its scale). `undefined` when the
 * parent has no size on an axis (the movement cannot be expressed).
 */
export function worldDeltaToParentSpace(
  delta: NodePoint,
  parent: ParentTransform | undefined,
): NodePoint | undefined {
  if (parent === undefined) return delta;
  if (Math.abs(parent.scaleX) < EPSILON || Math.abs(parent.scaleY) < EPSILON) return undefined;
  const unturned = turn(delta, -parent.rotationDeg);
  return { x: unturned.x / parent.scaleX, y: unturned.y / parent.scaleY };
}

/** True when the parent's space can be inverted (its scale is not 0 on an axis). */
export function parentSpaceInvertible(parent: ParentTransform | undefined): boolean {
  return worldDeltaToParentSpace({ x: 1, y: 1 }, parent) !== undefined;
}

/** The local (document) values of one element. */
export type LocalTransform = DrawnTransform;

/** Drops floating-point noise (for the numbers the Inspector shows). */
export function cleanNumber(value: number): number {
  const cleaned = Math.round(value * 1e6) / 1e6;
  return cleaned === 0 ? 0 : cleaned;
}

/**
 * Turns a change of the drawn (world) values into the new local values the
 * document stores (B4). The change is applied as a difference, so a value the
 * gesture did not touch is written back exactly as it was:
 * - the movement goes back through the parent (turned and divided by its scale);
 * - a scale changes by the same ratio as the drawn scale (a parent multiplies it);
 * - a rotation changes by the same angle (a parent adds its own).
 * `undefined` when the movement cannot be expressed in the parent's space.
 */
export function applyWorldChange(
  local: LocalTransform,
  before: DrawnTransform,
  after: DrawnTransform,
  parent?: ParentTransform,
): LocalTransform | undefined {
  const moved = { x: after.x - before.x, y: after.y - before.y };
  const localMove = moved.x === 0 && moved.y === 0 ? ZERO : worldDeltaToParentSpace(moved, parent);
  if (localMove === undefined) return undefined;
  const ratio = (next: number, previous: number) =>
    next === previous || Math.abs(previous) < EPSILON ? 1 : next / previous;
  const kx = ratio(after.scaleX, before.scaleX);
  const ky = ratio(after.scaleY, before.scaleY);
  const turned = after.rotationDeg - before.rotationDeg;
  return {
    x: localMove.x === 0 ? local.x : cleanNumber(local.x + localMove.x),
    y: localMove.y === 0 ? local.y : cleanNumber(local.y + localMove.y),
    scaleX: kx === 1 ? local.scaleX : cleanNumber(local.scaleX * kx),
    scaleY: ky === 1 ? local.scaleY : cleanNumber(local.scaleY * ky),
    rotationDeg: turned === 0 ? local.rotationDeg : cleanNumber(local.rotationDeg + turned),
  };
}
