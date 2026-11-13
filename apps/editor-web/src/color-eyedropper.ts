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

/**
 * The pixel under a canvas point (authored frame pixels), from a read-back
 * that may be smaller than the frame. `undefined` outside the frame.
 */
export function pixelAt(
  pixels: ScopePixels,
  frame: { readonly width: number; readonly height: number },
  point: { readonly x: number; readonly y: number },
): PickedColour | undefined {
  if (frame.width <= 0 || frame.height <= 0) return undefined;
  if (point.x < 0 || point.y < 0 || point.x >= frame.width || point.y >= frame.height)
    return undefined;
  const x = Math.min(pixels.width - 1, Math.floor((point.x * pixels.width) / frame.width));
  const y = Math.min(pixels.height - 1, Math.floor((point.y * pixels.height) / frame.height));
  const offset = (y * pixels.width + x) * 4;
  return { r: pixels.data[offset]!, g: pixels.data[offset + 1]!, b: pixels.data[offset + 2]! };
}

/**
 * The square of read-back pixels around a canvas point, row by row, for the
 * magnifier; a pixel outside the frame is `undefined`.
 */
export function pixelNeighbourhood(
  pixels: ScopePixels,
  frame: { readonly width: number; readonly height: number },
  point: { readonly x: number; readonly y: number },
  radius: number,
): readonly (PickedColour | undefined)[] {
  const cells: (PickedColour | undefined)[] = [];
  const stepX = frame.width / Math.max(1, pixels.width);
  const stepY = frame.height / Math.max(1, pixels.height);
  for (let dy = -radius; dy <= radius; dy += 1)
    for (let dx = -radius; dx <= radius; dx += 1)
      cells.push(pixelAt(pixels, frame, { x: point.x + dx * stepX, y: point.y + dy * stepY }));
  return cells;
}
