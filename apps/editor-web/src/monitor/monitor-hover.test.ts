import { nodeBoundsFromBox, type NodeBounds, type Transform2D } from '@joy-media/render-ir';
import { describe, expect, it } from 'vitest';
import type { MonitorElement } from './monitor-selection.js';
import { monitorClickAction, monitorHitClipIds } from './monitor-selection.js';
import { monitorHoverElementAt, updateMonitorHoverCanvasPoint } from './monitor-hover.js';

function element(
  id: string,
  clipId: string,
  bounds: NodeBounds,
  flags: Pick<MonitorElement, 'locked' | 'hidden'> = {},
): MonitorElement {
  return { id, clipId, bounds, ...flags };
}

describe('Monitor hover geometry', () => {
  it('uses the same topmost hit priority as a plain click for scaled and rotated boxes', () => {
    const transform: Transform2D = {
      translateX: 80,
      translateY: 70,
      scaleX: 1.6,
      scaleY: 0.8,
      rotationDeg: 37,
    };
    const top = element(
      'caption',
      'clip-caption',
      nodeBoundsFromBox('caption', transform, { x: 0, y: 0, width: 90, height: 36 }),
    );
    const bottom = element(
      'video',
      'clip-video',
      nodeBoundsFromBox(
        'video',
        { translateX: 40, translateY: 40, scaleX: 1, scaleY: 1 },
        { x: 0, y: 0, width: 100, height: 100 },
      ),
    );
    const elements = [top, bottom];
    const point = top.bounds.center;
    const click = monitorClickAction(monitorHitClipIds(point, elements), [], {
      shift: false,
      alt: false,
    });
    if (click.kind !== 'select') throw new Error('plain click did not select its topmost hit');

    expect(monitorHoverElementAt(point, elements, [])).toBe(top);
    expect(click).toEqual({ kind: 'select', clipIds: ['clip-caption'] });
    expect(monitorHoverElementAt(point, elements, [])?.clipId).toBe(click.clipIds[0]);
  });

  it('does not return the element already selected at the pointer', () => {
    const target = element(
      'shape',
      'clip-shape',
      nodeBoundsFromBox(
        'shape',
        { translateX: 10, translateY: 20, scaleX: 1, scaleY: 1 },
        { x: 0, y: 0, width: 50, height: 30 },
      ),
    );

    expect(monitorHoverElementAt(target.bounds.center, [target], ['clip-shape'])).toBeUndefined();
  });

  it('maps a screen point through zoom and pan only while it lies inside the frame', () => {
    const point = { x: 0, y: 0 };
    const inside = updateMonitorHoverCanvasPoint(
      point,
      { zoom: 2, panX: 10, panY: 20 },
      { width: 100, height: 80 },
      30,
      40,
    );

    expect(inside).toBe(true);
    expect(point).toEqual({ x: 10, y: 10 });
    expect(
      updateMonitorHoverCanvasPoint(
        point,
        { zoom: 2, panX: 10, panY: 20 },
        { width: 100, height: 80 },
        9,
        40,
      ),
    ).toBe(false);
  });
});
