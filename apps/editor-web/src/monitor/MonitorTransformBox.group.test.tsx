// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeBoundsFromBox, type Transform2D } from '@joy-media/render-ir';
import {
  MonitorViewport,
  type MonitorViewController,
  type MonitorViewportSelection,
} from './MonitorViewport.js';
import { MonitorTransformBox } from './MonitorTransformBox.js';
import { boxContainsPoint } from './monitor-hit-test.js';
import {
  MONITOR_GROUP_OVERLAY_ID,
  buildMonitorGroupOverlay,
  buildMonitorOverlays,
} from './monitor-overlay-model.js';
import { boxGeometry, type LocalTransform } from './monitor-transform-maths.js';
import type { MonitorTransformHost, TransformPatches } from './monitor-transform-drag.js';
import {
  TRANSFORM_BLOCK_MESSAGES,
  type MonitorTransformTarget,
} from './monitor-transform-targets.js';
import { useMonitorTransform } from './useMonitorTransform.js';
import { monitorSpaceGesture } from './monitor-tools.js';

/** The group box and the anchor point on the Monitor (T-M05b). */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Half size, no pan: a canvas point is twice the viewport point.
const VIEW = { zoom: 0.5, panX: 0, panY: 0 };
const VIEWPORT = { width: 540, height: 960 };
const BOX = { x: 0, y: 0, width: 100, height: 100 };

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  act(() => monitorSpaceGesture.cancel());
});

function target(
  id: string,
  local: LocalTransform,
  extra: Partial<MonitorTransformTarget> = {},
): MonitorTransformTarget {
  const transform: Transform2D = {
    translateX: local.x,
    translateY: local.y,
    scaleX: local.scaleX,
    scaleY: local.scaleY,
    ...(local.rotationDeg === 0 ? {} : { rotationDeg: local.rotationDeg }),
  };
  return {
    nodeId: id,
    clipId: `clip-${id}`,
    objectId: id,
    geometry: boxGeometry(nodeBoundsFromBox(id, transform, BOX), transform),
    local,
    anchor: { x: 0.5, y: 0.5 },
    blocked: {},
    ...extra,
  };
}

/** Shape A at canvas (100, 200)-(200, 300), shape B at (300, 200)-(400, 300). */
const A: LocalTransform = { x: 100, y: 200, scaleX: 1, scaleY: 1, rotationDeg: 0 };
const B: LocalTransform = { x: 300, y: 200, scaleX: 1, scaleY: 1, rotationDeg: 0 };

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
        group={buildMonitorGroupOverlay(targets, VIEW.zoom)}
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
  return { ...session, onBlocked };
}

function pointer(element: Element, type: string, x: number, y: number, init: MouseEventInit = {}) {
  act(() => {
    element.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...init }),
    );
  });
}

function drag(element: HTMLElement, dx: number, dy: number, init: MouseEventInit = {}) {
  const x = Number.parseFloat(element.style.left);
  const y = Number.parseFloat(element.style.top);
  pointer(element, 'pointerdown', x, y, init);
  pointer(element, 'pointermove', x + dx / 2, y + dy / 2, init);
  pointer(element, 'pointermove', x + dx, y + dy, init);
  pointer(element, 'pointerup', x + dx, y + dy, init);
}

function groupHandle(id: string): HTMLElement {
  const element = container!.querySelector<HTMLElement>(
    `[data-monitor-handle="${id}"][data-node-id="${MONITOR_GROUP_OVERLAY_ID}"]`,
  );
  if (element === null) throw new Error(`no group ${id} handle`);
  return element;
}

function anchorOf(nodeId: string): HTMLElement {
  const element = container!.querySelector<HTMLElement>(`[data-monitor-anchor="${nodeId}"]`);
  if (element === null) throw new Error(`no anchor on ${nodeId}`);
  return element;
}

describe('the group box (several elements selected)', () => {
  it('draws one box around the group with 8 scale handles and a rotate handle', () => {
    mount([target('a', A), target('b', B)]);
    const handles = [...container!.querySelectorAll<HTMLElement>('[data-monitor-handle]')];
    expect(handles.every((item) => item.dataset.nodeId === MONITOR_GROUP_OVERLAY_ID)).toBe(true);
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
    // The group spans canvas (100, 200)-(400, 300): screen (50, 100)-(200, 150).
    expect(groupHandle('se').style.left).toBe('200px');
    expect(groupHandle('se').style.top).toBe('150px');
    expect(container!.querySelector('.monitor-transform-outline.group')).not.toBeNull();
    expect(container!.querySelector('[data-monitor-anchor]')).toBeNull();
  });

  it('a group corner scales every element about the opposite corner: one step', () => {
    const { steps, host } = mount([target('a', A), target('b', B)]);
    // Drag the bottom-right corner 150 screen px right: the group goes from 300 to 600 wide.
    drag(groupHandle('se'), 150, 50);
    expect(host.preview).toHaveBeenCalled();
    expect(steps).toHaveLength(1);
    expect(steps[0]!.label).toBe('Scale on the Monitor');
    expect(steps[0]!.patches.get('a')).toEqual({ ...A, scaleX: 2, scaleY: 2 });
    expect(steps[0]!.patches.get('b')).toEqual({
      x: 500,
      y: 200,
      scaleX: 2,
      scaleY: 2,
      rotationDeg: 0,
    });
  });

  it('the group rotate handle turns every element about the group centre: one step', () => {
    const { steps } = mount([target('a', A), target('b', B)]);
    // From above the group centre (250, 250) a quarter turn clockwise, Shift snapping.
    const rotate = groupHandle('rotate');
    const x = Number.parseFloat(rotate.style.left);
    const y = Number.parseFloat(rotate.style.top);
    const centre = { x: 125, y: 125 };
    pointer(rotate, 'pointerdown', x, y, { shiftKey: true });
    pointer(rotate, 'pointermove', centre.x + (centre.y - y), centre.y + 3, { shiftKey: true });
    pointer(rotate, 'pointerup', centre.x + (centre.y - y), centre.y + 3, { shiftKey: true });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.label).toBe('Rotate on the Monitor');
    const a = steps[0]!.patches.get('a')!;
    const b = steps[0]!.patches.get('b')!;
    expect(a.rotationDeg).toBe(90);
    expect(b.rotationDeg).toBe(90);
    // A's centre (150, 250) goes round (250, 250) to (250, 150); the anchor (centre) is what moves.
    expect(a.x).toBeCloseTo(200, 6);
    expect(a.y).toBeCloseTo(100, 6);
    expect(b.x).toBeCloseTo(200, 6);
    expect(b.y).toBeCloseTo(300, 6);
  });

  it('a group handle greyed by one element explains why and does nothing', () => {
    const { steps, host } = mount([
      target('a', A, { blocked: { scale: 'expression' } }),
      target('b', B),
    ]);
    const corner = groupHandle('se');
    expect(corner.classList.contains('blocked')).toBe(true);
    expect(corner.title).toBe(TRANSFORM_BLOCK_MESSAGES.expression);
    drag(corner, 40, 40);
    expect(host.preview).not.toHaveBeenCalled();
    expect(steps).toHaveLength(0);
    expect(groupHandle('rotate').classList.contains('blocked')).toBe(false);
  });
});

describe('the anchor point (one element selected)', () => {
  it('is drawn at the element centre and dragged to a corner in one step', () => {
    const { steps } = mount([target('a', A)]);
    const anchor = anchorOf('a');
    // The centre (150, 250) is screen (75, 125).
    expect(anchor.style.left).toBe('75px');
    expect(anchor.style.top).toBe('125px');
    expect(anchor.dataset.monitorHandle).toBeUndefined();
    drag(anchor, -25, -25);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.label).toBe('Move the anchor point on the Monitor');
    expect(steps[0]!.patches.get('a')).toEqual({ ...A, anchorX: 0, anchorY: 0 });
  });

  it('a blocked anchor is greyed with its reason and does not move', () => {
    const { steps, host } = mount([target('a', A, { anchorBlocked: 'animated' })]);
    const anchor = anchorOf('a');
    expect(anchor.classList.contains('blocked')).toBe(true);
    expect(anchor.title).toBe(TRANSFORM_BLOCK_MESSAGES.animated);
    drag(anchor, 10, 10);
    expect(host.preview).not.toHaveBeenCalled();
    expect(steps).toHaveLength(0);
  });

  it('Escape during an anchor drag puts it back and writes nothing', () => {
    const { steps, host } = mount([target('a', A)]);
    const anchor = anchorOf('a');
    pointer(anchor, 'pointerdown', 75, 125);
    pointer(anchor, 'pointermove', 60, 110);
    expect(host.preview).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.cancel).toHaveBeenCalledTimes(1);
    pointer(anchor, 'pointerup', 60, 110);
    expect(steps).toHaveLength(0);
  });
});
