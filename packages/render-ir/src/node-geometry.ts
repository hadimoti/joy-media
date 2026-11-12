/**
 * Node geometry shared by every renderer (ADR-0046 review B2 and B3, T-M15).
 *
 * A node is drawn from its local box (authored pixels before the transform).
 * The transform maps a local point `p` to the frame:
 *
 *   frame(p) = translate + scale * pivot + R(rotationDeg) * (scale * (p - pivot))
 *
 * where `pivot` is the origin (anchor point) inside the local box. With
 * `rotationDeg` 0 this is exactly `translate + scale * p`, the mapping every
 * renderer used before rotation existed, so the origin changes nothing until a
 * node is rotated. Renderers keep their old code path when the rotation is 0,
 * so frames without rotation stay bit-identical.
 */
import type { Transform2D } from './model.js';

export interface NodePoint {
  readonly x: number;
  readonly y: number;
}

/** A rectangle in authored pixels (local box of a node, or an axis-aligned frame rect). */
export interface NodeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The drawn rectangle of a node in authored frame pixels. */
export interface NodeBounds {
  readonly id: string;
  /** Corners of the drawn box in frame pixels: local top-left, top-right, bottom-right, bottom-left. */
  readonly corners: readonly [NodePoint, NodePoint, NodePoint, NodePoint];
  /** Centre of the drawn box in frame pixels. */
  readonly center: NodePoint;
  /** Size of the drawn box before rotation (local box size times scale). */
  readonly width: number;
  readonly height: number;
  /** Rotation of the box, degrees clockwise on screen (0 when absent). */
  readonly rotationDeg: number;
  /** The origin (anchor point) in frame pixels: the point the box rotates about. */
  readonly origin: NodePoint;
  /** Axis-aligned rectangle around the corners (equals the box when not rotated). */
  readonly aabb: NodeRect;
}

/** The default origin: the centre of the node's local box. */
export const DEFAULT_NODE_ORIGIN: NodePoint = { x: 0.5, y: 0.5 };

/** Rotation in degrees; absent means 0. */
export function nodeRotationDeg(transform: Transform2D): number {
  return transform.rotationDeg ?? 0;
}

/** True when the node is drawn rotated (anything other than 0 degrees). */
export function isRotated(transform: Transform2D): boolean {
  return nodeRotationDeg(transform) !== 0;
}

/** The origin as a fraction of the local box; absent means the centre. */
export function nodeOrigin(transform: Transform2D): NodePoint {
  return transform.origin ?? DEFAULT_NODE_ORIGIN;
}

/** The origin as a point in the local box (authored pixels before the transform). */
export function nodePivot(transform: Transform2D, box: NodeRect): NodePoint {
  const origin = nodeOrigin(transform);
  return { x: box.x + origin.x * box.width, y: box.y + origin.y * box.height };
}

/** Rotates `point` about `center` by `degrees` (positive = clockwise on screen, y down). */
export function rotatePointAbout(point: NodePoint, center: NodePoint, degrees: number): NodePoint {
  if (degrees === 0) return point;
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

/** Local point (inside the node's box) to frame point. */
export function localToFramePoint(
  transform: Transform2D,
  box: NodeRect,
  point: NodePoint,
): NodePoint {
  const { translateX, translateY, scaleX, scaleY } = transform;
  if (!isRotated(transform)) {
    return { x: translateX + point.x * scaleX, y: translateY + point.y * scaleY };
  }
  const pivot = nodePivot(transform, box);
  const anchor = { x: translateX + pivot.x * scaleX, y: translateY + pivot.y * scaleY };
  const scaled = {
    x: anchor.x + (point.x - pivot.x) * scaleX,
    y: anchor.y + (point.y - pivot.y) * scaleY,
  };
  return rotatePointAbout(scaled, anchor, nodeRotationDeg(transform));
}

/** Frame point to local point: the exact inverse of {@link localToFramePoint}. */
export function frameToLocalPoint(
  transform: Transform2D,
  box: NodeRect,
  point: NodePoint,
): NodePoint {
  const { translateX, translateY, scaleX, scaleY } = transform;
  if (!isRotated(transform)) {
    return { x: (point.x - translateX) / scaleX, y: (point.y - translateY) / scaleY };
  }
  const pivot = nodePivot(transform, box);
  const anchor = { x: translateX + pivot.x * scaleX, y: translateY + pivot.y * scaleY };
  const unrotated = rotatePointAbout(point, anchor, -nodeRotationDeg(transform));
  return {
    x: pivot.x + (unrotated.x - anchor.x) / scaleX,
    y: pivot.y + (unrotated.y - anchor.y) / scaleY,
  };
}

/** The drawn rectangle of a node whose local box is `box`. */
export function nodeBoundsFromBox(id: string, transform: Transform2D, box: NodeRect): NodeBounds {
  const corners = [
    localToFramePoint(transform, box, { x: box.x, y: box.y }),
    localToFramePoint(transform, box, { x: box.x + box.width, y: box.y }),
    localToFramePoint(transform, box, { x: box.x + box.width, y: box.y + box.height }),
    localToFramePoint(transform, box, { x: box.x, y: box.y + box.height }),
  ] as const;
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    id,
    corners,
    center: localToFramePoint(transform, box, {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    }),
    width: box.width * transform.scaleX,
    height: box.height * transform.scaleY,
    rotationDeg: nodeRotationDeg(transform),
    origin: localToFramePoint(transform, box, nodePivot(transform, box)),
    aabb: { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY },
  };
}

/** True when a frame point lies inside the node's drawn (possibly rotated) box. */
export function nodeBoundsContain(
  transform: Transform2D,
  box: NodeRect,
  point: NodePoint,
): boolean {
  const local = frameToLocalPoint(transform, box, point);
  return (
    local.x >= box.x &&
    local.x <= box.x + box.width &&
    local.y >= box.y &&
    local.y <= box.y + box.height
  );
}
