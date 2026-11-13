import { describe, expect, it } from 'vitest';
import {
  clampColorScopesWindowGeometry,
  COLOR_SCOPES_WINDOW_KEY,
  fitColorScopesWindowGeometry,
  loadColorScopesWindowGeometry,
  MIN_COLOR_SCOPES_WINDOW_HEIGHT,
  MIN_COLOR_SCOPES_WINDOW_WIDTH,
  saveColorScopesWindowGeometry,
  type ColorScopesWindowGeometry,
  type WindowGeometryStorage,
} from './color-scopes-window.js';

function storage(seed: Record<string, string> = {}): WindowGeometryStorage & {
  readonly values: Record<string, string>;
} {
  const values: Record<string, string> = { ...seed };
  return {
    values,
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
  };
}

const smallViewport = { width: 480, height: 360 };

describe('colour scopes window geometry', () => {
  it('fits a remembered position that is outside the viewport back on screen', () => {
    const store = storage({
      [COLOR_SCOPES_WINDOW_KEY]: JSON.stringify({
        x: 5000,
        y: 4000,
        width: 900,
        height: 700,
      }),
    });

    const restored = loadColorScopesWindowGeometry(store, smallViewport);

    expect(restored).toBeDefined();
    expect(restored!.x + restored!.width).toBeLessThanOrEqual(smallViewport.width);
    expect(restored!.y + restored!.height).toBeLessThanOrEqual(smallViewport.height);
    expect(restored!.x).toBeGreaterThanOrEqual(0);
    expect(restored!.y).toBeGreaterThanOrEqual(0);
  });

  it('keeps the minimum size when the viewport has room for it', () => {
    const store = storage({
      [COLOR_SCOPES_WINDOW_KEY]: JSON.stringify({ x: 10, y: 10, width: 40, height: 40 }),
    });

    const restored = loadColorScopesWindowGeometry(store, { width: 1280, height: 800 });

    expect(restored?.width).toBe(MIN_COLOR_SCOPES_WINDOW_WIDTH);
    expect(restored?.height).toBe(MIN_COLOR_SCOPES_WINDOW_HEIGHT);
  });

  it('lets a viewport smaller than the minimum win, so the window stays visible', () => {
    const fitted = fitColorScopesWindowGeometry(
      { x: 0, y: 0, width: 900, height: 700 },
      { width: 200, height: 150 },
    );

    expect(fitted.width).toBe(200);
    expect(fitted.height).toBe(150);
  });

  it('follows the viewport when it shrinks under the window', () => {
    const fitted = fitColorScopesWindowGeometry(
      { x: 300, y: 200, width: 440, height: 320 },
      smallViewport,
    );

    expect(fitted.x + fitted.width).toBeLessThanOrEqual(smallViewport.width);
    expect(fitted.y + fitted.height).toBeLessThanOrEqual(smallViewport.height);
  });

  it('keeps the title bar reachable while the window is dragged', () => {
    const dragged = clampColorScopesWindowGeometry(
      { x: 5000, y: 5000, width: 440, height: 320 },
      smallViewport,
    );

    // The window may hang off the edge, but its title bar stays on screen.
    expect(dragged.x).toBe(smallViewport.width - 160);
    expect(dragged.y).toBe(smallViewport.height - 48);
    expect(dragged.width).toBeLessThanOrEqual(smallViewport.width);
    expect(dragged.height).toBeLessThanOrEqual(smallViewport.height);
  });

  it('round-trips the geometry through the store', () => {
    const store = storage();
    const geometry: ColorScopesWindowGeometry = { x: 12, y: 24, width: 360, height: 260 };

    saveColorScopesWindowGeometry(store, geometry);

    expect(store.values[COLOR_SCOPES_WINDOW_KEY]).toBeDefined();
    expect(loadColorScopesWindowGeometry(store)).toEqual(geometry);
  });
});
