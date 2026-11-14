import { describe, expect, it } from 'vitest';
import {
  clampFlowZoom,
  FLOW_ZOOM_DEFAULT,
  FLOW_ZOOM_MAX,
  FLOW_ZOOM_MIN,
  scrollKeepingPointer,
  zoomAfterWheel,
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

  it('keeps the drawing unit under the pointer in place', () => {
    // Pointer 200 px from the edge, scrolled 100 px: the unit under it is (100 + 200) / 0.5 = 600.
    const next = scrollKeepingPointer(100, 200, 0.5, 1);
    expect((next + 200) / 1).toBeCloseTo(600);
  });

  it('never scrolls below zero', () => {
    expect(scrollKeepingPointer(0, 50, 1, 0.25)).toBe(0);
  });
});
