// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowProjection } from './DualLensPanel.js';
import type { DualLensEdge, DualLensNode } from './dual-lens-model.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const nodes: DualLensNode[] = [
  { id: 'a', kind: 'asset', label: 'Alpha', detail: 'video', column: 0, clipIds: [] },
  { id: 'c', kind: 'clip', label: 'Clip', detail: 'Video 1', column: 1, clipIds: ['c'] },
  { id: 'o', kind: 'output', label: 'Out', detail: '1920x1080', column: 2, clipIds: [] },
];
const edges: DualLensEdge[] = [
  { id: 'a-c', from: 'a', to: 'c' },
  { id: 'c-o', from: 'c', to: 'o' },
];

describe('FlowProjection view', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    // jsdom has no layout: give the canvas a size, and a ResizeObserver that never fires.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mount() {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <FlowProjection
          nodes={nodes}
          edges={edges}
          traceNodeIds={new Set()}
          traceEdgeIds={new Set()}
          selectedNodeIds={new Set()}
          focusedNodeId={undefined}
          focusedClipIds={[]}
          onSelectNode={() => undefined}
          onSeek={() => undefined}
          onRevealOnTimeline={() => undefined}
        />,
      );
    });
    return container;
  }

  it('mounts without an update loop (React error 185) and centres the graph at the small default', () => {
    const view = mount();
    const group = view.querySelector('.dual-flow-canvas svg > g');
    expect(group).not.toBeNull();
    const transform = group!.getAttribute('transform') ?? '';
    expect(transform).toContain('scale(0.6)');
    const match = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(transform);
    expect(match).not.toBeNull();
    // Nodes span x 30..(30 + 2 * 230 + 150): centred means equal space left and right.
    const left = Number(match![1]) + 30 * 0.6;
    const right = 1200 - (Number(match![1]) + (30 + 2 * 230 + 150) * 0.6);
    expect(left).toBeCloseTo(right, 0);
  });

  it('zooms with the wheel around the pointer and does not scroll the page', () => {
    const view = mount();
    const canvas = view.querySelector<HTMLElement>('.dual-flow-canvas')!;
    const before = view.querySelector('.dual-flow-canvas svg > g')!.getAttribute('transform');
    const event = new WheelEvent('wheel', {
      deltaY: -100,
      clientX: 0,
      clientY: 0,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      canvas.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    const after = view.querySelector('.dual-flow-canvas svg > g')!.getAttribute('transform');
    expect(after).not.toBe(before);
    expect(after).not.toContain('scale(0.6)');
  });
});
