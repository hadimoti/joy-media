import { useSyncExternalStore } from 'react';
import type { ScopePixels } from './color-scopes.js';
import type { PickedColour } from './color-hsl-math.js';

/**
 * The eyedropper of the HSL bands (T-K04).
 *
 * The HSL header starts a pick; while it is on, the Monitor shows an
 * eyedropper cursor and a magnifier, a click on the picture hands the pixel
 * (read before the grade) to whoever started the pick, and Esc cancels.
 */
export interface ColorEyedropperSession {
  readonly onPick: (colour: PickedColour) => void;
}

export interface ColorEyedropperStore {
  readonly get: () => ColorEyedropperSession | undefined;
  /** Starts a pick (a pick in progress is replaced). */
  readonly start: (onPick: (colour: PickedColour) => void) => void;
  /** Ends the pick without a colour. */
  readonly cancel: () => void;
  /** Ends the pick with this colour. */
  readonly pick: (colour: PickedColour) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createColorEyedropperStore(): ColorEyedropperStore {
  let current: ColorEyedropperSession | undefined;
  const listeners = new Set<() => void>();
  const set = (next: ColorEyedropperSession | undefined) => {
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => current,
    start: (onPick) => set({ onPick }),
    cancel: () => set(undefined),
    pick(colour) {
      const session = current;
      set(undefined);
      session?.onPick(colour);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The editor's one eyedropper, shared by the Color panel and the Monitor. */
export const colorEyedropper: ColorEyedropperStore = createColorEyedropperStore();

/** True while a pick is on. */
export function useColorEyedropperActive(store: ColorEyedropperStore = colorEyedropper): boolean {
  const session = useSyncExternalStore(store.subscribe, store.get, store.get);
  return session !== undefined;
}

/** A part of the frame, in authored frame pixels. */
export interface PixelWindow {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A read-back of the picture. A read-back of only a window of the frame says
 * where it sits: `left` and `top` place it in the grid the whole frame would
 * have been read at (`gridWidth` × `gridHeight`). Without them it is the whole
 * frame.
 */
export type WindowPixels = ScopePixels & {
  readonly left?: number;
  readonly top?: number;
  readonly gridWidth?: number;
  readonly gridHeight?: number;
};

/** Reads the picture before the grade, at most `maxWidth` × `maxHeight`, optionally only a window. */
export type UngradedPixelReader = (
  maxWidth: number,
  maxHeight: number,
  region?: PixelWindow,
) => WindowPixels | undefined;

/** The eyedropper never reads more than this many frame pixels on a side. */
export const EYEDROPPER_READ_WINDOW = 512;

function gridSize(pixels: WindowPixels): { readonly width: number; readonly height: number } {
  return { width: pixels.gridWidth ?? pixels.width, height: pixels.gridHeight ?? pixels.height };
}

/** The read-back cell under a canvas point, or `undefined` outside the frame or the window. */
function cellOffset(
  pixels: WindowPixels,
  frame: { readonly width: number; readonly height: number },
  point: { readonly x: number; readonly y: number },
): number | undefined {
  if (frame.width <= 0 || frame.height <= 0) return undefined;
  if (point.x < 0 || point.y < 0 || point.x >= frame.width || point.y >= frame.height)
    return undefined;
  const grid = gridSize(pixels);
  const x =
    Math.min(grid.width - 1, Math.floor((point.x * grid.width) / frame.width)) - (pixels.left ?? 0);
  const y =
    Math.min(grid.height - 1, Math.floor((point.y * grid.height) / frame.height)) -
    (pixels.top ?? 0);
  if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return undefined;
  return (y * pixels.width + x) * 4;
}

/**
 * The pixel under a canvas point (authored frame pixels), from a read-back
 * that may be smaller than the frame or only a window of it. `undefined`
 * outside the frame (or outside the window).
 */
export function pixelAt(
  pixels: WindowPixels,
  frame: { readonly width: number; readonly height: number },
  point: { readonly x: number; readonly y: number },
): PickedColour | undefined {
  const offset = cellOffset(pixels, frame, point);
  if (offset === undefined) return undefined;
  return { r: pixels.data[offset]!, g: pixels.data[offset + 1]!, b: pixels.data[offset + 2]! };
}

/**
 * The magnifier's cells, kept between pointer moves: the same array and the
 * same colour objects are filled again on every move.
 */
export interface MagnifierCells {
  readonly cells: (PickedColour | undefined)[];
  readonly pool: { r: number; g: number; b: number }[];
}

export function createMagnifierCells(): MagnifierCells {
  return { cells: [], pool: [] };
}

/**
 * The square of read-back pixels around a canvas point, row by row, for the
 * magnifier; a pixel outside the frame is `undefined`. With `reuse`, the
 * cells are written into its array and colour objects instead of new ones.
 */
export function pixelNeighbourhood(
  pixels: WindowPixels,
  frame: { readonly width: number; readonly height: number },
  point: { readonly x: number; readonly y: number },
  radius: number,
  reuse?: MagnifierCells,
): readonly (PickedColour | undefined)[] {
  const grid = gridSize(pixels);
  const stepX = frame.width / Math.max(1, grid.width);
  const stepY = frame.height / Math.max(1, grid.height);
  if (reuse === undefined) {
    const cells: (PickedColour | undefined)[] = [];
    for (let dy = -radius; dy <= radius; dy += 1)
      for (let dx = -radius; dx <= radius; dx += 1)
        cells.push(pixelAt(pixels, frame, { x: point.x + dx * stepX, y: point.y + dy * stepY }));
    return cells;
  }
  const side = radius * 2 + 1;
  const { cells, pool } = reuse;
  while (pool.length < side * side) pool.push({ r: 0, g: 0, b: 0 });
  cells.length = side * side;
  const probe = { x: 0, y: 0 };
  let index = 0;
  for (let dy = -radius; dy <= radius; dy += 1)
    for (let dx = -radius; dx <= radius; dx += 1) {
      probe.x = point.x + dx * stepX;
      probe.y = point.y + dy * stepY;
      const offset = cellOffset(pixels, frame, probe);
      if (offset === undefined) cells[index] = undefined;
      else {
        const colour = pool[index]!;
        colour.r = pixels.data[offset]!;
        colour.g = pixels.data[offset + 1]!;
        colour.b = pixels.data[offset + 2]!;
        cells[index] = colour;
      }
      index += 1;
    }
  return cells;
}

/**
 * True when the read-back holds the pixel under the point and the magnifier
 * around it (a whole-frame read-back always does).
 */
export function readBackCovers(
  pixels: WindowPixels,
  frame: { readonly width: number; readonly height: number },
  point: { readonly x: number; readonly y: number },
  radius: number,
): boolean {
  if (pixels.left === undefined && pixels.top === undefined) return true;
  if (frame.width <= 0 || frame.height <= 0) return true;
  const grid = gridSize(pixels);
  const axis = (value: number, size: number, cells: number, start: number, length: number) => {
    const cell = Math.floor((value * cells) / size);
    const low = Math.max(0, Math.min(cells - 1, cell - radius));
    const high = Math.max(0, Math.min(cells - 1, cell + radius));
    return low >= start && high < start + length;
  };
  return (
    axis(point.x, frame.width, grid.width, pixels.left ?? 0, pixels.width) &&
    axis(point.y, frame.height, grid.height, pixels.top ?? 0, pixels.height)
  );
}

/**
 * The window of the frame the eyedropper reads around a point: at most
 * `size` frame pixels on a side, kept inside the frame. `undefined` when the
 * whole frame fits in one window (it is read whole, as before).
 */
export function readWindowAround(
  frame: { readonly width: number; readonly height: number },
  point: { readonly x: number; readonly y: number } | undefined,
  size = EYEDROPPER_READ_WINDOW,
): PixelWindow | undefined {
  if (frame.width <= size && frame.height <= size) return undefined;
  const width = Math.min(size, frame.width);
  const height = Math.min(size, frame.height);
  const centre = point ?? { x: frame.width / 2, y: frame.height / 2 };
  const clampTo = (value: number, max: number) => Math.max(0, Math.min(max, value));
  return {
    x: clampTo(Math.round(centre.x - width / 2), frame.width - width),
    y: clampTo(Math.round(centre.y - height / 2), frame.height - height),
    width,
    height,
  };
}
