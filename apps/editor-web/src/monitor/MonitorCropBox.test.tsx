// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonitorCropBox } from './MonitorCropBox.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function mount(onCommit = vi.fn(), onClose = vi.fn()) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <MonitorCropBox
        crop={{ left: 0, top: 0, right: 0, bottom: 0 }}
        overlay={{
          elementId: 'image-1',
          clipId: 'clip-1',
          localToCanvas: [100, 0, 0, 100, 10, 20],
          corners: [
            { x: 10, y: 20 },
            { x: 110, y: 20 },
            { x: 110, y: 120 },
            { x: 10, y: 120 },
          ],
          handles: [],
          topCenter: { x: 60, y: 20 },
        }}
        view={{ zoom: 1, panX: 0, panY: 0 }}
        viewportSize={{ width: 200, height: 200 }}
        onCommit={onCommit}
        onClose={onClose}
      />,
    );
  });
  return { onCommit, onClose };
}

function pointerEvent(type: string, point: { x: number; y: number }) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: point.x },
    clientY: { value: point.y },
    pointerId: { value: 1 },
  });
  return event;
}

describe('MonitorCropBox', () => {
  it('commits a dragged edge using the existing crop fractions', () => {
    const { onCommit } = mount();
    const handle = container?.querySelector<HTMLButtonElement>('[data-crop-handle="left"]');
    const box = container?.querySelector<HTMLElement>('[data-monitor-crop-box]');
    expect(handle).not.toBeNull();
    expect(box).not.toBeNull();

    act(() => handle?.dispatchEvent(pointerEvent('pointerdown', { x: 10, y: 70 })));
    act(() => box?.dispatchEvent(pointerEvent('pointermove', { x: 30, y: 70 })));
    act(() => box?.dispatchEvent(pointerEvent('pointerup', { x: 30, y: 70 })));

    expect(onCommit).toHaveBeenCalledWith({ left: 0.2, top: 0, right: 0, bottom: 0 });
  });

  it('closes from Done and Escape', () => {
    const { onClose } = mount();
    const done = container?.querySelector<HTMLButtonElement>('.monitor-crop-done');
    act(() => done?.click());
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
