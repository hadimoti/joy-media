import type { NodeBounds, NodePoint, NodeRect } from '@joy-media/render-ir';

/**
 * The Monitor's hit test (ADR-0046 section 4 and review B3, T-M04). Pure: no
 * DOM, no React, no project. The caller passes the drawn elements topmost
 * first, each with the box the renderer reports (`nodeBounds(id)` from T-M15),
 * so a rotated or scaled element is hit inside its turned box. A picture with
 * a fully transparent area still counts as its whole box: only the box is
 * tested, never the pixels.
 */

/** One drawn element the hit test can find. */
export interface HitTestElement {
  /** The drawn node id (as in `RenderFrameIR` and `nodeBounds`). */
  readonly id: string;
  /** The drawn box from `nodeBounds(id)`; only the four corners are read. */
  readonly bounds: Pick<NodeBounds, 'corners'>;
  /** On a locked track: never hit, never in a marquee. */
  readonly locked?: boolean;
  /** On a hidden track: never hit, never in a marquee. */
  readonly hidden?: boolean;
}

function selectable(element: HitTestElement): boolean {
  return element.locked !== true && element.hidden !== true;
}

function cross(a: NodePoint, b: NodePoint, p: NodePoint): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

/** Twice the signed area of the box; 0 when it has no size. */
function signedArea(corners: readonly NodePoint[]): number {
  let area = 0;
  for (let index = 0; index < corners.length; index += 1) {
    const a = corners[index]!;
    const b = corners[(index + 1) % corners.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area;
}

const EPSILON = 1e-9;

/**
 * True when `point` lies inside the box or on its edge. The box is convex; the
 * corner order may turn either way (a negative scale mirrors it).
 */
export function boxContainsPoint(corners: readonly NodePoint[], point: NodePoint): boolean {
  const area = signedArea(corners);
  if (!Number.isFinite(area) || Math.abs(area) < EPSILON) return false;
  const sign = area > 0 ? 1 : -1;
  for (let index = 0; index < corners.length; index += 1) {
    const a = corners[index]!;
    const b = corners[(index + 1) % corners.length]!;
    if (sign * cross(a, b, point) < -EPSILON) return false;
  }
  return true;
}

/**
 * The ids of every selectable element under `canvasPoint` (authored frame
 * pixels), topmost first, in the order the caller gave.
 */
export function hitTestElements(
  canvasPoint: { x: number; y: number },
  elements: readonly HitTestElement[],
): readonly string[] {
  return elements
    .filter(
      (element) => selectable(element) && boxContainsPoint(element.bounds.corners, canvasPoint),
    )
    .map((element) => element.id);
}

/** The axis-aligned rectangle between two drag points (any direction). */
export function marqueeRect(
  start: { x: number; y: number },
  end: { x: number; y: number },
): NodeRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return { x, y, width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

function project(points: readonly NodePoint[], axis: NodePoint): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    const value = point.x * axis.x + point.y * axis.y;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

/** True when the rectangle and the box overlap at all (touching counts). */
export function rectOverlapsBox(rect: NodeRect, corners: readonly NodePoint[]): boolean {
  const area = signedArea(corners);
  if (!Number.isFinite(area) || Math.abs(area) < EPSILON) return false;
  const rectCorners: NodePoint[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  // Separating axis test: the rectangle's two axes and each box edge normal.
  const axes: NodePoint[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ];
  for (let index = 0; index < corners.length; index += 1) {
    const a = corners[index]!;
    const b = corners[(index + 1) % corners.length]!;
    if (a.x !== b.x || a.y !== b.y) axes.push({ x: -(b.y - a.y), y: b.x - a.x });
  }
  for (const axis of axes) {
    const r = project(rectCorners, axis);
    const c = project(corners, axis);
    if (r.max < c.min - EPSILON || c.max < r.min - EPSILON) return false;
  }
  return true;
}

/**
 * The ids of every selectable element the marquee from `start` to `end`
 * touches (partial overlap is enough), topmost first.
 */
export function marqueeSelect(
  start: { x: number; y: number },
  end: { x: number; y: number },
  elements: readonly HitTestElement[],
): readonly string[] {
  const rect = marqueeRect(start, end);
  return elements
    .filter((element) => selectable(element) && rectOverlapsBox(rect, element.bounds.corners))
    .map((element) => element.id);
}
