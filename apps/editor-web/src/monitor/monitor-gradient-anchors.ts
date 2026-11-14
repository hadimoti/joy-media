import type { NodePoint } from '@joy-media/render-ir';
import type { TextGradientPointV1 } from '@joy-media/project-schema';

/**
 * The gradient anchors of a text element, on the Monitor.
 *
 * An anchor is a point of the text box (0, 0 = top-left, 1, 1 = bottom-right). The overlay model gives the box
 * as a 2x3 affine `[a, b, c, d, e, f]` from fractions to canvas pixels (`x = a*u + c*v + e`, `y = b*u + d*v + f`),
 * so these two functions only move a point between the two spaces, however the text is scaled or turned.
 */

/** How far outside the text box an anchor may be dragged (the project validator allows -2 to 3). */
export const GRADIENT_ANCHOR_MIN = -1;
export const GRADIENT_ANCHOR_MAX = 2;

export function anchorToCanvas(
  localToCanvas: readonly number[],
  anchor: TextGradientPointV1,
): NodePoint {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = localToCanvas;
  return { x: a * anchor.x + c * anchor.y + e, y: b * anchor.x + d * anchor.y + f };
}

/** The inverse; `undefined` when the box has collapsed (a zero-size text). */
export function canvasToAnchor(
  localToCanvas: readonly number[],
  point: NodePoint,
): TextGradientPointV1 | undefined {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = localToCanvas;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) return undefined;
  const dx = point.x - e;
  const dy = point.y - f;
  const x = (d * dx - c * dy) / determinant;
  const y = (-b * dx + a * dy) / determinant;
  return { x: clampAnchorValue(x), y: clampAnchorValue(y) };
}

function clampAnchorValue(value: number): number {
  return Math.min(
    GRADIENT_ANCHOR_MAX,
    Math.max(GRADIENT_ANCHOR_MIN, Math.round(value * 1000) / 1000),
  );
}
