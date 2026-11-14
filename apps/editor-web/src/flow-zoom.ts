/** Zoom for the Flow graph: CSS pixels per drawing unit. The wheel changes this, not the scroll. */
export const FLOW_ZOOM_DEFAULT = 0.6;
export const FLOW_ZOOM_MIN = 0.2;
export const FLOW_ZOOM_MAX = 3;

export function clampFlowZoom(zoom: number): number {
  return Math.min(FLOW_ZOOM_MAX, Math.max(FLOW_ZOOM_MIN, zoom));
}

/** One wheel notch (deltaY about 100) changes the zoom by about 16 percent; up zooms in. */
export function zoomAfterWheel(zoom: number, deltaY: number): number {
  return clampFlowZoom(zoom * Math.exp(-deltaY * 0.0015));
}

/**
 * The scroll position that keeps the drawing unit under the pointer where it is while the zoom
 * changes. `pointerPx` is the pointer's distance from the canvas edge, `scrollPx` the current
 * scroll offset along the same axis.
 */
export function scrollKeepingPointer(
  scrollPx: number,
  pointerPx: number,
  oldZoom: number,
  newZoom: number,
): number {
  const unit = (scrollPx + pointerPx) / oldZoom;
  return Math.max(0, unit * newZoom - pointerPx);
}
