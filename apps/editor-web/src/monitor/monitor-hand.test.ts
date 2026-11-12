import { describe, expect, it } from 'vitest';
import {
  monitorScrollThumbs,
  monitorShowsNavigation,
  navigatorGeometry,
  panByDrag,
  panDeltaForThumbDrag,
  scrollThumb,
  viewCentredOnNavigatorPoint,
} from './monitor-hand.js';
import { MONITOR_PAN_KEEP_VISIBLE_PX } from './monitor-view-state.js';

const viewport = { width: 800, height: 450 };
const frame = { width: 1920, height: 1080 };

describe('panByDrag', () => {
  it('moves the view by the drag', () => {
    const start = { zoom: 1, panX: -500, panY: -300 };
    expect(panByDrag(start, 40, -20, viewport, frame)).toEqual({
      zoom: 1,
      panX: -460,
      panY: -320,
    });
  });

  it('keeps 64 px of the frame in view however far the drag goes', () => {
    const start = { zoom: 2, panX: 0, panY: 0 };
    const far = panByDrag(start, 100_000, 100_000, viewport, frame);
    expect(far.panX).toBe(viewport.width - MONITOR_PAN_KEEP_VISIBLE_PX);
    expect(far.panY).toBe(viewport.height - MONITOR_PAN_KEEP_VISIBLE_PX);
    const back = panByDrag(start, -100_000, -100_000, viewport, frame);
    expect(back.panX).toBe(MONITOR_PAN_KEEP_VISIBLE_PX - frame.width * 2);
    expect(back.panY).toBe(MONITOR_PAN_KEEP_VISIBLE_PX - frame.height * 2);
  });
});

describe('scrollbars and navigator visibility', () => {
  it('show only past 100 per cent', () => {
    expect(monitorShowsNavigation({ zoom: 1, panX: 0, panY: 0 })).toBe(false);
    expect(monitorShowsNavigation({ zoom: 0.4, panX: 0, panY: 0 })).toBe(false);
    expect(monitorShowsNavigation({ zoom: 1.5, panX: 0, panY: 0 })).toBe(true);
  });

  it('a thumb shows the visible part and is absent when the frame fits', () => {
    expect(scrollThumb(0, 800, 600)).toBeUndefined();
    expect(scrollThumb(-1000, 800, 3840)).toEqual({ start: 1000 / 3840, size: 800 / 3840 });
    const thumbs = monitorScrollThumbs({ zoom: 2, panX: -100, panY: -50 }, viewport, frame);
    expect(thumbs.horizontal?.size).toBeCloseTo(800 / 3840, 9);
    expect(thumbs.vertical?.start).toBeCloseTo(50 / 2160, 9);
  });

  it('dragging a thumb pans the opposite way, scaled to the content', () => {
    expect(panDeltaForThumbDrag(10, 800, 3840)).toBeCloseTo(-48, 9);
    expect(panDeltaForThumbDrag(10, 0, 3840)).toBe(0);
  });
});

describe('navigator', () => {
  it('draws the visible region as a frame inside the picture', () => {
    const view = { zoom: 2, panX: -960, panY: -540 };
    const geometry = navigatorGeometry(view, viewport, frame, 192);
    expect(geometry.width).toBeCloseTo(192, 9);
    expect(geometry.height).toBeCloseTo(108, 9);
    expect(geometry.visible.x).toBeCloseTo(48, 9);
    expect(geometry.visible.y).toBeCloseTo(27, 9);
    expect(geometry.visible.width).toBeCloseTo(40, 9);
    expect(geometry.visible.height).toBeCloseTo(22.5, 9);
  });

  it('moving the frame centres the view there, clamped', () => {
    const view = { zoom: 2, panX: 0, panY: 0 };
    const geometry = navigatorGeometry(view, viewport, frame, 192);
    const centred = viewCentredOnNavigatorPoint(
      view,
      viewport,
      frame,
      { x: 96, y: 54 },
      geometry.scale,
    );
    expect(centred.panX).toBeCloseTo(400 - 960 * 2, 9);
    expect(centred.panY).toBeCloseTo(225 - 540 * 2, 9);
    const corner = viewCentredOnNavigatorPoint(
      view,
      viewport,
      frame,
      { x: 10_000, y: 10_000 },
      geometry.scale,
    );
    expect(corner.panX).toBe(MONITOR_PAN_KEEP_VISIBLE_PX - frame.width * 2);
  });
});
