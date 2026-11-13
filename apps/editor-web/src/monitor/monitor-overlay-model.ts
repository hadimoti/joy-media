import type { NodePoint } from '@joy-media/render-ir';
import {
  MONITOR_SCALE_HANDLES,
  handlePoint,
  rotateHandlePoint,
  type MonitorHandle,
} from './monitor-transform-maths.js';
import {
  gestureBlockReason,
  type MonitorTransformTarget,
  type TransformBlockReason,
} from './monitor-transform-targets.js';
import { groupGeometry } from './monitor-transform-group.js';

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
  /**
   * Scale handles and the rotate handle. With several elements selected each
   * element's box has none: the group box carries them (T-M05b).
   */
  readonly handles: readonly MonitorOverlayHandle[];
  /** The rotate handle's stem starts here (the middle of the top edge). */
  readonly topCenter: NodePoint;
  /** The anchor point, drawn and dragged for one selected element (T-M05b). */
  readonly anchor?: MonitorOverlayAnchor;
  /** True for the box around a group of several elements (T-M05b). */
  readonly group?: true;
}

export interface MonitorOverlayAnchor {
  /** Canvas point. */
  readonly point: NodePoint;
  /** Why the anchor point cannot be moved, when it cannot. */
  readonly blocked?: TransformBlockReason;
}

/** The element id of the group box. */
export const MONITOR_GROUP_OVERLAY_ID = 'monitor-group';

function withBlocked(
  handle: MonitorHandle,
  point: NodePoint,
  blocked: TransformBlockReason | undefined,
): MonitorOverlayHandle {
  return blocked === undefined ? { id: handle, point } : { id: handle, point, blocked };
}

/**
 * The boxes for the selected targets. Handles and the anchor point are shown
 * only when exactly one element is selected; with several, the group box
 * (`buildMonitorGroupOverlay`) carries the handles. `zoom` keeps the rotate
 * handle a fixed screen distance from the box.
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
      ...(single
        ? {
            anchor:
              target.anchorBlocked === undefined
                ? { point: geometry.origin }
                : { point: geometry.origin, blocked: target.anchorBlocked },
          }
        : {}),
    };
  });
}

/**
 * The group box for several selected elements (T-M05b): the straight box
 * around all of them with eight scale handles and a rotate handle that scale
 * and turn the group as one. A handle is greyed when any element cannot take
 * the gesture. `undefined` for fewer than two elements.
 */
export function buildMonitorGroupOverlay(
  targets: readonly MonitorTransformTarget[],
  zoom: number,
): MonitorOverlay | undefined {
  if (targets.length < 2) return undefined;
  const geometry = groupGeometry(targets.map((target) => target.geometry));
  if (geometry === undefined) return undefined;
  const offset = ROTATE_HANDLE_OFFSET_PX / (zoom > 0 ? zoom : 1);
  const scaleBlocked = gestureBlockReason(targets, 'scale');
  const rotateBlocked =
    gestureBlockReason(targets, 'rotate') ?? gestureBlockReason(targets, 'move');
  const [tl, tr, , bl] = geometry.corners;
  return {
    elementId: MONITOR_GROUP_OVERLAY_ID,
    clipId: '',
    localToCanvas: [tr.x - tl.x, tr.y - tl.y, bl.x - tl.x, bl.y - tl.y, tl.x, tl.y],
    corners: geometry.corners,
    handles: [
      ...MONITOR_SCALE_HANDLES.map((handle) =>
        withBlocked(handle, handlePoint(geometry, handle), scaleBlocked),
      ),
      withBlocked('rotate', rotateHandlePoint(geometry, offset), rotateBlocked),
    ],
    topCenter: handlePoint(geometry, 'n'),
    group: true,
  };
}

/** True when two overlay lists draw the same thing (avoids needless renders). */
export function sameMonitorOverlays(
  a: readonly MonitorOverlay[],
  b: readonly MonitorOverlay[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
