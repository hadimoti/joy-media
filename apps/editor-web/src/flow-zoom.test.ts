import { describe, expect, it } from 'vitest';
import {
  centeredOnPoint,
  centeredView,
  clampFlowZoom,
  defaultFlowZoom,
  FLOW_ZOOM_DEFAULT,
  FLOW_ZOOM_MAX,
  FLOW_ZOOM_MIN,
  visibleFractions,
  zoomAfterWheel,
  zoomAtPointer,
} from './flow-zoom.js';

describe('flow zoom', () => {
  it('starts two to three times smaller than the old fit-to-width size', () => {
    // The old graph filled a ~1500 px panel from a 900 unit drawing: about 1.7 px per unit.
    expect(1.7 / FLOW_ZOOM_DEFAULT).toBeGreaterThanOrEqual(2);
    expect(1.7 / FLOW_ZOOM_DEFAULT).toBeLessThanOrEqual(3);
  });

  it('wheel up zooms in, wheel down zooms out, within the limits', () => {
    expect(zoomAfterWheel(1, -100)).toBeGreaterThan(1);
    expect(zoomAfterWheel(1, 100)).toBeLessThan(1);
    expect(zoomAfterWheel(FLOW_ZOOM_MAX, -10_000)).toBe(FLOW_ZOOM_MAX);
    expect(zoomAfterWheel(FLOW_ZOOM_MIN, 10_000)).toBe(FLOW_ZOOM_MIN);
    expect(clampFlowZoom(99)).toBe(FLOW_ZOOM_MAX);
  });

  it('centres a graph that fits, both ways', () => {
    const view = centeredView({ x: 30, y: 35, width: 600, height: 200 }, 1000, 500, 0.5);
    // The graph spans 300 x 100 px: its middle sits at the canvas middle.
    expect(view.tx + (30 + 300) * 0.5).toBeCloseTo(500);
    expect(view.ty + (35 + 100) * 0.5).toBeCloseTo(250);
  });

  it('starts at the small default, or smaller so the whole graph shows', () => {
    const small = { x: 0, y: 0, width: 600, height: 100 };
    expect(defaultFlowZoom(small, 1500, 600)).toBe(FLOW_ZOOM_DEFAULT);
    const tall = { x: 0, y: 0, width: 600, height: 600 };
    // A 290 px canvas fits 600 units at (290 - 32) / 600 = 0.43.
    expect(defaultFlowZoom(tall, 1500, 290)).toBeCloseTo(0.43, 2);
    expect(defaultFlowZoom({ x: 0, y: 0, width: 9000, height: 9000 }, 100, 100)).toBe(
      FLOW_ZOOM_MIN,
    );
  });

  it('puts a graph taller than the canvas at the top, not cut off in the middle', () => {
    const view = centeredView({ x: 0, y: 0, width: 600, height: 2000 }, 1000, 500, 0.6);
    expect(view.ty).toBe(16);
  });

  it('keeps the drawing point under the pointer in place while zooming', () => {
    const view = { zoom: 0.5, tx: 40, ty: 20 };
    const pointer = { x: 300, y: 150 };
    const unitX = (pointer.x - view.tx) / view.zoom;
    const unitY = (pointer.y - view.ty) / view.zoom;
    const next = zoomAtPointer(view, pointer.x, pointer.y, 1.5);
    expect(next.zoom).toBe(1.5);
    expect(unitX * next.zoom + next.tx).toBeCloseTo(pointer.x);
    expect(unitY * next.zoom + next.ty).toBeCloseTo(pointer.y);
  });

  it('keeps the point under the pointer when the zoom hits the limit', () => {
    const view = { zoom: 2.9, tx: 0, ty: 0 };
    const next = zoomAtPointer(view, 100, 100, 50);
    expect(next.zoom).toBe(FLOW_ZOOM_MAX);
    expect((100 - view.tx) / view.zoom).toBeCloseTo((100 - next.tx) / next.zoom);
  });

  it('centres a node, and reports the visible part for the minimap', () => {
    const view = centeredOnPoint({ zoom: 1, tx: 0, ty: 0 }, 400, 300, 800, 600);
    expect(view.tx).toBe(0);
    expect(view.ty).toBe(0);
    const part = visibleFractions({ zoom: 1, tx: -100, ty: 0 }, 400, 300, 900, 600);
    expect(part.left).toBeCloseTo(100 / 900);
    expect(part.width).toBeCloseTo(400 / 900);
    expect(part.height).toBeCloseTo(0.5);
  });
});
