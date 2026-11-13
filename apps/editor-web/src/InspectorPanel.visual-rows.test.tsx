// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VisualObjectV1 } from '@joy-media/project-schema';
import { InspectorPanel } from './InspectorPanel.js';
import { monitorTransformPreview } from './monitor/monitor-transform-preview.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const crop = { left: 0, top: 0, right: 0, bottom: 0 };
const SHAPE: VisualObjectV1 = {
  id: 'shape-1',
  kind: 'shape',
  transform: { x: 120, y: 80, scaleX: 1, scaleY: 0.5, rotationDeg: 0, opacity: 1, crop },
} as VisualObjectV1;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  monitorTransformPreview.set(undefined);
});

function mount(object: VisualObjectV1) {
  const onSetStatic = vi.fn<(objectId: string, key: string, value: number) => void>();
  const onDispatch = vi.fn<(transaction: { readonly commands: readonly unknown[] }) => void>();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <InspectorPanel
        object={object}
        allObjects={{ [object.id]: object }}
        playheadUs={0}
        onSetStatic={onSetStatic}
        onDispatch={onDispatch}
      />,
    ),
  );
  return { onSetStatic, onDispatch };
}

function el<T extends Element = HTMLElement>(selector: string): T {
  const found = container!.querySelector<T>(selector);
  if (found === null) throw new Error(`no element for ${selector}`);
  return found;
}

function field(key: string): HTMLInputElement {
  return el<HTMLInputElement>(`#insp-${key}`);
}

/** Types a value the way the browser does: the input event React listens to. */
function type(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(input: HTMLInputElement, key: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function click(button: HTMLElement): void {
  act(() => button.click());
}

describe('Inspector Visual rows layout (T-D08)', () => {
  it('puts X and Y on one row and Scale X and Y on one row with a link toggle', () => {
    mount(SHAPE);
    const position = el('[role="group"][aria-label="Position"]');
    expect(position.querySelector('#insp-x')).not.toBeNull();
    expect(position.querySelector('#insp-y')).not.toBeNull();

    const scale = el('[role="group"][aria-label="Scale"]');
    expect(scale.querySelector('#insp-scaleX')).not.toBeNull();
    expect(scale.querySelector('#insp-scaleY')).not.toBeNull();
    const link = el<HTMLButtonElement>('button[aria-label="Link Scale X and Scale Y"]');
    expect(link.getAttribute('aria-pressed')).toBe('false');
    expect(scale.contains(link)).toBe(true);
  });

  it('shows opacity once as a percentage with a slider and keeps the stored 0 to 1 value', () => {
    mount({ ...SHAPE, transform: { ...SHAPE.transform, opacity: 0.25 } } as VisualObjectV1);
    expect(field('opacity').value).toBe('25');
    const slider = el<HTMLInputElement>('input[type="range"][aria-label="Opacity slider"]');
    expect(slider.value).toBe('25');
    // The percentage is not repeated in the row heading.
    expect(el('[data-property-row="Opacity"]').querySelector('.property-row-value')).toBeNull();
  });

  it('typing a percentage stores it as a 0 to 1 opacity', () => {
    const { onSetStatic } = mount(SHAPE);
    type(field('opacity'), '50');
    press(field('opacity'), 'Enter');
    expect(onSetStatic).toHaveBeenCalledTimes(1);
    expect(onSetStatic).toHaveBeenCalledWith('shape-1', 'opacity', 0.5);
  });

  it('a percentage above 100 is clamped to a stored 1', () => {
    const { onSetStatic } = mount({
      ...SHAPE,
      transform: { ...SHAPE.transform, opacity: 0.2 },
    } as VisualObjectV1);
    type(field('opacity'), '150');
    press(field('opacity'), 'Enter');
    expect(onSetStatic).toHaveBeenCalledWith('shape-1', 'opacity', 1);
  });

  it('gives each Reset button the class that hides it until hover or focus', () => {
    mount(SHAPE);
    expect(el('button.property-row-reset[aria-label="Reset Position X"]')).not.toBeNull();
    expect(el('button.property-row-reset[aria-label="Reset Opacity"]')).not.toBeNull();
  });

  it('the fx chip is gold only when the property has an expression', () => {
    mount(SHAPE);
    expect(container!.querySelectorAll('button.fx-on').length).toBe(0);
    expect(container!.querySelectorAll('button.fx').length).toBeGreaterThan(0);
  });

  it('the fx chip turns gold on a property with an expression', () => {
    mount({ ...SHAPE, expressions: { x: 'time * 10' } } as VisualObjectV1);
    const chip = el<HTMLButtonElement>('button[aria-label="Edit Position X expression"]');
    expect(chip.className).toBe('fx fx-on');
    expect(el('button[aria-label="Add Position Y expression"]').className).toBe('fx');
  });
});

describe('Inspector linked scale (T-D08)', () => {
  it('is off by default: a typed scale X writes only scale X', () => {
    const { onSetStatic, onDispatch } = mount(SHAPE);
    type(field('scaleX'), '2');
    press(field('scaleX'), 'Enter');
    expect(onSetStatic).toHaveBeenCalledTimes(1);
    expect(onSetStatic).toHaveBeenCalledWith('shape-1', 'scaleX', 2);
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it('with the link on, a typed scale X moves scale Y by the same ratio in one dispatch', () => {
    const { onSetStatic, onDispatch } = mount(SHAPE);
    click(el('button[aria-label="Link Scale X and Scale Y"]'));
    expect(el('button[aria-label="Link Scale X and Scale Y"]').getAttribute('aria-pressed')).toBe(
      'true',
    );
    type(field('scaleX'), '2');
    press(field('scaleX'), 'Enter');
    // Scale Y started at 0.5 with X at 1, so X at 2 takes Y to 1.
    expect(onSetStatic).not.toHaveBeenCalled();
    expect(onDispatch).toHaveBeenCalledTimes(1);
    const transaction = onDispatch.mock.calls[0]![0];
    expect(transaction.commands).toEqual([
      {
        type: 'object.setTransformProperty',
        payload: { objectId: 'shape-1', key: 'scaleX', value: 2 },
      },
      {
        type: 'object.setTransformProperty',
        payload: { objectId: 'shape-1', key: 'scaleY', value: 1 },
      },
    ]);
  });

  it('with the link on, a typed scale Y moves scale X by the same ratio', () => {
    const { onDispatch } = mount(SHAPE);
    click(el('button[aria-label="Link Scale X and Scale Y"]'));
    type(field('scaleY'), '0.25');
    press(field('scaleY'), 'Enter');
    // Scale Y 0.5 to 0.25 halves the ratio, so scale X 1 halves to 0.5.
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(onDispatch.mock.calls[0]![0].commands).toEqual([
      {
        type: 'object.setTransformProperty',
        payload: { objectId: 'shape-1', key: 'scaleX', value: 0.5 },
      },
      {
        type: 'object.setTransformProperty',
        payload: { objectId: 'shape-1', key: 'scaleY', value: 0.25 },
      },
    ]);
  });

  it('with the link on, a typed scale previews both axes in the Monitor store', () => {
    mount(SHAPE);
    click(el('button[aria-label="Link Scale X and Scale Y"]'));
    type(field('scaleX'), '2');
    expect(monitorTransformPreview.get()?.get('shape-1')).toEqual({
      x: 120,
      y: 80,
      scaleX: 2,
      scaleY: 1,
      rotationDeg: 0,
    });
  });

  it('Reset writes its own axis only, even with the link on', () => {
    const { onSetStatic, onDispatch } = mount(SHAPE);
    click(el('button[aria-label="Link Scale X and Scale Y"]'));
    click(el('button.property-row-reset[aria-label="Reset Scale X"]'));
    expect(onDispatch).not.toHaveBeenCalled();
    expect(onSetStatic).toHaveBeenCalledWith('shape-1', 'scaleX', 1);
  });

  it('the link cannot be turned on while a scale axis is keyframed', () => {
    mount({
      ...SHAPE,
      animations: {
        scaleX: {
          keyframes: [
            { timeUs: 0, value: 1, interpolation: 'linear' },
            { timeUs: 1_000_000, value: 2, interpolation: 'linear' },
          ],
        },
      },
    } as VisualObjectV1);
    const link = el<HTMLButtonElement>('button[aria-label="Link Scale X and Scale Y"]');
    expect(link.disabled).toBe(true);
    click(link);
    expect(link.getAttribute('aria-pressed')).toBe('false');
  });
});
