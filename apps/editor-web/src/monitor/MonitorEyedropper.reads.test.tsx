// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EYEDROPPER_REREAD_INTERVAL_MS, MonitorEyedropper } from './MonitorEyedropper.js';
import {
  createColorEyedropperStore,
  createMagnifierCells,
  pixelAt,
  pixelNeighbourhood,
  readBackCovers,
  readWindowAround,
  type PixelWindow,
  type WindowPixels,
} from '../color-eyedropper.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * T-K04 review fix: the eyedropper reads the picture only when the pointer
 * moves or the frame changes while picking, throttled, as a window of at most
 * 512 frame pixels, and the magnifier reuses one cell array.
 */

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.useRealTimers();
});

/** A frame whose pixel (x, y) is r = x mod 256, g = y mod 256, b = playhead tag. */
function reader(frame: { width: number; height: number }, tag: () => number) {
  return vi.fn((maxWidth: number, maxHeight: number, region?: PixelWindow): WindowPixels => {
    const scale = Math.min(1, maxWidth / frame.width, maxHeight / frame.height);
    const gridWidth = Math.max(1, Math.round(frame.width * scale));
    const gridHeight = Math.max(1, Math.round(frame.height * scale));
    const left = region === undefined ? 0 : Math.floor(region.x * (gridWidth / frame.width));
    const top = region === undefined ? 0 : Math.floor(region.y * (gridHeight / frame.height));
    const width =
      region === undefined
        ? gridWidth
        : Math.min(gridWidth, Math.ceil((region.x + region.width) * (gridWidth / frame.width))) -
          left;
    const height =
      region === undefined
        ? gridHeight
        : Math.min(
            gridHeight,
            Math.ceil((region.y + region.height) * (gridHeight / frame.height)),
          ) - top;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        data[offset] = (left + x) % 256;
        data[offset + 1] = (top + y) % 256;
        data[offset + 2] = tag();
        data[offset + 3] = 255;
      }
    return region === undefined
      ? { width, height, data }
      : { width, height, data, left, top, gridWidth, gridHeight };
  });
}

const VIEW = { zoom: 1, panX: 0, panY: 0 };

function setup(frame: { width: number; height: number }) {
  const store = createColorEyedropperStore();
  let playheadUs = 0;
  const readPixels = reader(frame, () => playheadUs % 251);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const render = () =>
    act(() => {
      root!.render(
        <MonitorEyedropper
          view={VIEW}
          frame={frame}
          playheadUs={playheadUs}
          store={store}
          readPixels={readPixels}
        />,
      );
    });
  render();
  return {
    store,
    readPixels,
    setPlayhead(next: number) {
      playheadUs = next;
      render();
    },
  };
}

function overlay(): HTMLDivElement {
  const element = container!.querySelector<HTMLDivElement>('[data-monitor-eyedropper]')!;
  element.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 5000,
      bottom: 5000,
      width: 5000,
      height: 5000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return element;
}

function at(type: string, x: number, y: number): void {
  const element = overlay();
  act(() => {
    element.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }),
    );
  });
}

function readoutText(): string {
  return container!.querySelector('[data-eyedropper-readout]')?.textContent ?? '';
}

describe('MonitorEyedropper read-back (review fix)', () => {
  it('does not read a new frame during playback while the pointer is not over the picture', () => {
    const { store, readPixels, setPlayhead } = setup({ width: 400, height: 200 });
    act(() => store.start(vi.fn()));
    expect(readPixels).toHaveBeenCalledTimes(1);
    for (let frame = 1; frame <= 30; frame += 1) setPlayhead(frame * 33_333);
    act(() => vi.advanceTimersByTime(2000));
    expect(readPixels).toHaveBeenCalledTimes(1);
  });

  it('reads a new frame under the pointer at most once per interval', () => {
    const { store, readPixels, setPlayhead } = setup({ width: 400, height: 200 });
    act(() => store.start(vi.fn()));
    at('pointermove', 50, 50);
    expect(readPixels).toHaveBeenCalledTimes(1);
    // 30 frames inside one interval: one more read when the interval ends.
    for (let frame = 1; frame <= 30; frame += 1) setPlayhead(frame);
    expect(readPixels).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(EYEDROPPER_REREAD_INTERVAL_MS));
    expect(readPixels).toHaveBeenCalledTimes(2);
    // The magnifier shows the new frame.
    expect(readoutText()).toContain('B 30');
    act(() => vi.advanceTimersByTime(EYEDROPPER_REREAD_INTERVAL_MS * 5));
    expect(readPixels).toHaveBeenCalledTimes(2);
  });

  it('does not read again for pointer moves over the same frame', () => {
    const { store, readPixels } = setup({ width: 400, height: 200 });
    act(() => store.start(vi.fn()));
    for (let move = 0; move < 50; move += 1) at('pointermove', 10 + move * 5, 60);
    expect(readPixels).toHaveBeenCalledTimes(1);
  });

  it('picks from the frame shown now, even before the throttled read', () => {
    const onPick = vi.fn();
    const { store, setPlayhead } = setup({ width: 400, height: 200 });
    act(() => store.start(onPick));
    at('pointermove', 70, 40);
    setPlayhead(7);
    at('click', 70, 40);
    expect(onPick).toHaveBeenCalledWith({ r: 70, g: 40, b: 7 });
  });

  it('reads a large frame as a window of 512 pixels around the pointer', () => {
    const { store, readPixels } = setup({ width: 3840, height: 2160 });
    act(() => store.start(vi.fn()));
    // The start reads the middle of the frame, on the same 2048 grid as before.
    expect(readPixels).toHaveBeenLastCalledWith(2048, 2048, {
      x: 1664,
      y: 824,
      width: 512,
      height: 512,
    });
    at('pointermove', 100, 100);
    expect(readPixels).toHaveBeenCalledTimes(2);
    expect(readPixels).toHaveBeenLastCalledWith(2048, 2048, {
      x: 0,
      y: 0,
      width: 512,
      height: 512,
    });
    for (const call of readPixels.mock.results) {
      const pixels = call.value as WindowPixels;
      expect(pixels.width).toBeLessThanOrEqual(512);
      expect(pixels.height).toBeLessThanOrEqual(512);
    }
    // Inside the window: no new read; the pixel is the one the whole read-back had.
    at('pointermove', 200, 150);
    expect(readPixels).toHaveBeenCalledTimes(2);
    const scale = 2048 / 3840;
    expect(readoutText()).toContain(
      `R ${Math.floor(200 * scale) % 256} G ${Math.floor(150 * scale) % 256}`,
    );
    // Out of the window: one new read around the pointer.
    at('pointermove', 3000, 1800);
    expect(readPixels).toHaveBeenCalledTimes(3);
  });
});

describe('eyedropper read-back helpers (review fix)', () => {
  const frame = { width: 4000, height: 3000 };
  const whole = { width: 40, height: 30, data: new Uint8ClampedArray(40 * 30 * 4) };
  for (let index = 0; index < 40 * 30; index += 1) {
    whole.data[index * 4] = index % 40;
    whole.data[index * 4 + 1] = Math.floor(index / 40);
  }

  it('finds the same pixel in a window as in the whole read-back', () => {
    const window: WindowPixels = {
      width: 10,
      height: 8,
      left: 12,
      top: 5,
      gridWidth: 40,
      gridHeight: 30,
      data: new Uint8ClampedArray(10 * 8 * 4),
    };
    for (let y = 0; y < 8; y += 1)
      for (let x = 0; x < 10; x += 1) {
        const source = ((y + 5) * 40 + x + 12) * 4;
        const target = (y * 10 + x) * 4;
        window.data[target] = whole.data[source]!;
        window.data[target + 1] = whole.data[source + 1]!;
      }
    for (const point of [
      { x: 1250, y: 520 },
      { x: 2150, y: 1250 },
      { x: 1200, y: 500 },
    ])
      expect(pixelAt(window, frame, point)).toEqual(pixelAt(whole, frame, point));
    expect(pixelAt(window, frame, { x: 100, y: 100 })).toBeUndefined();
    expect(readBackCovers(window, frame, { x: 1650, y: 900 }, 3)).toBe(true);
    expect(readBackCovers(window, frame, { x: 1250, y: 900 }, 3)).toBe(false);
    expect(readBackCovers(whole, frame, { x: 1250, y: 900 }, 3)).toBe(true);
  });

  it('keeps the window inside the frame and reads a small frame whole', () => {
    expect(readWindowAround({ width: 400, height: 200 }, { x: 10, y: 10 })).toBeUndefined();
    expect(readWindowAround({ width: 1920, height: 1080 }, { x: 1900, y: 5 })).toEqual({
      x: 1408,
      y: 0,
      width: 512,
      height: 512,
    });
    expect(readWindowAround({ width: 1920, height: 300 }, { x: 960, y: 150 })).toEqual({
      x: 704,
      y: 0,
      width: 512,
      height: 300,
    });
  });

  it('fills the magnifier into one array and one set of colours', () => {
    const reuse = createMagnifierCells();
    const first = pixelNeighbourhood(whole, frame, { x: 2000, y: 1500 }, 3, reuse);
    const colours = [...first];
    const second = pixelNeighbourhood(whole, frame, { x: 1000, y: 700 }, 3, reuse);
    expect(second).toBe(first);
    expect(second).toBe(reuse.cells);
    expect(second).toHaveLength(49);
    second.forEach((cell, index) => expect(cell).toBe(colours[index]));
    // Same values as the allocating version.
    expect([...second]).toEqual([...pixelNeighbourhood(whole, frame, { x: 1000, y: 700 }, 3)]);
    // A cell beside the frame is empty, and the next fill brings its colour back.
    const edge = pixelNeighbourhood(whole, frame, { x: 10, y: 10 }, 3, reuse);
    expect(edge[0]).toBeUndefined();
    expect(edge).toBe(first);
  });
});
