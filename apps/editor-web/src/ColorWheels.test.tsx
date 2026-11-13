// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColorGradeV2 } from '@joy-media/project-schema';
import { createIdentityColorGrade } from '@joy-media/project-schema';
import { ColorWheels } from './ColorWheels.js';
import { colorGradePreview } from './color-grade-preview.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WHEEL_BOX = 132;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  colorGradePreview.set(undefined);
});

interface HarnessProps {
  readonly onChange?: (next: ColorGradeV2) => void;
  readonly onCommit: (next: ColorGradeV2) => void;
  readonly scope?: 'output' | 'clip';
  readonly clipId?: string;
}

/** The panel is controlled: the harness keeps the draft the panel writes. */
function Harness({ onChange, onCommit, scope = 'output', clipId }: HarnessProps) {
  const [draft, setDraft] = useState<ColorGradeV2>(() => createIdentityColorGrade());
  return (
    <ColorWheels
      draft={draft}
      onChange={(next) => {
        setDraft(next);
        onChange?.(next);
      }}
      onCommit={onCommit}
      animationStateFor={() => 'none'}
      onToggleAnimation={() => undefined}
      canAnimate={false}
      scope={scope}
      clipId={clipId}
    />
  );
}

function mount(props: HarnessProps): HTMLDivElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness {...props} />);
  });
  return container;
}

/** A wheel face with the browser's geometry and pointer capture faked out. */
function face(id: string): SVGElement {
  const element = container!.querySelector<SVGElement>(`[data-color-wheel="${id}"]`);
  if (element === null) throw new Error(`no ${id} wheel`);
  element.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: WHEEL_BOX,
      bottom: WHEEL_BOX,
      width: WHEEL_BOX,
      height: WHEEL_BOX,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  const pointerCapture = element as unknown as {
    setPointerCapture: (pointerId: number) => void;
    releasePointerCapture: (pointerId: number) => void;
    hasPointerCapture: (pointerId: number) => boolean;
  };
  pointerCapture.setPointerCapture = () => undefined;
  pointerCapture.releasePointerCapture = () => undefined;
  pointerCapture.hasPointerCapture = () => true;
  return element;
}

function pointer(target: Element, type: string, clientX: number, clientY: number): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, clientX, clientY, button: 0, cancelable: true }),
    );
  });
}

function key(target: Element, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function doubleClick(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
}

function numbers(id: string): readonly string[] {
  const row = container!.querySelector(`[data-color-wheel-numbers="${id}"]`);
  if (row === null) throw new Error(`no numbers for ${id}`);
  return [...row.querySelectorAll('output')].map((output) => output.textContent ?? '');
}

describe('the colour wheels panel (T-K02)', () => {
  it('shows the four wheels in order, with capital names and their hints', () => {
    mount({ onCommit: vi.fn() });
    expect([...container!.querySelectorAll('.cw-title')].map((node) => node.textContent)).toEqual([
      'Lift',
      'Gamma',
      'Gain',
      'Offset',
    ]);
    expect([...container!.querySelectorAll('.cw-hint')].map((node) => node.textContent)).toEqual([
      'shadows',
      'midtones',
      'highlights',
      'everything',
    ]);
  });

  it('shows the numbers of every wheel: R, G, B and Master', () => {
    mount({ onCommit: vi.fn() });
    expect(numbers('lift')).toEqual(['+0.00', '+0.00', '+0.00', '0.00']);
    expect(numbers('offset')).toEqual(['+0.00', '+0.00', '+0.00', '0.00']);
  });

  it('moves the puck with the arrow keys, one change per press', () => {
    const onCommit = vi.fn();
    mount({ onCommit });
    key(face('lift'), 'ArrowRight');

    expect(onCommit).toHaveBeenCalledTimes(1);
    const grade = onCommit.mock.calls[0]![0] as ColorGradeV2;
    // A puck to the right pushes the yellow-green side of the wheel.
    expect(grade.wheels?.lift.r).toBeCloseTo(0, 10);
    expect(grade.wheels?.lift.g).toBeCloseTo(0.0173, 4);
    expect(grade.wheels?.lift.b).toBeCloseTo(-0.0173, 4);
    expect(numbers('lift')).toEqual(['+0.00', '+0.02', '-0.02', '0.00']);
  });

  it('pushes red when the puck moves up', () => {
    const onCommit = vi.fn();
    mount({ onCommit });
    key(face('lift'), 'ArrowUp');

    const grade = onCommit.mock.calls[0]![0] as ColorGradeV2;
    expect(grade.wheels?.lift.r).toBeGreaterThan(0);
    expect(grade.wheels?.lift.g).toBeCloseTo(-grade.wheels!.lift.r! / 2, 10);
  });

  it('clears the colour on a double click and keeps the master', () => {
    const onCommit = vi.fn();
    mount({ onCommit });
    const lift = face('lift');
    key(lift, 'ArrowUp');
    doubleClick(lift);

    const grade = onCommit.mock.calls.at(-1)![0] as ColorGradeV2;
    expect(grade.wheels?.lift).toEqual({ r: 0, g: 0, b: 0, master: 0 });
    expect(numbers('lift')).toEqual(['+0.00', '+0.00', '+0.00', '0.00']);
  });

  it('resets one wheel without touching the others', () => {
    const onCommit = vi.fn();
    mount({ onCommit });
    key(face('lift'), 'ArrowUp');
    const reset = container!.querySelector('.cw-reset');
    if (reset === null) throw new Error('no reset button');
    click(reset);

    const grade = onCommit.mock.calls.at(-1)![0] as ColorGradeV2;
    expect(grade.wheels?.lift).toEqual({ r: 0, g: 0, b: 0, master: 0 });
    expect(grade.wheels?.gamma).toEqual({ r: 0, g: 0, b: 0, master: 0 });
  });

  it('previews the drag live and writes it to the document once, on release', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    mount({ onChange, onCommit });
    const lift = face('lift');

    pointer(lift, 'pointerdown', 66, 26);
    const preview = colorGradePreview.get();
    expect(preview?.scope).toBe('output');
    expect(preview?.grade.wheels?.lift.r).toBeGreaterThan(0);

    pointer(lift, 'pointermove', 66, 46);
    const moved = colorGradePreview.get();
    expect(moved?.grade.wheels?.lift.r).toBeLessThan(preview!.grade.wheels!.lift.r!);

    pointer(lift, 'pointerup', 66, 46);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls.length).toBeGreaterThan(1);
    expect(colorGradePreview.get()).toBeUndefined();
  });

  it('names the clip whose grade a clip preview changes', () => {
    mount({ onCommit: vi.fn(), scope: 'clip', clipId: 'clip-7' });
    const lift = face('lift');
    pointer(lift, 'pointerdown', 66, 26);

    const preview = colorGradePreview.get();
    expect(preview?.scope).toBe('clip');
    expect(preview?.clipId).toBe('clip-7');
  });
});
