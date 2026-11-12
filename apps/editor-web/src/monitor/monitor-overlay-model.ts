import type { NodePoint } from '@joy-media/render-ir';
import {
  MONITOR_SCALE_HANDLES,
  handlePoint,
  rotateHandlePoint,
  type MonitorHandle,
} from './monitor-transform-maths.js';
import type { MonitorTransformTarget, TransformBlockReason } from './monitor-transform-targets.js';

/**
 * The editor-only model of the transform box (ADR-0046 section 5.1, T-M05a).
 * It is drawn above the canvas in HTML and SVG and never enters the frame,
 * the export or `readPixels`. Points are canvas (authored frame) pixels; the
 * box component turns them into screen pixels with `canvasToScreenPoint`.
 */

/** Screen distance between the top edge and the rotate handle, in CSS px. */
export const ROTATE_HANDLE_OFFSET_PX = 24;

export interface MonitorOverlayHandle {
  readonly id: MonitorHandle;
  /** Canvas point. */
  readonly point: NodePoint;
  /** Why the handle is greyed, when it is. */
  readonly blocked?: TransformBlockReason;
}

export interface MonitorOverlay {
  /** The drawn node id. */
  readonly elementId: string;
  readonly clipId: string;
  /**
   * 2x3 affine `[a, b, c, d, e, f]` from the element's box in fractions
   * (`u, v` in 0..1, local top-left at 0,0) to canvas pixels:
   * `x = a*u + c*v + e`, `y = b*u + d*v + f`. Built from the same corners the
   * renderer reports, so the box cannot drift from the picture.
   */
  readonly localToCanvas: readonly number[];
  readonly corners: readonly NodePoint[];
  /** Scale handles and the rotate handle; empty for a group (T-M05b). */
  readonly handles: readonly MonitorOverlayHandle[];
  /** The rotate handle's stem starts here (the middle of the top edge). */
  readonly topCenter: NodePoint;
}

function withBlocked(
  handle: MonitorHandle,
  point: NodePoint,
  blocked: TransformBlockReason | undefined,
): MonitorOverlayHandle {
  return blocked === undefined ? { id: handle, point } : { id: handle, point, blocked };
}

/**
 * The boxes for the selected targets. Handles are shown only when exactly one
 * element is selected: group scale and rotate are T-M05b. `zoom` keeps the
 * rotate handle a fixed screen distance from the box.
 */
export function buildMonitorOverlays(
  targets: readonly MonitorTransformTarget[],
  zoom: number,
): readonly MonitorOverlay[] {
  const single = targets.length === 1;
  const offset = ROTATE_HANDLE_OFFSET_PX / (zoom > 0 ? zoom : 1);
  return targets.map((target) => {
    const { geometry } = target;
    const [tl, tr, , bl] = geometry.corners;
    const handles: MonitorOverlayHandle[] = single
      ? [
          ...MONITOR_SCALE_HANDLES.map((handle) =>
            withBlocked(handle, handlePoint(geometry, handle), target.blocked.scale),
          ),
          withBlocked('rotate', rotateHandlePoint(geometry, offset), target.blocked.rotate),
        ]
      : [];
    return {
      elementId: target.nodeId,
      clipId: target.clipId,
      localToCanvas: [tr.x - tl.x, tr.y - tl.y, bl.x - tl.x, bl.y - tl.y, tl.x, tl.y],
      corners: geometry.corners,
      handles,
      topCenter: handlePoint(geometry, 'n'),
    };
  });
}

/** True when two overlay lists draw the same thing (avoids needless renders). */
export function sameMonitorOverlays(
  a: readonly MonitorOverlay[],
  b: readonly MonitorOverlay[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
