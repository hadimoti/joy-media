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
  transform: { x: 120, y: 80, scaleX: 1, scaleY: 1, rotationDeg: 0, opacity: 1, crop },
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

function mount(object: VisualObjectV1, onSetStatic = vi.fn()) {
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
        onDispatch={() => undefined}
      />,
    ),
  );
  return onSetStatic;
}

function field(key: string): HTMLInputElement {
  const input = container!.querySelector<HTMLInputElement>(`#insp-${key}`);
  if (input === null) throw new Error(`no field ${key}`);
  return input;
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

describe('Inspector typing previews in the Monitor (T-M05a review)', () => {
  it('publishes each typed value into the Monitor drag preview store, then clears it on Enter', () => {
    const onSetStatic = mount(SHAPE);
    const changes = vi.fn();
    const unsubscribe = monitorTransformPreview.subscribe(changes);
    const x = field('x');
    type(x, '250');
    // The same store the Monitor draws from holds the whole local transform.
    expect(monitorTransformPreview.get()?.get('shape-1')).toEqual({
      x: 250,
      y: 80,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
    });
    expect(x.value).toBe('250');
    type(x, '260');
    expect(monitorTransformPreview.get()?.get('shape-1')?.x).toBe(260);
    // One store change per keystroke: the Inspector reading its own preview back
    // does not publish again (no feedback loop).
    expect(changes).toHaveBeenCalledTimes(2);
    expect(onSetStatic).not.toHaveBeenCalled();

    press(x, 'Enter');
    expect(onSetStatic).toHaveBeenCalledTimes(1);
    expect(onSetStatic).toHaveBeenCalledWith('shape-1', 'x', 260);
    expect(monitorTransformPreview.get()).toBeUndefined();
    expect(changes).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it('Escape clears the preview and restores the value without writing anything', () => {
    const onSetStatic = mount(SHAPE);
    const rotation = field('rotationDeg');
    type(rotation, '45');
    expect(monitorTransformPreview.get()?.get('shape-1')?.rotationDeg).toBe(45);
    press(rotation, 'Escape');
    expect(monitorTransformPreview.get()).toBeUndefined();
    expect(rotation.value).toBe('0');
    expect(onSetStatic).not.toHaveBeenCalled();
  });

  it('a scale the Monitor cannot draw (zero) is not previewed', () => {
    mount(SHAPE);
    const scaleX = field('scaleX');
    type(scaleX, '2');
    expect(monitorTransformPreview.get()?.get('shape-1')?.scaleX).toBe(2);
    type(scaleX, '0');
    expect(monitorTransformPreview.get()).toBeUndefined();
  });

  it('a keyframed value is not previewed (it is written as a keyframe on commit)', () => {
    mount({
      ...SHAPE,
      animations: {
        x: {
          keyframes: [
            { timeUs: 0, value: 0, interpolation: 'linear' },
            { timeUs: 1_000_000, value: 120, interpolation: 'linear' },
          ],
        },
      },
    } as VisualObjectV1);
    type(field('x'), '300');
    expect(monitorTransformPreview.get()).toBeUndefined();
  });

  it('leaves a Monitor drag preview alone when the Inspector commits', () => {
    mount(SHAPE);
    const y = field('y');
    type(y, '90');
    const drag = new Map([['shape-1', { x: 1, y: 2, scaleX: 1, scaleY: 1, rotationDeg: 0 }]]);
    act(() => monitorTransformPreview.set(drag));
    press(y, 'Enter');
    expect(monitorTransformPreview.get()).toBe(drag);
  });

  it('unmounting while typing clears the preview', () => {
    mount(SHAPE);
    type(field('x'), '10');
    expect(monitorTransformPreview.get()).toBeDefined();
    act(() => root?.unmount());
    root = undefined;
    expect(monitorTransformPreview.get()).toBeUndefined();
  });
});
