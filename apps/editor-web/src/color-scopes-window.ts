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

/** How much of the window stays reachable while it is dragged. */
export const COLOR_SCOPES_WINDOW_VISIBLE_WIDTH = 160;
export const COLOR_SCOPES_WINDOW_VISIBLE_HEIGHT = 48;

export const DEFAULT_COLOR_SCOPES_WINDOW_GEOMETRY: ColorScopesWindowGeometry = {
  x: 48,
  y: 96,
  width: 440,
  height: 320,
};

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

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

/**
 * A window keeps its minimum size, but a viewport smaller than that minimum
 * wins: a window that cannot be seen is worse than a small one.
 */
function fittedSize(requested: number, minimum: number, viewportSize: number): number {
  return Math.min(Math.max(minimum, requested), Math.max(1, viewportSize));
}

/**
 * Keeps the whole window inside the viewport. Used for a remembered position
 * and after the viewport changes, where the window has to be fully reachable.
 */
export function fitColorScopesWindowGeometry(
  geometry: ColorScopesWindowGeometry,
  viewport: ViewportSize,
): ColorScopesWindowGeometry {
  const width = fittedSize(geometry.width, MIN_COLOR_SCOPES_WINDOW_WIDTH, viewport.width);
  const height = fittedSize(geometry.height, MIN_COLOR_SCOPES_WINDOW_HEIGHT, viewport.height);
  return {
    x: Math.min(Math.max(0, geometry.x), Math.max(0, viewport.width - width)),
    y: Math.min(Math.max(0, geometry.y), Math.max(0, viewport.height - height)),
    width,
    height,
  };
}

/**
 * Keeps the window on screen while it is dragged or resized: the title bar
 * stays reachable, and the window never grows past the viewport.
 */
export function clampColorScopesWindowGeometry(
  geometry: ColorScopesWindowGeometry,
  viewport: ViewportSize,
): ColorScopesWindowGeometry {
  const width = fittedSize(geometry.width, MIN_COLOR_SCOPES_WINDOW_WIDTH, viewport.width);
  const height = fittedSize(geometry.height, MIN_COLOR_SCOPES_WINDOW_HEIGHT, viewport.height);
  return {
    x: Math.min(
      Math.max(0, geometry.x),
      Math.max(0, viewport.width - COLOR_SCOPES_WINDOW_VISIBLE_WIDTH),
    ),
    y: Math.min(
      Math.max(0, geometry.y),
      Math.max(0, viewport.height - COLOR_SCOPES_WINDOW_VISIBLE_HEIGHT),
    ),
    width,
    height,
  };
}

export function sameColorScopesWindowGeometry(
  left: ColorScopesWindowGeometry,
  right: ColorScopesWindowGeometry,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

/**
 * Reads the remembered position. A position saved on a bigger screen is fitted
 * back into the current viewport, so the window is never restored off-screen.
 */
export function loadColorScopesWindowGeometry(
  storage: WindowGeometryStorage | undefined,
  viewport?: ViewportSize,
): ColorScopesWindowGeometry | undefined {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(COLOR_SCOPES_WINDOW_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isGeometry(parsed)) return undefined;
    const geometry: ColorScopesWindowGeometry = {
      x: parsed.x,
      y: parsed.y,
      width: Math.max(MIN_COLOR_SCOPES_WINDOW_WIDTH, parsed.width),
      height: Math.max(MIN_COLOR_SCOPES_WINDOW_HEIGHT, parsed.height),
    };
    return viewport === undefined ? geometry : fitColorScopesWindowGeometry(geometry, viewport);
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
