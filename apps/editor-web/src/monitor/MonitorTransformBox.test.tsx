// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeBoundsFromBox, type Transform2D } from '@joy-media/render-ir';
import { scopedKeyTable } from '../keyboard-shortcuts.js';
import {
  MONITOR_KEY_SCOPE,
  MonitorViewport,
  type MonitorViewController,
  type MonitorViewportSelection,
} from './MonitorViewport.js';
import { MonitorTransformBox } from './MonitorTransformBox.js';
import { boxContainsPoint } from './monitor-hit-test.js';
import { buildMonitorOverlays } from './monitor-overlay-model.js';
import { boxGeometry, type LocalTransform } from './monitor-transform-maths.js';
import type { MonitorTransformHost, TransformPatches } from './monitor-transform-drag.js';
import {
  TRANSFORM_BLOCK_MESSAGES,
  type MonitorTransformTarget,
} from './monitor-transform-targets.js';
import { useMonitorTransform } from './useMonitorTransform.js';
import { monitorSpaceGesture } from './monitor-tools.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Half size, no pan: a canvas point is twice the viewport point.
const VIEW = { zoom: 0.5, panX: 0, panY: 0 };
const VIEWPORT = { width: 540, height: 960 };
const BOX = { x: 0, y: 0, width: 100, height: 100 };
const LOCAL: LocalTransform = { x: 100, y: 200, scaleX: 1, scaleY: 1, rotationDeg: 0 };

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let removeScope: (() => void) | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  removeScope?.();
  removeScope = undefined;
  act(() => monitorSpaceGesture.cancel());
});

/** The shape drawn at canvas (100, 200) to (200, 300): screen (50, 100) to (100, 150). */
function target(blocked: MonitorTransformTarget['blocked'] = {}): MonitorTransformTarget {
  const transform: Transform2D = { translateX: 100, translateY: 200, scaleX: 1, scaleY: 1 };
  return {
    nodeId: 'shape',
    clipId: 'clip-shape',
    objectId: 'shape',
    geometry: boxGeometry(nodeBoundsFromBox('shape', transform, BOX), transform),
    local: LOCAL,
    blocked,
  };
}

function viewController(): MonitorViewController {
  return {
    view: VIEW,
    fit: true,
    viewportSize: VIEWPORT,
    viewportRef: createRef<HTMLDivElement>(),
    setFit: vi.fn(),
    setZoom: vi.fn(),
    stepZoom: vi.fn(),
    setView: vi.fn(),
    tool: 'select',
    setTool: vi.fn(),
    frame: { width: 1080, height: 1920 },
  };
}

/** A fake editor session: each commit is one undo step. */
function recorder() {
  const steps: { label: string; patches: TransformPatches }[] = [];
  const host = {
    preview: vi.fn(),
    cancel: vi.fn(),
    commit: vi.fn((label: string, patches: TransformPatches) => steps.push({ label, patches })),
  } satisfies MonitorTransformHost;
  return { host, steps };
}

function Harness({
  targets,
  host,
  onBlocked,
}: {
  readonly targets: readonly MonitorTransformTarget[];
  readonly host: MonitorTransformHost;
  readonly onBlocked: (message: string) => void;
}) {
  const transform = useMonitorTransform({ readTargets: () => targets, host, onBlocked });
  const selection: MonitorViewportSelection = {
    isElementAt: (point) => targets.some((item) => boxContainsPoint(item.geometry.corners, point)),
    click: vi.fn(),
    marquee: vi.fn(),
    dragElement: (start) => transform.startGesture({ kind: 'move' }, start),
  };
  return (
    <MonitorViewport
      controller={viewController()}
      dragOver={false}
      onDragOver={() => undefined}
      onDragLeave={() => undefined}
      onDrop={() => undefined}
      selection={selection}
    >
      <div className="monitor-canvas" />
      <MonitorTransformBox
        overlays={buildMonitorOverlays(targets, VIEW.zoom)}
        view={VIEW}
        viewportSize={VIEWPORT}
        interactive
        startGesture={transform.startGesture}
      />
    </MonitorViewport>
  );
}

function mount(targets: readonly MonitorTransformTarget[]) {
  const session = recorder();
  const onBlocked = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<Harness targets={targets} host={session.host} onBlocked={onBlocked} />));
  return {
    ...session,
    onBlocked,
    wrap: container.querySelector<HTMLElement>('.monitor-canvas-wrap')!,
  };
}

function pointer(
  target: Element,
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

function handle(id: string): HTMLElement {
  const element = container!.querySelector<HTMLElement>(`[data-monitor-handle="${id}"]`);
  if (element === null) throw new Error(`no ${id} handle`);
  return element;
}

/** Drags a handle from its place by a screen offset; `init` holds the modifiers. */
function dragHandle(id: string, dx: number, dy: number, init: MouseEventInit = {}): void {
  const element = handle(id);
  const x = Number.parseFloat(element.style.left);
  const y = Number.parseFloat(element.style.top);
  pointer(element, 'pointerdown', x, y, init);
  pointer(element, 'pointermove', x + dx / 2, y + dy / 2, init);
  pointer(element, 'pointermove', x + dx, y + dy, init);
  pointer(element, 'pointerup', x + dx, y + dy, init);
}

function key(name: string, shift = false): boolean {
  let handled = false;
  act(() => {
    handled = scopedKeyTable.dispatch({
      key: name,
      shiftKey: shift,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      target: document.body,
    });
  });
  return handled;
}

describe('the transform box', () => {
  it('draws eight scale handles and a rotate handle, in screen pixels, above the canvas', () => {
    mount([target()]);
    const handles = [...container!.querySelectorAll<HTMLElement>('[data-monitor-handle]')];
    expect(handles.map((item) => item.dataset.monitorHandle)).toEqual([
      'nw',
      'n',
      'ne',
      'e',
      'se',
      's',
      'sw',
      'w',
      'rotate',
    ]);
    expect(handle('se').style.left).toBe('100px');
    expect(handle('se').style.top).toBe('150px');
    // 24 px above the top edge on screen, whatever the zoom.
    expect(handle('rotate').style.top).toBe('76px');
    expect(container!.querySelector('.monitor-transform-layer')).not.toBeNull();
    expect(container!.querySelector('canvas')).toBeNull();
  });

  it('a drag inside the box moves the element: live while dragging, one step on release', () => {
    const { host, steps, wrap } = mount([target()]);
    pointer(wrap, 'pointerdown', 75, 125);
    pointer(wrap, 'pointermove', 80, 128);
    pointer(wrap, 'pointermove', 85, 130);
    expect(host.preview).toHaveBeenCalledTimes(2);
    expect(steps).toHaveLength(0);
    pointer(wrap, 'pointerup', 85, 130);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.label).toBe('Move on the Monitor');
    expect(steps[0]!.patches.get('shape')).toEqual({ ...LOCAL, x: 120, y: 210 });
  });

  it('a corner with Shift scales in proportion from the opposite corner', () => {
    const { steps } = mount([target()]);
    dragHandle('se', 10, 0, { shiftKey: true });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.label).toBe('Scale on the Monitor');
    const next = steps[0]!.patches.get('shape')!;
    expect(next.scaleX).toBeCloseTo(1.1, 9);
    expect(next.scaleY).toBeCloseTo(1.1, 9);
    expect(next.x).toBeCloseTo(100, 9);
    expect(next.y).toBeCloseTo(200, 9);
  });

  it('an edge with Alt scales one axis about the centre', () => {
    const { steps } = mount([target()]);
    dragHandle('e', 10, 0, { altKey: true });
    const next = steps[0]!.patches.get('shape')!;
    expect(next.scaleX).toBeCloseTo(1.4, 9);
    expect(next.scaleY).toBe(1);
    expect(next.x).toBeCloseTo(80, 9);
    expect(next.y).toBe(200);
  });

  it('the rotate handle with Shift snaps to 15 degrees', () => {
    const { steps } = mount([target()]);
    // From straight above the centre (150, 250) to 37 degrees clockwise of it.
    const radians = ((-90 + 37) * Math.PI) / 180;
    const end = { x: (150 + 98 * Math.cos(radians)) / 2, y: (250 + 98 * Math.sin(radians)) / 2 };
    const element = handle('rotate');
    pointer(element, 'pointerdown', 75, 76, { shiftKey: true });
    pointer(element, 'pointermove', end.x, end.y, { shiftKey: true });
    pointer(element, 'pointerup', end.x, end.y, { shiftKey: true });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.label).toBe('Rotate on the Monitor');
    expect(steps[0]!.patches.get('shape')).toEqual({ ...LOCAL, rotationDeg: 30 });
  });

  it('arrow keys nudge 1 pixel and Shift 10, only while the Monitor has the pointer or focus', () => {
    const { steps } = mount([target()]);
    let active = true;
    removeScope = scopedKeyTable.setScope(MONITOR_KEY_SCOPE, () => active);
    expect(key('ArrowRight')).toBe(true);
    expect(key('ArrowDown', true)).toBe(true);
    expect(steps.map((step) => step.label)).toEqual([
      'Nudge on the Monitor',
      'Nudge on the Monitor',
    ]);
    expect(steps[0]!.patches.get('shape')).toEqual({ ...LOCAL, x: 101 });
    expect(steps[1]!.patches.get('shape')).toEqual({ ...LOCAL, y: 210 });
    active = false;
    // Outside the Monitor the global seek keys apply.
    expect(key('ArrowRight')).toBe(false);
    expect(steps).toHaveLength(2);
  });

  it('with nothing of the selection on the Monitor the arrows stay global', () => {
    mount([]);
    removeScope = scopedKeyTable.setScope(MONITOR_KEY_SCOPE, () => true);
    expect(key('ArrowLeft')).toBe(false);
  });

  it('Escape cancels a drag: the picture goes back and nothing is written', () => {
    const { host, steps } = mount([target()]);
    const element = handle('se');
    pointer(element, 'pointerdown', 100, 150);
    pointer(element, 'pointermove', 120, 170);
    expect(host.preview).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.cancel).toHaveBeenCalledTimes(1);
    pointer(element, 'pointerup', 120, 170);
    expect(steps).toHaveLength(0);
  });

  it('a handle whose value comes from an expression is greyed, explains why and does nothing', () => {
    const { host, steps } = mount([target({ scale: 'expression' })]);
    const corner = handle('se');
    expect(corner.classList.contains('blocked')).toBe(true);
    expect(corner.getAttribute('aria-disabled')).toBe('true');
    expect(corner.title).toBe(TRANSFORM_BLOCK_MESSAGES.expression);
    dragHandle('se', 20, 20);
    expect(host.preview).not.toHaveBeenCalled();
    expect(steps).toHaveLength(0);
    expect(handle('rotate').classList.contains('blocked')).toBe(false);
  });

  it('while an agent preview is on screen every handle is greyed and a drag is refused', () => {
    const blocked = {
      move: 'agent-preview',
      scale: 'agent-preview',
      rotate: 'agent-preview',
    } as const;
    const { steps, onBlocked, wrap } = mount([target(blocked)]);
    const handles = [...container!.querySelectorAll<HTMLElement>('[data-monitor-handle]')];
    expect(handles.every((item) => item.classList.contains('blocked'))).toBe(true);
    expect(handle('rotate').title).toBe(TRANSFORM_BLOCK_MESSAGES['agent-preview']);
    pointer(wrap, 'pointerdown', 75, 125);
    pointer(wrap, 'pointermove', 90, 140);
    pointer(wrap, 'pointerup', 90, 140);
    dragHandle('rotate', 30, 30);
    expect(steps).toHaveLength(0);
    expect(onBlocked).toHaveBeenCalledWith(TRANSFORM_BLOCK_MESSAGES['agent-preview']);
  });

  it('each drag is one step, however many moves it has', () => {
    const { host, steps } = mount([target()]);
    const element = handle('sw');
    pointer(element, 'pointerdown', 50, 150);
    for (let index = 1; index <= 12; index += 1)
      pointer(element, 'pointermove', 50 - index, 150 + index);
    pointer(element, 'pointerup', 38, 162);
    dragHandle('n', 0, -10);
    expect(host.preview.mock.calls.length).toBeGreaterThanOrEqual(14);
    expect(steps.map((step) => step.label)).toEqual([
      'Scale on the Monitor',
      'Scale on the Monitor',
    ]);
  });
});
