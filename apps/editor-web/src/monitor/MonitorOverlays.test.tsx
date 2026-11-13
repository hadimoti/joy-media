// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonitorOverlays, type MonitorOverlaysProps } from './MonitorOverlays.js';
import { DEFAULT_MONITOR_VIEW_OPTIONS, type MonitorViewOptions } from './monitor-view-options.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const FRAME = { width: 1920, height: 1080 };
const VIEWPORT = { width: 1000, height: 600 };
const ALL_ON: MonitorViewOptions = {
  ...DEFAULT_MONITOR_VIEW_OPTIONS,
  titleSafe: true,
  actionSafe: true,
  grid: true,
  centreMarks: true,
  rulers: true,
  canvasBorder: true,
  pixelGrid: true,
  previewAspect: '9:16',
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function render(props: Partial<MonitorOverlaysProps> = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const onGuidesChange = vi.fn();
  act(() =>
    root?.render(
      <MonitorOverlays
        view={{ zoom: 1, panX: 0, panY: 0 }}
        frame={FRAME}
        viewportSize={VIEWPORT}
        options={ALL_ON}
        onGuidesChange={onGuidesChange}
        {...props}
      />,
    ),
  );
  return { onGuidesChange };
}

function overlayNames(): string[] {
  return Array.from(container?.querySelectorAll('[data-monitor-overlay]') ?? []).map(
    (node) => node.getAttribute('data-monitor-overlay') ?? '',
  );
}

/** A pointer event with the coordinates the overlay reads (jsdom has no PointerEvent). */
function pointer(type: string, target: Element, clientX: number, clientY: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 0,
  });
  act(() => {
    target.dispatchEvent(event);
  });
}

describe('Monitor overlays', () => {
  it('draws every overlay that is switched on, and nothing when all are off', () => {
    render();
    expect(overlayNames()).toEqual(
      expect.arrayContaining([
        'title-safe',
        'action-safe',
        'grid',
        'centre-marks',
        'canvas-border',
        'preview-aspect',
      ]),
    );
    expect(overlayNames()).not.toContain('pixel-grid');
    expect(container?.querySelector('[data-monitor-ruler="top"]')).not.toBeNull();

    act(() =>
      root?.render(
        <MonitorOverlays
          view={{ zoom: 1, panX: 0, panY: 0 }}
          frame={FRAME}
          viewportSize={VIEWPORT}
          options={DEFAULT_MONITOR_VIEW_OPTIONS}
          onGuidesChange={() => undefined}
        />,
      ),
    );
    expect(overlayNames()).toEqual([]);
    expect(container?.querySelector('[data-monitor-ruler]')).toBeNull();
  });

  it('shows the pixel grid only from 800 per cent zoom', () => {
    render({ view: { zoom: 4, panX: 0, panY: 0 } });
    expect(overlayNames()).not.toContain('pixel-grid');
    act(() =>
      root?.render(
        <MonitorOverlays
          view={{ zoom: 8, panX: -100, panY: -50 }}
          frame={FRAME}
          viewportSize={VIEWPORT}
          options={ALL_ON}
          onGuidesChange={() => undefined}
        />,
      ),
    );
    const grid = container?.querySelector<HTMLElement>('[data-monitor-overlay="pixel-grid"]');
    expect(grid).not.toBeNull();
    expect(grid?.style.backgroundSize).toBe('8px 8px');
    // The grid starts at the visible edge and stays aligned to the frame's pixels.
    expect(grid?.style.left).toBe('0px');
    expect(grid?.style.backgroundPosition).toBe('-100px -50px');
  });

  it('places the title safe rectangle at 10 per cent in from each side of the frame', () => {
    render({ options: { ...DEFAULT_MONITOR_VIEW_OPTIONS, titleSafe: true } });
    const rect = container?.querySelector('[data-monitor-overlay="title-safe"] rect');
    expect(rect?.getAttribute('x')).toBe('192');
    expect(rect?.getAttribute('y')).toBe('108');
    expect(rect?.getAttribute('width')).toBe('1536');
    expect(rect?.getAttribute('height')).toBe('864');
  });

  it('draws the Preview overlay as a shaded mask with a cut-out of the chosen aspect', () => {
    render({ options: { ...DEFAULT_MONITOR_VIEW_OPTIONS, previewAspect: '1:1' } });
    const path = container?.querySelector('.monitor-overlay-mask');
    expect(path?.getAttribute('fill-rule')).toBe('evenodd');
    expect(path?.getAttribute('d')).toContain('M420 0');
    expect(overlayNames()).toContain('preview-aspect');
  });

  it('draws a guide for each saved guide while rulers are on, and none while they are off', () => {
    const guides = [
      { axis: 'x' as const, position: 960 },
      { axis: 'y' as const, position: 540 },
    ];
    render({ options: { ...ALL_ON, guides } });
    const drawn = Array.from(container?.querySelectorAll('[data-monitor-guide]') ?? []).map(
      (node) => node.getAttribute('data-monitor-guide-position'),
    );
    expect(drawn).toEqual(['960', '540']);

    act(() =>
      root?.render(
        <MonitorOverlays
          view={{ zoom: 1, panX: 0, panY: 0 }}
          frame={FRAME}
          viewportSize={VIEWPORT}
          options={{ ...ALL_ON, rulers: false, guides }}
          onGuidesChange={() => undefined}
        />,
      ),
    );
    expect(container?.querySelectorAll('[data-monitor-guide]')).toHaveLength(0);
  });

  it('drags a new horizontal guide from the top ruler and commits it on release', () => {
    const { onGuidesChange } = render();
    const ruler = container?.querySelector('[data-monitor-ruler="top"]');
    const layer = container?.querySelector('[data-monitor-overlays]');
    expect(ruler).toBeTruthy();
    expect(layer).toBeTruthy();
    pointer('pointerdown', ruler!, 300, 120);
    pointer('pointermove', layer!, 300, 260);
    pointer('pointerup', layer!, 300, 260);
    expect(onGuidesChange).toHaveBeenCalledWith([{ axis: 'y', position: 260 }]);
  });

  it('removes a guide that is dragged off the frame', () => {
    const guides = [{ axis: 'x' as const, position: 960 }];
    const { onGuidesChange } = render({ options: { ...ALL_ON, guides } });
    const guide = container?.querySelector('[data-monitor-guide="x"]');
    const layer = container?.querySelector('[data-monitor-overlays]');
    pointer('pointerdown', guide!, 960, 10);
    pointer('pointermove', layer!, -40, 10);
    pointer('pointerup', layer!, -40, 10);
    expect(onGuidesChange).toHaveBeenCalledWith([]);
  });
});
