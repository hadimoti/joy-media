// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MonitorSnapOverlay, type MonitorSnapFeedback } from './MonitorSnapOverlay.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const VIEW = { zoom: 0.5, panX: 20, panY: 30 };
const VIEWPORT = { width: 300, height: 220 };
const FEEDBACK: MonitorSnapFeedback = {
  box: { x: 12, y: 34, width: 56, height: 78 },
  angle: 0,
  cursor: { x: 110, y: 120 },
  guides: [
    { axis: 'x', position: 100, kind: 'frame-centre' },
    { axis: 'y', position: 200, kind: 'user-guide' },
  ],
};

function render(feedback: MonitorSnapFeedback | null, viewportSize = VIEWPORT) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <MonitorSnapOverlay feedback={feedback} view={VIEW} viewportSize={viewportSize} />,
    ),
  );
  return container;
}

describe('Monitor snap overlay', () => {
  it('shows guide lines only when snapped and displays the project-coordinate readout', () => {
    const mounted = render(FEEDBACK);
    const xGuide = mounted.querySelector('[data-monitor-snap-guide="x"] line');
    const yGuide = mounted.querySelector('[data-monitor-snap-guide="y"] line');

    expect(xGuide?.getAttribute('x1')).toBe('70');
    expect(yGuide?.getAttribute('y1')).toBe('130');
    expect(mounted.querySelector('[data-monitor-snap-readout]')?.textContent).toBe(
      'X 12  Y 34  W 56  H 78  A 0°',
    );
  });

  it('keeps the readout during Ctrl bypass and flips it inside the viewport edges', () => {
    const mounted = render(
      { ...FEEDBACK, cursor: { x: 780, y: 430 }, guides: [] },
      {
        width: 400,
        height: 250,
      },
    );
    const readout = mounted.querySelector<HTMLElement>('[data-monitor-snap-readout]');

    expect(mounted.querySelectorAll('[data-monitor-snap-guide]')).toHaveLength(0);
    expect(readout?.textContent).toBe('X 12  Y 34  W 56  H 78  A 0°');
    expect(Number.parseFloat(readout?.style.left ?? 'NaN')).toBeLessThan(
      780 * VIEW.zoom + VIEW.panX,
    );
    expect(Number.parseFloat(readout?.style.top ?? 'NaN')).toBeLessThan(
      430 * VIEW.zoom + VIEW.panY,
    );
  });

  it('draws nothing when there is no active drag feedback', () => {
    const mounted = render(null);

    expect(mounted.querySelector('[data-monitor-snap-overlay]')).toBeNull();
  });
});
