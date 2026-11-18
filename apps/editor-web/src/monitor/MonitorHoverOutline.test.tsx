// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeBoundsFromBox, type Transform2D } from '@joy-media/render-ir';
import { MonitorHoverOutline } from './MonitorHoverOutline.js';
import {
  MonitorViewport,
  monitorFrameRect,
  type MonitorViewController,
  type MonitorViewportSelection,
} from './MonitorViewport.js';
import { monitorHoverElementAt } from './monitor-hover.js';
import type { MonitorElement } from './monitor-selection.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FRAME = { width: 120, height: 90 };
const VIEWPORT = { width: 120, height: 90 };
const VIEW = { zoom: 1, panX: 0, panY: 0 };

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let frames: FrameRequestCallback[] = [];
let frameId = 0;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  frames = [];
  frameId = 0;
  vi.unstubAllGlobals();
});

function element(
  id = 'shape',
  transform: Transform2D = { translateX: 10, translateY: 12, scaleX: 1, scaleY: 1 },
): MonitorElement {
  return {
    id,
    clipId: `clip-${id}`,
    bounds: nodeBoundsFromBox(id, transform, { x: 0, y: 0, width: 24, height: 18 }),
  };
}

function controller(view = VIEW): MonitorViewController {
  return {
    view,
    fit: true,
    viewportSize: VIEWPORT,
    viewportRef: createRef<HTMLDivElement>(),
    setFit: vi.fn(),
    setZoom: vi.fn(),
    stepZoom: vi.fn(),
    setView: vi.fn(),
    tool: 'select',
    setTool: vi.fn(),
    frame: FRAME,
  };
}

function selectedElement(target: MonitorElement): MonitorViewportSelection {
  return {
    isElementAt: () => true,
    click: () => undefined,
    marquee: () => undefined,
    hover: (point) => monitorHoverElementAt(point, [target], []),
  };
}

function mountViewport(
  options: {
    readonly view?: typeof VIEW;
    readonly selection?: MonitorViewportSelection;
    readonly playing?: boolean;
  } = {},
) {
  frames = [];
  frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    frameId += 1;
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const target = element();
  const props = {
    controller: controller(options.view),
    dragOver: false,
    onDragOver: () => undefined,
    onDragLeave: () => undefined,
    onDrop: () => undefined,
    selection: options.selection ?? selectedElement(target),
    playing: options.playing ?? false,
  };
  act(() =>
    root!.render(
      <MonitorViewport {...props}>
        <div className="monitor-canvas" />
      </MonitorViewport>,
    ),
  );
  return {
    target,
    wrap: container.querySelector<HTMLElement>('.monitor-canvas-wrap')!,
    render(next: typeof props) {
      act(() =>
        root!.render(
          <MonitorViewport {...next}>
            <div className="monitor-canvas" />
          </MonitorViewport>,
        ),
      );
    },
  };
}

function flushFrame() {
  act(() => {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(1);
  });
}

function pointer(target: Element, type: string, x: number, y: number) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        relatedTarget: type === 'pointerout' ? document.body : null,
      }),
    );
  });
}

describe('Monitor hover outline', () => {
  it('draws the renderer corners for a scaled, rotated element', () => {
    const target = element('rotated', {
      translateX: 40,
      translateY: 25,
      scaleX: 1.5,
      scaleY: 0.75,
      rotationDeg: 32,
    });
    const points = target.bounds.corners.map((corner) => `${corner.x},${corner.y}`).join(' ');

    container = document.createElement('div');
    const rootForOutline = createRoot(container);
    act(() =>
      rootForOutline.render(
        <MonitorHoverOutline
          target={target}
          frame={FRAME}
          frameRect={monitorFrameRect(VIEW, FRAME)}
        />,
      ),
    );

    expect(
      container.querySelector('[data-monitor-hover="rotated"] polygon')?.getAttribute('points'),
    ).toBe(points);
    expect(container.querySelectorAll('[data-monitor-hover="rotated"] polygon')).toHaveLength(2);
    act(() => rootForOutline.unmount());
    container.remove();
    container = undefined;
  });

  it('shows nothing during a pointer interaction and restores hover after release', () => {
    const { wrap } = mountViewport();
    pointer(wrap, 'pointermove', 15, 18);
    flushFrame();
    expect(container?.querySelector('[data-monitor-hover]')).not.toBeNull();

    pointer(wrap, 'pointerdown', 15, 18);
    expect(container?.querySelector('[data-monitor-hover]')).toBeNull();
    pointer(wrap, 'pointermove', 18, 18);
    flushFrame();
    expect(container?.querySelector('[data-monitor-hover]')).toBeNull();
    pointer(wrap, 'pointerup', 18, 18);
    flushFrame();
    expect(container?.querySelector('[data-monitor-hover]')).not.toBeNull();
  });

  it('coalesces pointer moves into one animation-frame hit test', () => {
    const { wrap } = mountViewport();
    pointer(wrap, 'pointermove', 15, 18);
    pointer(wrap, 'pointermove', 16, 18);

    expect(frames).toHaveLength(1);
    flushFrame();
    expect(container?.querySelector('[data-monitor-hover="shape"]')).not.toBeNull();
  });

  it('clears hover after the pointer leaves and while playback is active', () => {
    const { wrap, render } = mountViewport();
    pointer(wrap, 'pointermove', 15, 18);
    flushFrame();
    expect(container?.querySelector('[data-monitor-hover]')).not.toBeNull();
    pointer(wrap, 'pointerout', 140, 100);
    expect(container?.querySelector('[data-monitor-hover]')).toBeNull();

    const playingProps = {
      controller: controller(),
      dragOver: false,
      onDragOver: () => undefined,
      onDragLeave: () => undefined,
      onDrop: () => undefined,
      selection: selectedElement(element()),
      playing: true,
    };
    render(playingProps);
    pointer(wrap, 'pointermove', 15, 18);
    flushFrame();
    expect(container?.querySelector('[data-monitor-hover]')).toBeNull();
  });

  it('recalculates the resting pointer when the view or drawn target changes', () => {
    const mounted = mountViewport();
    pointer(mounted.wrap, 'pointermove', 15, 18);
    flushFrame();
    expect(container?.querySelector('[data-monitor-hover]')).not.toBeNull();

    const movedViewProps = {
      controller: controller({ zoom: 1, panX: -40, panY: 0 }),
      dragOver: false,
      onDragOver: () => undefined,
      onDragLeave: () => undefined,
      onDrop: () => undefined,
      selection: selectedElement(mounted.target),
      playing: false,
    };
    mounted.render(movedViewProps);
    flushFrame();
    expect(container?.querySelector('[data-monitor-hover]')).toBeNull();

    mounted.render({
      ...movedViewProps,
      controller: controller(),
      selection: selectedElement(
        element('shape', { translateX: 8, translateY: 12, scaleX: 1, scaleY: 1 }),
      ),
    });
    flushFrame();
    const outline = container?.querySelector('[data-monitor-hover] polygon:last-child');
    expect(outline?.getAttribute('points')).toContain('8,12');
  });
});
