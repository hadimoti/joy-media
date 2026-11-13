// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColorGradeV2 } from '@joy-media/project-schema';
import { createIdentityColorGrade } from '@joy-media/project-schema';
import { ColorCurves } from './ColorCurves.js';
import { colorGradePreview } from './color-grade-preview.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The graph's size on screen in the tests: one CSS pixel is one level. */
const BOX = 256;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  colorGradePreview.set(undefined);
});

function Harness({
  onCommit,
  initial,
}: {
  readonly onCommit: (next: ColorGradeV2) => void;
  readonly initial?: ColorGradeV2;
}) {
  const [draft, setDraft] = useState<ColorGradeV2>(() => initial ?? createIdentityColorGrade());
  return (
    <ColorCurves
      draft={draft}
      onChange={setDraft}
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

function mount(onCommit: (next: ColorGradeV2) => void, initial?: ColorGradeV2): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness onCommit={onCommit} {...(initial === undefined ? {} : { initial })} />);
  });
}

/** The graph with the browser's geometry and pointer capture faked out. */
function graph(): SVGSVGElement {
  const element = container!.querySelector<SVGSVGElement>('[data-curve-graph]');
  if (element === null) throw new Error('no curve graph');
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
  const capture = element as unknown as {
    setPointerCapture: (pointerId: number) => void;
    releasePointerCapture: (pointerId: number) => void;
    hasPointerCapture: (pointerId: number) => boolean;
  };
  capture.setPointerCapture = () => undefined;
  capture.releasePointerCapture = () => undefined;
  capture.hasPointerCapture = () => true;
  return element;
}

/** A fake pointer event at a level (input, output) of the graph. */
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

function key(name: string, shiftKey = false): void {
  act(() => {
    graph().dispatchEvent(
      new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true }),
    );
  });
}

function readout(): string {
  return container!.querySelector('[data-curve-readout]')?.textContent ?? '';
}

function shownPoints(): number {
  return container!.querySelectorAll('[data-curve-point]').length;
}

function gradeWithRgb(points: readonly { x: number; y: number }[]): ColorGradeV2 {
  const grade = createIdentityColorGrade();
  return { ...grade, curves: { ...grade.curves!, rgb: points } };
}

describe('ColorCurves', () => {
  it('adds a point on the line, previews the drag live and writes once on release', () => {
    const onCommit = vi.fn();
    mount(onCommit);
    expect(shownPoints()).toBe(2);

    pointer('pointerdown', 128, 128);
    expect(shownPoints()).toBe(3);
    pointer('pointermove', 128, 170);
    expect(readout()).toBe('In 128, Out 169');
    expect(colorGradePreview.get()?.grade.curves?.rgb[1]).toEqual({ x: 0.5, y: 170 / 256 });
    expect(onCommit).not.toHaveBeenCalled();

    pointer('pointermove', 128, 192);
    pointer('pointerup', 128, 192);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0].curves.rgb).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.75 },
      { x: 1, y: 1 },
    ]);
    expect(colorGradePreview.get()).toBeUndefined();
  });

  it('does nothing for a click away from the line', () => {
    const onCommit = vi.fn();
    mount(onCommit);
    pointer('pointerdown', 50, 220);
    pointer('pointerup', 50, 220);
    expect(shownPoints()).toBe(2);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('slides an end point along its edge', () => {
    const onCommit = vi.fn();
    mount(onCommit);
    pointer('pointerdown', 0, 0);
    pointer('pointermove', 60, 40);
    pointer('pointerup', 60, 40);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0].curves.rgb[0]).toEqual({ x: 0, y: 40 / 256 });
  });

  it('removes a point dragged out of the graph', () => {
    const onCommit = vi.fn();
    mount(
      onCommit,
      gradeWithRgb([
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
      ]),
    );
    pointer('pointerdown', 128, 128);
    pointer('pointermove', 128, 400);
    expect(shownPoints()).toBe(2);
    pointer('pointerup', 128, 400);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0].curves.rgb).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
  });

  it('removes a point with a double-click', () => {
    const onCommit = vi.fn();
    mount(
      onCommit,
      gradeWithRgb([
        { x: 0, y: 0 },
        { x: 0.5, y: 0.6 },
        { x: 1, y: 1 },
      ]),
    );
    act(() => {
      graph().dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          clientX: 128,
          clientY: BOX - 0.6 * BOX,
        }),
      );
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0].curves.rgb).toHaveLength(2);
  });

  it('moves between points with Tab, nudges with the arrows and deletes with Delete', () => {
    const onCommit = vi.fn();
    mount(
      onCommit,
      gradeWithRgb([
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
      ]),
    );
    key('Tab');
    expect(readout()).toBe('In 0, Out 0');
    key('Tab');
    expect(readout()).toBe('In 128, Out 128');

    key('ArrowUp');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0].curves.rgb[1].y).toBeCloseTo(0.5 + 1 / 255, 12);
    key('ArrowUp', true);
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit.mock.calls[1]![0].curves.rgb[1].y).toBeCloseTo(0.5 + 11 / 255, 12);

    key('Delete');
    expect(onCommit).toHaveBeenCalledTimes(3);
    expect(onCommit.mock.calls[2]![0].curves.rgb).toHaveLength(2);
  });

  it('keeps one curve per channel, each with its own reset', () => {
    const onCommit = vi.fn();
    mount(onCommit);
    act(() => {
      container!
        .querySelector<HTMLButtonElement>('[data-curve-channel="red"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    pointer('pointerdown', 128, 128);
    pointer('pointermove', 128, 64);
    pointer('pointerup', 128, 64);
    const written = onCommit.mock.calls[0]![0] as ColorGradeV2;
    expect(written.curves!.red).toHaveLength(3);
    expect(written.curves!.rgb).toHaveLength(2);
    expect(
      container!.querySelector('[data-curve-channel="red"]')!.getAttribute('data-curve-modified'),
    ).toBe('true');

    const reset = [...container!.querySelectorAll('button')].find(
      (button) => button.textContent === 'Reset Red curve',
    )!;
    act(() => reset.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect((onCommit.mock.calls[1]![0] as ColorGradeV2).curves!.red).toHaveLength(2);
  });

  it('has no Point sliders any more', () => {
    mount(vi.fn());
    expect(container!.textContent).not.toContain('Point 1');
    expect(container!.querySelector('input[type="range"]')).toBeNull();
  });
});
