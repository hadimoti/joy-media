import { describe, expect, it } from 'vitest';
import {
  MONITOR_MAX_ZOOM,
  MONITOR_MIN_ZOOM,
  MONITOR_PAN_KEEP_VISIBLE_PX,
  canvasToScreenPoint,
  centredView,
  clampPan,
  clampZoom,
  fitView,
  fitZoom,
  formatZoomPercent,
  nextZoomStep,
  parseZoomPercent,
  screenToCanvasPoint,
  wheelZoomFactor,
  zoomAtPoint,
  zoomViewAt,
  type MonitorViewState,
} from './monitor-view-state.js';

const viewport = { width: 800, height: 450 };
const portrait = { width: 1080, height: 1920 };
const landscape = { width: 1920, height: 1080 };

describe('monitor view conversions', () => {
  it('screenToCanvasPoint is (point - pan) / zoom', () => {
    const view: MonitorViewState = { zoom: 2, panX: 10, panY: -30 };
    expect(screenToCanvasPoint(view, { x: 210, y: 170 })).toEqual({ x: 100, y: 100 });
  });

  it('the two conversions are exact inverses', () => {
    const views: MonitorViewState[] = [
      { zoom: 1, panX: 0, panY: 0 },
      { zoom: 0.1, panX: 37.5, panY: -12.25 },
      { zoom: 0.3333, panX: 400, panY: 225 },
      { zoom: 8, panX: -5000, panY: -1234.5 },
    ];
    const points = [
      { x: 0, y: 0 },
      { x: 539.5, y: 960.25 },
      { x: -20, y: 2000 },
    ];
    for (const view of views)
      for (const point of points) {
        const back = screenToCanvasPoint(view, canvasToScreenPoint(view, point));
        expect(back.x).toBeCloseTo(point.x, 9);
        expect(back.y).toBeCloseTo(point.y, 9);
        const screen = canvasToScreenPoint(view, screenToCanvasPoint(view, point));
        expect(screen.x).toBeCloseTo(point.x, 9);
        expect(screen.y).toBeCloseTo(point.y, 9);
      }
  });
});

describe('zoom toward the cursor', () => {
  it('keeps the point under the cursor within 1 px through a long wheel run', () => {
    let view = fitView(viewport, portrait);
    const cursor = { x: 513, y: 97 };
    const target = screenToCanvasPoint(view, cursor);
    const deltas = [-120, -120, -53, -300, -4, -120, 120, -120, -120, 60, -120, -120, -120];
    for (const deltaY of deltas) {
      view = zoomAtPoint(view, view.zoom * wheelZoomFactor(deltaY, 0, false), cursor);
      const onScreen = canvasToScreenPoint(view, target);
      expect(Math.abs(onScreen.x - cursor.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(onScreen.y - cursor.y)).toBeLessThanOrEqual(1);
    }
    expect(view.zoom).toBeGreaterThan(1);
  });

  it('keeps the point still for trackpad pinch (Ctrl + wheel)', () => {
    let view: MonitorViewState = { zoom: 1, panX: 40, panY: -200 };
    const cursor = { x: 300, y: 200 };
    const target = screenToCanvasPoint(view, cursor);
    for (let i = 0; i < 40; i += 1)
      view = zoomAtPoint(view, view.zoom * wheelZoomFactor(-3.5, 0, true), cursor);
    const onScreen = canvasToScreenPoint(view, target);
    expect(onScreen.x).toBeCloseTo(cursor.x, 6);
    expect(onScreen.y).toBeCloseTo(cursor.y, 6);
  });

  it('keeps the point still with the clamp when the frame stays well inside the limits', () => {
    const start = centredView(1, viewport, landscape);
    const cursor = { x: 400, y: 225 };
    const target = screenToCanvasPoint(start, cursor);
    const next = zoomViewAt(start, 4, cursor, viewport, landscape);
    const onScreen = canvasToScreenPoint(next, target);
    expect(Math.abs(onScreen.x - cursor.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(onScreen.y - cursor.y)).toBeLessThanOrEqual(1);
  });

  it('stops at 10 and 800 per cent', () => {
    const cursor = { x: 10, y: 10 };
    expect(zoomAtPoint({ zoom: 1, panX: 0, panY: 0 }, 100, cursor).zoom).toBe(MONITOR_MAX_ZOOM);
    expect(zoomAtPoint({ zoom: 1, panX: 0, panY: 0 }, 0.001, cursor).zoom).toBe(MONITOR_MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(0)).toBe(1);
  });
});

describe('wheel zoom factor', () => {
  it('zooms in for wheel up and out for wheel down', () => {
    expect(wheelZoomFactor(-100, 0, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelZoomFactor(0, 0, false)).toBe(1);
  });

  it('treats line and page modes as pixels and is symmetric', () => {
    expect(wheelZoomFactor(-3, 1, false)).toBeCloseTo(wheelZoomFactor(-48, 0, false), 12);
    expect(wheelZoomFactor(-1, 2, false, 200)).toBeCloseTo(wheelZoomFactor(-200, 0, false), 12);
    expect(wheelZoomFactor(-100, 0, false) * wheelZoomFactor(100, 0, false)).toBeCloseTo(1, 12);
  });

  it('gives a pinch (Ctrl) a stronger gain than a wheel', () => {
    expect(wheelZoomFactor(-10, 0, true)).toBeGreaterThan(wheelZoomFactor(-10, 0, false));
  });
});

describe('fit', () => {
  it('fits a portrait frame in a landscape viewport and centres it', () => {
    const zoom = fitZoom(viewport, portrait);
    expect(zoom).toBeCloseTo(450 / 1920, 12);
    const view = fitView(viewport, portrait);
    expect(view.panY).toBeCloseTo(0, 9);
    expect(view.panX).toBeCloseTo((800 - 1080 * zoom) / 2, 9);
  });

  it('can enlarge a small frame', () => {
    expect(fitZoom(viewport, { width: 160, height: 90 })).toBeCloseTo(5, 12);
  });

  it('is clamped to the zoom range and safe for an empty viewport', () => {
    expect(fitZoom({ width: 10, height: 10 }, { width: 8000, height: 8000 })).toBe(
      MONITOR_MIN_ZOOM,
    );
    expect(fitZoom({ width: 8000, height: 8000 }, { width: 10, height: 10 })).toBe(
      MONITOR_MAX_ZOOM,
    );
    expect(fitZoom({ width: 0, height: 0 }, portrait)).toBe(1);
  });
});

describe('pan clamp', () => {
  const visibleWidth = (view: MonitorViewState, frameWidth: number) =>
    Math.min(viewport.width, view.panX + frameWidth * view.zoom) - Math.max(0, view.panX);
  const visibleHeight = (view: MonitorViewState, frameHeight: number) =>
    Math.min(viewport.height, view.panY + frameHeight * view.zoom) - Math.max(0, view.panY);

  it('keeps at least 64 px of a large frame in view on each side', () => {
    for (const [panX, panY] of [
      [100_000, 100_000],
      [-100_000, -100_000],
      [100_000, -100_000],
      [-100_000, 100_000],
    ] as const) {
      const view = clampPan({ zoom: 2, panX, panY }, viewport, landscape);
      expect(visibleWidth(view, landscape.width)).toBeCloseTo(MONITOR_PAN_KEEP_VISIBLE_PX, 9);
      expect(visibleHeight(view, landscape.height)).toBeCloseTo(MONITOR_PAN_KEEP_VISIBLE_PX, 9);
    }
  });

  it('keeps all of a frame smaller than 64 px in view', () => {
    const frame = { width: 100, height: 100 };
    const view = clampPan({ zoom: 0.1, panX: -5000, panY: 5000 }, viewport, frame);
    expect(visibleWidth(view, 100)).toBeCloseTo(10, 9);
    expect(visibleHeight(view, 100)).toBeCloseTo(10, 9);
  });

  it('leaves a view that is already inside the limits untouched', () => {
    const view = { zoom: 1, panX: -100, panY: -50 };
    expect(clampPan(view, viewport, landscape)).toBe(view);
  });
});

describe('zoom control helpers', () => {
  it('walks the Ctrl+plus / Ctrl+minus ladder and stops at the ends', () => {
    expect(nextZoomStep(1, 1)).toBe(1.5);
    expect(nextZoomStep(1, -1)).toBeCloseTo(2 / 3, 12);
    expect(nextZoomStep(1.2, 1)).toBe(1.5);
    expect(nextZoomStep(1.2, -1)).toBe(1);
    expect(nextZoomStep(8, 1)).toBe(8);
    expect(nextZoomStep(0.1, -1)).toBe(0.1);
  });

  it('reads typed values and clamps them', () => {
    expect(parseZoomPercent('150')).toBe(1.5);
    expect(parseZoomPercent(' 75 % ')).toBe(0.75);
    expect(parseZoomPercent('12,5%')).toBe(0.125);
    expect(parseZoomPercent('5000')).toBe(MONITOR_MAX_ZOOM);
    expect(parseZoomPercent('1')).toBe(MONITOR_MIN_ZOOM);
    expect(parseZoomPercent('abc')).toBeUndefined();
    expect(parseZoomPercent('0')).toBeUndefined();
    expect(parseZoomPercent('')).toBeUndefined();
  });

  it('formats percentages', () => {
    expect(formatZoomPercent(1)).toBe('100%');
    expect(formatZoomPercent(0.234375)).toBe('23%');
    expect(formatZoomPercent(0.05)).toBe('5%');
    expect(formatZoomPercent(8)).toBe('800%');
  });
});
