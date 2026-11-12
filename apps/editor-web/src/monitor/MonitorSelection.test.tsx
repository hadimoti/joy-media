// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorOverlayIR } from '@joy-media/render-ir';
import {
  MonitorViewport,
  marqueeScreenRect,
  movedPastClickSlop,
  type MonitorViewController,
  type MonitorViewportSelection,
} from './MonitorViewport.js';
import { MonitorSelectionOverlay } from './MonitorSelectionOverlay.js';
import { monitorSpaceGesture, type MonitorTool } from './monitor-tools.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  act(() => monitorSpaceGesture.cancel());
});

function controller(tool: MonitorTool, setFit = vi.fn()): MonitorViewController {
  return {
    // Half size, no pan: a canvas point is twice the viewport point.
    view: { zoom: 0.5, panX: 0, panY: 0 },
    fit: true,
    viewportSize: { width: 540, height: 960 },
    viewportRef: createRef<HTMLDivElement>(),
    setFit,
    setZoom: vi.fn(),
    stepZoom: vi.fn(),
    setView: vi.fn(),
    tool,
    setTool: vi.fn(),
    frame: { width: 1080, height: 1920 },
  };
}

function selection(onElement: boolean) {
  return {
    isElementAt: vi.fn(() => onElement),
    click: vi.fn(),
    marquee: vi.fn(),
  } satisfies MonitorViewportSelection;
}

function mount(view: MonitorViewController, handler: MonitorViewportSelection): HTMLElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <MonitorViewport
        controller={view}
        dragOver={false}
        onDragOver={() => undefined}
        onDragLeave={() => undefined}
        onDrop={() => undefined}
        selection={handler}
      >
        <div className="monitor-canvas" />
      </MonitorViewport>,
    ),
  );
  return container.querySelector<HTMLElement>('.monitor-canvas-wrap')!;
}

function pointer(
  target: HTMLElement,
  type: string,
  x: number,
  y: number,
  init: MouseEventInit = {},
): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...init }),
    );
  });
}

describe('Monitor pointer routing for selection', () => {
  it('a click hands the canvas point and the modifiers to the selection', () => {
    const handler = selection(true);
    const wrap = mount(controller('select'), handler);
    pointer(wrap, 'pointerdown', 100, 50, { button: 0 });
    pointer(wrap, 'pointerup', 101, 51, { button: 0, shiftKey: true, altKey: true });
    expect(handler.click).toHaveBeenCalledWith({ x: 200, y: 100 }, { shift: true, alt: true });
    expect(handler.marquee).not.toHaveBeenCalled();
  });

  it('a drag that starts on empty canvas draws a marquee and selects with it', () => {
    const handler = selection(false);
    const wrap = mount(controller('select'), handler);
    pointer(wrap, 'pointerdown', 10, 10, { button: 0 });
    pointer(wrap, 'pointermove', 60, 40, { button: 0 });
    const box = wrap.querySelector<HTMLElement>('.monitor-marquee');
    expect(box).not.toBeNull();
    expect(box!.style.width).toBe('50px');
    pointer(wrap, 'pointerup', 60, 40, { button: 0 });
    expect(handler.marquee).toHaveBeenCalledWith(
      { x: 20, y: 20 },
      { x: 120, y: 80 },
      { shift: false },
    );
    expect(handler.click).not.toHaveBeenCalled();
    expect(wrap.querySelector('.monitor-marquee')).toBeNull();
  });

  it('a drag that starts on an element neither selects nor draws a marquee (moving is T-M05)', () => {
    const handler = selection(true);
    const wrap = mount(controller('select'), handler);
    pointer(wrap, 'pointerdown', 10, 10, { button: 0 });
    pointer(wrap, 'pointermove', 60, 40, { button: 0 });
    expect(wrap.querySelector('.monitor-marquee')).toBeNull();
    pointer(wrap, 'pointerup', 60, 40, { button: 0 });
    expect(handler.click).not.toHaveBeenCalled();
    expect(handler.marquee).not.toHaveBeenCalled();
  });

  it('the Hand pans and never selects', () => {
    const handler = selection(true);
    const view = controller('hand');
    const wrap = mount(view, handler);
    pointer(wrap, 'pointerdown', 10, 10, { button: 0 });
    pointer(wrap, 'pointermove', 60, 40, { button: 0 });
    pointer(wrap, 'pointerup', 60, 40, { button: 0 });
    expect(view.setView).toHaveBeenCalled();
    expect(handler.click).not.toHaveBeenCalled();
    expect(handler.marquee).not.toHaveBeenCalled();
  });

  it('a Space hold lends the Hand: it pans and never selects, nor deselects at the end', () => {
    const handler = selection(false);
    const view = controller('select');
    const wrap = mount(view, handler);
    act(() => {
      monitorSpaceGesture.press();
      monitorSpaceGesture.pointerDown();
    });
    pointer(wrap, 'pointerdown', 10, 10, { button: 0 });
    pointer(wrap, 'pointermove', 60, 40, { button: 0 });
    pointer(wrap, 'pointerup', 60, 40, { button: 0 });
    act(() => {
      monitorSpaceGesture.release();
    });
    expect(view.setView).toHaveBeenCalled();
    expect(handler.click).not.toHaveBeenCalled();
    expect(handler.marquee).not.toHaveBeenCalled();
  });

  it('the middle button pans and never selects', () => {
    const handler = selection(false);
    const view = controller('select');
    const wrap = mount(view, handler);
    pointer(wrap, 'pointerdown', 10, 10, { button: 1 });
    pointer(wrap, 'pointerup', 10, 10, { button: 1 });
    expect(handler.click).not.toHaveBeenCalled();
  });

  it('a cancelled press selects nothing', () => {
    const handler = selection(false);
    const wrap = mount(controller('select'), handler);
    pointer(wrap, 'pointerdown', 10, 10, { button: 0 });
    pointer(wrap, 'pointercancel', 10, 10, { button: 0 });
    pointer(wrap, 'pointerup', 10, 10, { button: 0 });
    expect(handler.click).not.toHaveBeenCalled();
  });

  it('a double-click on an element keeps its meaning; on the background it returns to Fit', () => {
    const setFit = vi.fn();
    const onElement = selection(true);
    const wrap = mount(controller('select', setFit), onElement);
    pointer(wrap, 'dblclick', 10, 10, { button: 0 });
    expect(setFit).not.toHaveBeenCalled();
    act(() => root?.unmount());
    container?.remove();
    const background = mount(controller('select', setFit), selection(false));
    pointer(background, 'dblclick', 10, 10, { button: 0 });
    expect(setFit).toHaveBeenCalledTimes(1);
  });

  it('click slop and the marquee rectangle', () => {
    expect(movedPastClickSlop(2, 2)).toBe(false);
    expect(movedPastClickSlop(3, 1)).toBe(true);
    expect(marqueeScreenRect({ x: 50, y: 10 }, { x: 10, y: 30 })).toEqual({
      left: '10px',
      top: '10px',
      width: '40px',
      height: '20px',
    });
  });
});

describe('MonitorSelectionOverlay (a timeline selection shows on the Monitor)', () => {
  const overlay: EditorOverlayIR = {
    version: 1,
    selections: [
      {
        nodeId: 'title',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        corners: [
          { x: 5, y: 0 },
          { x: 10, y: 5 },
          { x: 5, y: 10 },
          { x: 0, y: 5 },
        ],
      },
      { nodeId: 'clip-video', x: 20, y: 30, width: 40, height: 50 },
    ],
  };

  it('draws one thin outline per selected node, in frame pixels', () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        <MonitorSelectionOverlay
          overlay={overlay}
          frame={{ width: 1080, height: 1920 }}
          frameRect={{ left: '0px', top: '0px', width: '540px', height: '960px' }}
          clipIdOf={(nodeId) => (nodeId === 'title' ? 'clip-title' : nodeId)}
        />,
      ),
    );
    const svg = container.querySelector('svg.monitor-selection-overlay')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 1080 1920');
    const outlines = [...svg.querySelectorAll('polygon')];
    expect(outlines.map((outline) => outline.getAttribute('data-clip-id'))).toEqual([
      'clip-title',
      'clip-video',
    ]);
    expect(outlines[0]!.getAttribute('points')).toBe('5,0 10,5 5,10 0,5');
    expect(outlines[1]!.getAttribute('points')).toBe('20,30 60,30 60,80 20,80');
  });

  it('draws nothing when nothing is selected', () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        <MonitorSelectionOverlay
          overlay={{ version: 1, selections: [] }}
          frame={{ width: 1080, height: 1920 }}
          frameRect={{}}
        />,
      ),
    );
    expect(container.querySelector('svg')).toBeNull();
  });
});
