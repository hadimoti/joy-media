import {
  clampPan,
  screenToCanvasPoint,
  type MonitorPoint,
  type MonitorSize,
  type MonitorViewState,
} from './monitor-view-state.js';

/**
 * The Hand tool's maths (ADR-0046 section 3): panning by a drag, the thin
 * scrollbars and the navigator. Pure functions; the pan always goes through
 * `clampPan`, so at least 64 px of the frame stays in view.
 */

/** The view after a drag of (`dx`, `dy`) CSS px that started at `start`. */
export function panByDrag(
  start: MonitorViewState,
  dx: number,
  dy: number,
  viewport: MonitorSize,
  frame: MonitorSize,
): MonitorViewState {
  return clampPan(
    { zoom: start.zoom, panX: start.panX + dx, panY: start.panY + dy },
    viewport,
    frame,
  );
}

/** Scrollbars and the navigator show only when zoomed in past 100 per cent. */
export function monitorShowsNavigation(view: MonitorViewState): boolean {
  return view.zoom > 1 + 1e-9;
}

/** A scrollbar thumb as fractions (0..1) of its track. */
export interface ScrollThumb {
  readonly start: number;
  readonly size: number;
}

/**
 * The thumb for one axis: which part of the zoomed frame is in view. Undefined
 * when the whole frame fits on that axis (no bar needed).
 */
export function scrollThumb(
  pan: number,
  viewportLength: number,
  contentLength: number,
): ScrollThumb | undefined {
  if (viewportLength <= 0 || contentLength <= viewportLength + 0.5) return undefined;
  const visibleStart = Math.min(contentLength, Math.max(0, -pan));
  const visibleEnd = Math.min(contentLength, Math.max(0, viewportLength - pan));
  return {
    start: visibleStart / contentLength,
    size: Math.max(0, visibleEnd - visibleStart) / contentLength,
  };
}

/** Both scrollbar thumbs for a view. */
export function monitorScrollThumbs(
  view: MonitorViewState,
  viewport: MonitorSize,
  frame: MonitorSize,
): { readonly horizontal?: ScrollThumb; readonly vertical?: ScrollThumb } {
  const horizontal = scrollThumb(view.panX, viewport.width, frame.width * view.zoom);
  const vertical = scrollThumb(view.panY, viewport.height, frame.height * view.zoom);
  return {
    ...(horizontal === undefined ? {} : { horizontal }),
    ...(vertical === undefined ? {} : { vertical }),
  };
}

/** Pan change for a thumb dragged `thumbDelta` px along a track `trackLength` px long. */
export function panDeltaForThumbDrag(
  thumbDelta: number,
  trackLength: number,
  contentLength: number,
): number {
  if (trackLength <= 0) return 0;
  return (-thumbDelta * contentLength) / trackLength;
}

/** A rectangle in navigator pixels. */
export interface NavigatorRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NavigatorGeometry {
  /** Navigator picture size in CSS px. */
  readonly width: number;
  readonly height: number;
  /** Navigator px per authored frame px. */
  readonly scale: number;
  /** The visible region of the frame, in navigator px. */
  readonly visible: NavigatorRect;
}

/** Default longest side of the navigator picture, in CSS px. */
export const MONITOR_NAVIGATOR_SIZE = 140;

export function navigatorGeometry(
  view: MonitorViewState,
  viewport: MonitorSize,
  frame: MonitorSize,
  maxSide: number = MONITOR_NAVIGATOR_SIZE,
): NavigatorGeometry {
  const longest = Math.max(frame.width, frame.height, 1);
  const scale = maxSide / longest;
  const width = frame.width * scale;
  const height = frame.height * scale;
  const topLeft = screenToCanvasPoint(view, { x: 0, y: 0 });
  const bottomRight = screenToCanvasPoint(view, { x: viewport.width, y: viewport.height });
  const x0 = Math.min(frame.width, Math.max(0, topLeft.x));
  const y0 = Math.min(frame.height, Math.max(0, topLeft.y));
  const x1 = Math.min(frame.width, Math.max(0, bottomRight.x));
  const y1 = Math.min(frame.height, Math.max(0, bottomRight.y));
  return {
    width,
    height,
    scale,
    visible: {
      x: x0 * scale,
      y: y0 * scale,
      width: Math.max(0, x1 - x0) * scale,
      height: Math.max(0, y1 - y0) * scale,
    },
  };
}

/** The view that puts the frame point under `navigatorPoint` at the centre of the viewport. */
export function viewCentredOnNavigatorPoint(
  view: MonitorViewState,
  viewport: MonitorSize,
  frame: MonitorSize,
  navigatorPoint: MonitorPoint,
  scale: number,
): MonitorViewState {
  if (scale <= 0) return view;
  const canvasX = navigatorPoint.x / scale;
  const canvasY = navigatorPoint.y / scale;
  return clampPan(
    {
      zoom: view.zoom,
      panX: viewport.width / 2 - canvasX * view.zoom,
      panY: viewport.height / 2 - canvasY * view.zoom,
    },
    viewport,
    frame,
  );
}
