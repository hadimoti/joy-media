/**
 * The Monitor's view transform (ADR-0046 section 1): zoom and pan of the
 * viewport. It belongs to the screen, not to the project: it is never saved
 * in the document, never sent to the command log and never undone.
 *
 * Coordinates:
 * - "screen" points are CSS pixels measured from the top-left corner of the
 *   Monitor viewport (the canvas wrap). A caller holding a DOM `clientX` /
 *   `clientY` subtracts the viewport's `getBoundingClientRect()` first.
 * - "canvas" points are authored frame pixels, the same space as the IR
 *   viewport and `VisualObjectTransformV1.x/y`.
 *
 * `screenToCanvasPoint` and `canvasToScreenPoint` are the only conversion
 * pair; every other Monitor module must call them.
 */

export interface MonitorViewState {
  /** 0.1 .. 8, 1 = 100 % (one authored pixel is one CSS pixel). */
  readonly zoom: number;
  /** CSS px, offset of the canvas origin inside the viewport. */
  readonly panX: number;
  readonly panY: number;
}

export interface MonitorPoint {
  readonly x: number;
  readonly y: number;
}

export interface MonitorSize {
  readonly width: number;
  readonly height: number;
}

/** 10 per cent. */
export const MONITOR_MIN_ZOOM = 0.1;
/** 800 per cent. */
export const MONITOR_MAX_ZOOM = 8;
/** At least this many CSS px of the frame stay inside the viewport. */
export const MONITOR_PAN_KEEP_VISIBLE_PX = 64;

/** The fixed zoom values the zoom control offers next to Fit. */
export const MONITOR_ZOOM_PRESETS = [0.5, 1, 2] as const;

/** The ladder Ctrl+plus and Ctrl+minus walk along. */
export const MONITOR_ZOOM_STEPS = [
  0.1,
  0.125,
  0.25,
  1 / 3,
  0.5,
  2 / 3,
  1,
  1.5,
  2,
  3,
  4,
  6,
  8,
] as const;

export const MONITOR_IDENTITY_VIEW: MonitorViewState = { zoom: 1, panX: 0, panY: 0 };

/** Keeps a zoom value inside 10 .. 800 per cent. Non-finite values become 100 per cent. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(MONITOR_MAX_ZOOM, Math.max(MONITOR_MIN_ZOOM, zoom));
}

/** Screen point (viewport CSS px) -> canvas point in authored pixels. */
export function screenToCanvasPoint(view: MonitorViewState, point: MonitorPoint): MonitorPoint {
  return { x: (point.x - view.panX) / view.zoom, y: (point.y - view.panY) / view.zoom };
}

/** Canvas point in authored pixels -> screen point (viewport CSS px). */
export function canvasToScreenPoint(view: MonitorViewState, point: MonitorPoint): MonitorPoint {
  return { x: point.x * view.zoom + view.panX, y: point.y * view.zoom + view.panY };
}

/** The zoom at which the whole frame fits the viewport, clamped to the zoom range. */
/** Fit keeps this many CSS px of space around the frame on every side (T-D12). */
export const MONITOR_FIT_PADDING_PX = 16;

export function fitZoom(viewport: MonitorSize, frame: MonitorSize): number {
  if (viewport.width <= 0 || viewport.height <= 0 || frame.width <= 0 || frame.height <= 0)
    return 1;
  const width = Math.max(1, viewport.width - 2 * MONITOR_FIT_PADDING_PX);
  const height = Math.max(1, viewport.height - 2 * MONITOR_FIT_PADDING_PX);
  return clampZoom(Math.min(width / frame.width, height / frame.height));
}

/** Fit: the fit zoom with the frame centred in the viewport. */
export function fitView(viewport: MonitorSize, frame: MonitorSize): MonitorViewState {
  const zoom = fitZoom(viewport, frame);
  return centredView(zoom, viewport, frame);
}

/** A view at `zoom` with the frame centred in the viewport. */
export function centredView(
  zoom: number,
  viewport: MonitorSize,
  frame: MonitorSize,
): MonitorViewState {
  const z = clampZoom(zoom);
  return {
    zoom: z,
    panX: (viewport.width - frame.width * z) / 2,
    panY: (viewport.height - frame.height * z) / 2,
  };
}

function clampAxis(pan: number, viewportLength: number, frameLength: number): number {
  const keep = Math.min(MONITOR_PAN_KEEP_VISIBLE_PX, frameLength, viewportLength);
  const min = keep - frameLength;
  const max = viewportLength - keep;
  return Math.min(max, Math.max(min, pan));
}

/**
 * Limits the pan so the frame cannot be lost: at least 64 CSS px of it (or the
 * whole frame, when it is smaller) stays inside the viewport on each axis.
 */
export function clampPan(
  view: MonitorViewState,
  viewport: MonitorSize,
  frame: MonitorSize,
): MonitorViewState {
  if (viewport.width <= 0 || viewport.height <= 0) return view;
  const panX = clampAxis(view.panX, viewport.width, frame.width * view.zoom);
  const panY = clampAxis(view.panY, viewport.height, frame.height * view.zoom);
  return panX === view.panX && panY === view.panY ? view : { zoom: view.zoom, panX, panY };
}

/**
 * Changes the zoom while the canvas point under `anchor` (a screen point)
 * stays under it. The pan is not clamped here.
 */
export function zoomAtPoint(
  view: MonitorViewState,
  nextZoom: number,
  anchor: MonitorPoint,
): MonitorViewState {
  const zoom = clampZoom(nextZoom);
  const canvasPoint = screenToCanvasPoint(view, anchor);
  return { zoom, panX: anchor.x - canvasPoint.x * zoom, panY: anchor.y - canvasPoint.y * zoom };
}

/** {@link zoomAtPoint} followed by {@link clampPan}. */
export function zoomViewAt(
  view: MonitorViewState,
  nextZoom: number,
  anchor: MonitorPoint,
  viewport: MonitorSize,
  frame: MonitorSize,
): MonitorViewState {
  return clampPan(zoomAtPoint(view, nextZoom, anchor), viewport, frame);
}

/** DOM `WheelEvent.deltaMode` values. */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/**
 * Zoom multiplier for one wheel event. A mouse wheel notch (about 100 px) is
 * about 16 per cent; a trackpad pinch arrives as a wheel event with Ctrl and
 * small deltas, so it gets a stronger gain.
 */
export function wheelZoomFactor(
  deltaY: number,
  deltaMode: number,
  ctrlKey: boolean,
  pageHeight = 800,
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const pixels =
    deltaMode === DOM_DELTA_LINE
      ? deltaY * 16
      : deltaMode === DOM_DELTA_PAGE
        ? deltaY * pageHeight
        : deltaY;
  const gain = ctrlKey ? 0.01 : 0.0015;
  const limited = Math.max(-300, Math.min(300, pixels));
  return Math.exp(-limited * gain);
}

/** The next value on the Ctrl+plus / Ctrl+minus ladder. */
export function nextZoomStep(zoom: number, direction: 1 | -1): number {
  const epsilon = 1e-6;
  if (direction === 1) {
    for (const step of MONITOR_ZOOM_STEPS) if (step > zoom + epsilon) return step;
    return MONITOR_MAX_ZOOM;
  }
  for (let i = MONITOR_ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    const step = MONITOR_ZOOM_STEPS[i]!;
    if (step < zoom - epsilon) return step;
  }
  return MONITOR_MIN_ZOOM;
}

/** Reads a typed zoom such as "150", "150%" or "150 %". Returns a clamped zoom, or undefined. */
export function parseZoomPercent(text: string): number | undefined {
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*%?\s*$/.exec(text);
  if (match === null) return undefined;
  const percent = Number(match[1]!.replace(',', '.'));
  if (!Number.isFinite(percent) || percent <= 0) return undefined;
  return clampZoom(percent / 100);
}

/** "150%" for 1.5. Whole numbers above 10 per cent, one decimal below. */
export function formatZoomPercent(zoom: number): string {
  const percent = zoom * 100;
  const rounded = percent >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10;
  return `${rounded}%`;
}
