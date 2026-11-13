// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColorGradeV2 } from '@joy-media/project-schema';
import { createIdentityColorGrade } from '@joy-media/project-schema';
import { ColorCurves } from './ColorCurves.js';
import { curveLineSpline } from './color-curves-math.js';
import { colorGradePreview } from './color-grade-preview.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * T-K03 review fix: pointer moves are folded into one update per animation
 * frame, and a redraw of the line does not allocate per sample.
 */

const BOX = 256;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;

beforeEach(() => {
  frames = new Map();
  nextFrameId = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  colorGradePreview.set(undefined);
  vi.unstubAllGlobals();
});

/** Runs the animation frames asked for so far. */
function runFrames(): void {
  const pending = [...frames.values()];
  frames.clear();
  act(() => {
    for (const callback of pending) callback(0);
  });
}

function mount(onChange: (next: ColorGradeV2) => void, onCommit: (next: ColorGradeV2) => void) {
  function Harness() {
    const [draft, setDraft] = useState<ColorGradeV2>(() => createIdentityColorGrade());
    return (
      <ColorCurves
        draft={draft}
        onChange={(next) => {
          onChange(next);
          setDraft(next);
        }}
        onCommit={(next) => {
          setDraft(next);
          onCommit(next);
        }}
        animationStateFor={() => 'none'}
        onToggleAnimation={() => undefined}
        canAnimate={false}
        scope="output"
      />
    );
  }
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<Harness />));
}

function graph(): SVGSVGElement {
  const element = container!.querySelector<SVGSVGElement>('[data-curve-graph]')!;
  element.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: BOX,
      bottom: BOX,
      width: BOX,
      height: BOX,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  const capture = element as unknown as Record<string, unknown>;
  capture.setPointerCapture = () => undefined;
  capture.releasePointerCapture = () => undefined;
  capture.hasPointerCapture = () => true;
  return element;
}

function pointer(type: string, input: number, output: number): void {
  act(() => {
    graph().dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: input,
        clientY: BOX - output,
      }),
    );
  });
}

function readout(): string {
  return container!.querySelector('[data-curve-readout]')?.textContent ?? '';
}

describe('ColorCurves pointer moves (review fix)', () => {
  it('draws the first move at once and folds the rest of the frame into one update', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    mount(onChange, onCommit);
    pointer('pointerdown', 128, 128);
    const afterDown = onChange.mock.calls.length;

    pointer('pointermove', 128, 140);
    expect(onChange.mock.calls.length).toBe(afterDown + 1);
    expect(readout()).toBe('In 128, Out 139');

    // Five more moves inside the same frame: nothing new until the frame comes.
    for (const output of [150, 160, 170, 180, 190]) pointer('pointermove', 128, output);
    expect(onChange.mock.calls.length).toBe(afterDown + 1);

    runFrames();
    expect(onChange.mock.calls.length).toBe(afterDown + 2);
    expect(colorGradePreview.get()?.grade.curves?.rgb[1]).toEqual({ x: 0.5, y: 190 / 256 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('writes the last position on release even before its frame comes', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    mount(onChange, onCommit);
    pointer('pointerdown', 128, 128);
    pointer('pointermove', 128, 140);
    pointer('pointermove', 128, 192);
    pointer('pointerup', 128, 192);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0].curves.rgb[1]).toEqual({ x: 0.5, y: 0.75 });
    // The frame asked for during the drag does nothing after it.
    const calls = onChange.mock.calls.length;
    runFrames();
    expect(onChange.mock.calls.length).toBe(calls);
    expect(colorGradePreview.get()).toBeUndefined();
  });

  it('makes no new grade for a move that lands on the same point', () => {
    const onChange = vi.fn();
    mount(onChange, vi.fn());
    pointer('pointerdown', 128, 128);
    pointer('pointermove', 128, 160);
    runFrames();
    const calls = onChange.mock.calls.length;
    pointer('pointermove', 128, 160);
    runFrames();
    expect(onChange.mock.calls.length).toBe(calls);
  });

  it('prepares the line once per drawn update and keeps its buffers during a drag', () => {
    mount(vi.fn(), vi.fn());
    const buffers = curveLineSpline as unknown as Record<'xs' | 'tangents', Float64Array>;
    const xs = buffers.xs;
    const tangents = buffers.tangents;
    const allocations = curveLineSpline.allocations;
    pointer('pointerdown', 128, 128);
    const prepares = curveLineSpline.prepares;
    for (let move = 0; move < 40; move += 1) {
      pointer('pointermove', 128, 100 + move);
      runFrames();
    }
    pointer('pointerup', 128, 139);
    // 40 drawn moves, a handful of renders each at most, never one per sample (256).
    expect(curveLineSpline.prepares - prepares).toBeGreaterThan(0);
    expect(curveLineSpline.prepares - prepares).toBeLessThanOrEqual(41);
    expect(curveLineSpline.allocations).toBe(allocations);
    expect(buffers.xs).toBe(xs);
    expect(buffers.tangents).toBe(tangents);
  });
});
