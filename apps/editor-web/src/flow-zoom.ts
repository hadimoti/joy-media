/**
 * View maths for the Flow graph. The view is a zoom (CSS pixels per drawing unit) plus a
 * translation (CSS pixels from the canvas corner to the drawing origin). The wheel zooms around the
 * pointer, and a drag pans: nothing scrolls.
 */
export const FLOW_ZOOM_DEFAULT = 0.6;
export const FLOW_ZOOM_MIN = 0.2;
export const FLOW_ZOOM_MAX = 3;
/** Space kept above a graph that is taller than the canvas, in CSS pixels. */
const TOP_MARGIN_PX = 16;

export interface FlowView {
  readonly zoom: number;
  readonly tx: number;
  readonly ty: number;
}

export interface FlowBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function clampFlowZoom(zoom: number): number {
  return Math.min(FLOW_ZOOM_MAX, Math.max(FLOW_ZOOM_MIN, zoom));
}

/** One wheel notch (deltaY about 100) changes the zoom by about 16 percent; up zooms in. */
export function zoomAfterWheel(zoom: number, deltaY: number): number {
  return clampFlowZoom(zoom * Math.exp(-deltaY * 0.0015));
}

/**
 * The zoom the chart first appears at: the small default, or smaller when the whole graph would
 * not fit the canvas (it never goes below the minimum, and never above the default).
 */
export function defaultFlowZoom(box: FlowBox, canvasWidth: number, canvasHeight: number): number {
  const fit = Math.min(
    (canvasWidth - 2 * TOP_MARGIN_PX) / Math.max(1, box.width),
    (canvasHeight - 2 * TOP_MARGIN_PX) / Math.max(1, box.height),
  );
  return clampFlowZoom(Math.min(FLOW_ZOOM_DEFAULT, fit));
}

/** The graph centred in the canvas at this zoom (a tall graph sits at the top instead). */
export function centeredView(
  box: FlowBox,
  canvasWidth: number,
  canvasHeight: number,
  zoom: number,
): FlowView {
  const tx = (canvasWidth - box.width * zoom) / 2 - box.x * zoom;
  const fitsHeight = box.height * zoom <= canvasHeight - 2 * TOP_MARGIN_PX;
  const ty = fitsHeight
    ? (canvasHeight - box.height * zoom) / 2 - box.y * zoom
    : TOP_MARGIN_PX - box.y * zoom;
  return { zoom, tx, ty };
}

/**
 * Zoom to `newZoom` so the drawing point under the pointer stays under the pointer.
 * `pointerX` and `pointerY` are CSS pixels from the canvas corner.
 */
export function zoomAtPointer(
  view: FlowView,
  pointerX: number,
  pointerY: number,
  newZoom: number,
): FlowView {
  const zoom = clampFlowZoom(newZoom);
  const ratio = zoom / view.zoom;
  return {
    zoom,
    tx: pointerX - (pointerX - view.tx) * ratio,
    ty: pointerY - (pointerY - view.ty) * ratio,
  };
}

/** Move the view so the drawing point (x, y) is in the middle of the canvas. */
export function centeredOnPoint(
  view: FlowView,
  x: number,
  y: number,
  canvasWidth: number,
  canvasHeight: number,
): FlowView {
  return {
    zoom: view.zoom,
    tx: canvasWidth / 2 - x * view.zoom,
    ty: canvasHeight / 2 - y * view.zoom,
  };
}

/** What part of a drawing of (width x height) units the canvas shows, as 0 to 1 fractions. */
export function visibleFractions(
  view: FlowView,
  canvasWidth: number,
  canvasHeight: number,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const drawnWidth = Math.max(1, width * view.zoom);
  const drawnHeight = Math.max(1, height * view.zoom);
  return {
    left: -view.tx / drawnWidth,
    top: -view.ty / drawnHeight,
    width: canvasWidth / drawnWidth,
    height: canvasHeight / drawnHeight,
  };
}
