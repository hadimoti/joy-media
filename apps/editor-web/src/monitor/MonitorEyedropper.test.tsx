// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonitorEyedropper } from './MonitorEyedropper.js';
import { createColorEyedropperStore } from '../color-eyedropper.js';
import type { ScopePixels } from '../color-scopes.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const FRAME = { width: 400, height: 200 };

/** The ungraded picture: left half pure green, right half grey. */
function picture(): ScopePixels {
  const width = 4;
  const height = 2;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const x = index % width;
    data[index * 4] = x < 2 ? 0 : 128;
    data[index * 4 + 1] = x < 2 ? 255 : 128;
    data[index * 4 + 2] = x < 2 ? 0 : 128;
    data[index * 4 + 3] = 255;
  }
  return { width, height, data };
}

function mount(store = createColorEyedropperStore(), readPixels = vi.fn(() => picture())) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MonitorEyedropper
        view={{ zoom: 0.5, panX: 20, panY: 10 }}
        frame={FRAME}
        playheadUs={0}
        store={store}
        readPixels={readPixels}
      />,
    );
  });
  return { store, readPixels };
}

function overlay(): HTMLDivElement | null {
  const element = container!.querySelector<HTMLDivElement>('[data-monitor-eyedropper]');
  if (element !== null)
    element.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        right: 500,
        bottom: 350,
        width: 400,
        height: 300,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;
  return element;
}

/** A pointer at a canvas point: screen = canvas × zoom + pan, plus the viewport's corner. */
function at(type: string, canvasX: number, canvasY: number): void {
  const element = overlay()!;
  act(() => {
    element.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 100 + 20 + canvasX * 0.5,
        clientY: 50 + 10 + canvasY * 0.5,
      }),
    );
  });
}

describe('MonitorEyedropper', () => {
  it('shows nothing while no pick is on', () => {
    mount();
    expect(overlay()).toBeNull();
  });

  it('reads the ungraded picture when the pick starts and magnifies the pixel and its hue', () => {
    const { store, readPixels } = mount();
    act(() => store.start(vi.fn()));
    expect(readPixels).toHaveBeenCalledWith(400, 200);
    at('pointermove', 50, 50);
    const readout = container!.querySelector('[data-eyedropper-readout]')!.textContent;
    expect(readout).toBe('Hue 120° · R 0 G 255 B 0');
    expect(container!.querySelectorAll('.monitor-eyedropper-grid span')).toHaveLength(49);
    at('pointermove', 350, 50);
    expect(container!.querySelector('[data-eyedropper-readout]')!.textContent).toContain(
      'Grey, no hue',
    );
  });

  it('picks the pixel under a click and closes', () => {
    const onPick = vi.fn();
    const { store } = mount();
    act(() => store.start(onPick));
    at('click', 60, 120);
    expect(onPick).toHaveBeenCalledWith({ r: 0, g: 255, b: 0 });
    expect(overlay()).toBeNull();
  });

  it('keeps the pick on for a click beside the picture', () => {
    const onPick = vi.fn();
    const { store } = mount();
    act(() => store.start(onPick));
    at('click', 500, 50);
    expect(onPick).not.toHaveBeenCalled();
    expect(store.get()).toBeDefined();
  });

  it('cancels with Esc', () => {
    const onPick = vi.fn();
    const { store } = mount();
    act(() => store.start(onPick));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    expect(store.get()).toBeUndefined();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('keeps the Monitor from seeing the press (no selection starts under the eyedropper)', () => {
    const store = createColorEyedropperStore();
    const parentDown = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <div onPointerDown={parentDown}>
          <MonitorEyedropper
            view={{ zoom: 0.5, panX: 20, panY: 10 }}
            frame={FRAME}
            playheadUs={0}
            store={store}
            readPixels={() => picture()}
          />
        </div>,
      );
    });
    act(() => store.start(vi.fn()));
    at('pointerdown', 50, 50);
    expect(parentDown).not.toHaveBeenCalled();
  });
});
