import type { NodePoint } from '@joy-media/render-ir';
import type { MonitorSize, MonitorViewState } from './monitor-view-state.js';
import { hitTestTopElement } from './monitor-hit-test.js';
import type { MonitorElement } from './monitor-selection.js';

/** Mutable point scratch space used by the animation-frame hover check. */
export interface MonitorHoverCanvasPoint {
  x: number;
  y: number;
}

/** Map viewport CSS pixels to frame pixels without allocating a point per move. */
export function updateMonitorHoverCanvasPoint(
  out: MonitorHoverCanvasPoint,
  view: MonitorViewState,
  frame: MonitorSize,
  screenX: number,
  screenY: number,
): boolean {
  if (frame.width <= 0 || frame.height <= 0 || view.zoom <= 0) return false;
  const x = (screenX - view.panX) / view.zoom;
  const y = (screenY - view.panY) / view.zoom;
  if (x < 0 || y < 0 || x > frame.width || y > frame.height) return false;
  out.x = x;
  out.y = y;
  return true;
}

/** The topmost element a plain click would select, unless it is already selected. */
export function monitorHoverElementAt(
  canvasPoint: NodePoint,
  elements: readonly MonitorElement[],
  selectedClipIds: readonly string[],
): MonitorElement | undefined {
  const element = hitTestTopElement(canvasPoint, elements);
  if (element === undefined || selectedClipIds.includes(element.clipId)) return undefined;
  return element;
}
