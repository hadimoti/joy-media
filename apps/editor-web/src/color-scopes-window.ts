/**
 * Where the floating scopes window sits (T-K05).
 *
 * The geometry is a user preference, not project data, so it lives under its
 * own key and never reaches the project document. The window is remembered
 * between sessions so a colourist finds it where they left it.
 */

export const COLOR_SCOPES_WINDOW_KEY = 'joy-media.color-scopes-window.v1';

export interface ColorScopesWindowGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowGeometryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Small enough to sit beside the panel, large enough to read a scope. */
export const MIN_COLOR_SCOPES_WINDOW_WIDTH = 300;
export const MIN_COLOR_SCOPES_WINDOW_HEIGHT = 220;

export const DEFAULT_COLOR_SCOPES_WINDOW_GEOMETRY: ColorScopesWindowGeometry = {
  x: 48,
  y: 96,
  width: 440,
  height: 320,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isGeometry(value: unknown): value is ColorScopesWindowGeometry {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    isFiniteNumber(record.x) &&
    isFiniteNumber(record.y) &&
    isFiniteNumber(record.width) &&
    isFiniteNumber(record.height)
  );
}

export function loadColorScopesWindowGeometry(
  storage: WindowGeometryStorage | undefined,
): ColorScopesWindowGeometry | undefined {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(COLOR_SCOPES_WINDOW_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isGeometry(parsed)) return undefined;
    return {
      x: parsed.x,
      y: parsed.y,
      width: Math.max(MIN_COLOR_SCOPES_WINDOW_WIDTH, parsed.width),
      height: Math.max(MIN_COLOR_SCOPES_WINDOW_HEIGHT, parsed.height),
    };
  } catch {
    // A malformed or unavailable store only costs the remembered position.
    return undefined;
  }
}

export function saveColorScopesWindowGeometry(
  storage: WindowGeometryStorage | undefined,
  geometry: ColorScopesWindowGeometry,
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(COLOR_SCOPES_WINDOW_KEY, JSON.stringify(geometry));
  } catch {
    // A full or blocked store must not break the colour panel.
  }
}

/**
 * Keeps the window on screen: the title bar stays reachable and the window
 * never grows past the viewport it was dragged in.
 */
export function clampColorScopesWindowGeometry(
  geometry: ColorScopesWindowGeometry,
  viewport: { readonly width: number; readonly height: number },
): ColorScopesWindowGeometry {
  const width = Math.min(
    Math.max(MIN_COLOR_SCOPES_WINDOW_WIDTH, geometry.width),
    Math.max(MIN_COLOR_SCOPES_WINDOW_WIDTH, viewport.width),
  );
  const height = Math.min(
    Math.max(MIN_COLOR_SCOPES_WINDOW_HEIGHT, geometry.height),
    Math.max(MIN_COLOR_SCOPES_WINDOW_HEIGHT, viewport.height),
  );
  return {
    x: Math.min(Math.max(0, geometry.x), Math.max(0, viewport.width - 160)),
    y: Math.min(Math.max(0, geometry.y), Math.max(0, viewport.height - 48)),
    width,
    height,
  };
}
