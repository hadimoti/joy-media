import type { MonitorSize } from './monitor-view-state.js';

/**
 * The Monitor's View options (T-M08, ADR-0046 section 7): safe areas, grid,
 * centre marks, rulers with user guides, the canvas border, the pixel grid, the
 * Monitor background and the Preview overlay (aspect guides).
 *
 * They belong to the user and the screen, not to the project. They are saved per
 * user in the UI preferences, and they are drawn as editor-only HTML/SVG above
 * the canvas. They never enter the frame, the export or a read-back, and the
 * Preview overlay never changes the canvas format.
 *
 * Coordinates: guide positions and every rectangle here are authored frame
 * pixels (the same space as `monitor-view-state.ts` canvas points).
 */

export type MonitorBackground = 'checkerboard' | 'black' | 'grey';

export const MONITOR_BACKGROUNDS: readonly MonitorBackground[] = ['checkerboard', 'black', 'grey'];

export const MONITOR_PREVIEW_ASPECTS = ['none', '9:16', '1:1', '4:5', '16:9'] as const;
export type MonitorPreviewAspect = (typeof MONITOR_PREVIEW_ASPECTS)[number];

/** The switches of the View menu, in menu order. */
export const MONITOR_VIEW_SWITCHES = [
  'titleSafe',
  'actionSafe',
  'grid',
  'centreMarks',
  'rulers',
  'canvasBorder',
  'pixelGrid',
  'showPerformanceStats',
] as const;
export type MonitorViewSwitch = (typeof MONITOR_VIEW_SWITCHES)[number];

/** A user guide. `x` is a vertical line at canvas x; `y` a horizontal line at canvas y. */
export interface MonitorUserGuide {
  readonly axis: 'x' | 'y';
  /** Authored frame pixels. */
  readonly position: number;
}

export interface MonitorViewOptions {
  readonly titleSafe: boolean;
  readonly actionSafe: boolean;
  readonly grid: boolean;
  readonly centreMarks: boolean;
  /** Rulers and the user guides they draw (one switch). */
  readonly rulers: boolean;
  readonly canvasBorder: boolean;
  /** Shows only from `PIXEL_GRID_MIN_ZOOM` (800 per cent) on. */
  readonly pixelGrid: boolean;
  /** Shows rendered frame rate and dropped frames in the Monitor bar. */
  readonly showPerformanceStats: boolean;
  readonly background: MonitorBackground;
  readonly previewAspect: MonitorPreviewAspect;
  readonly guides: readonly MonitorUserGuide[];
}

export const DEFAULT_MONITOR_VIEW_OPTIONS: MonitorViewOptions = {
  titleSafe: false,
  actionSafe: false,
  grid: false,
  centreMarks: false,
  rulers: false,
  canvasBorder: false,
  pixelGrid: true,
  showPerformanceStats: false,
  background: 'checkerboard',
  previewAspect: 'none',
  guides: [],
};

/** The pixel grid appears from 800 per cent zoom. */
export const PIXEL_GRID_MIN_ZOOM = 8;
/** Title safe keeps 80 per cent of each side: an inset of 10 per cent on each side. */
export const TITLE_SAFE_INSET = 0.1;
/** Action safe keeps 90 per cent of each side: an inset of 5 per cent on each side. */
export const ACTION_SAFE_INSET = 0.05;
/** The grid divides each side into this many parts. */
export const GRID_DIVISIONS = 8;
export const MAX_USER_GUIDES = 64;
export const RULER_THICKNESS_PX = 16;
/** Ruler ticks are never closer than this on screen. */
export const RULER_MIN_TICK_SPACING_PX = 60;
const MAX_RULER_TICKS = 400;

const ASPECT_RATIOS: Readonly<Record<Exclude<MonitorPreviewAspect, 'none'>, number>> = {
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
  '16:9': 16 / 9,
};

/** A rectangle in authored frame pixels. */
export interface MonitorFrameRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function withMonitorSwitch(
  options: MonitorViewOptions,
  key: MonitorViewSwitch,
  on: boolean,
): MonitorViewOptions {
  return options[key] === on ? options : { ...options, [key]: on };
}

export function withMonitorBackground(
  options: MonitorViewOptions,
  background: MonitorBackground,
): MonitorViewOptions {
  return options.background === background ? options : { ...options, background };
}

export function withPreviewAspect(
  options: MonitorViewOptions,
  previewAspect: MonitorPreviewAspect,
): MonitorViewOptions {
  return options.previewAspect === previewAspect ? options : { ...options, previewAspect };
}

export function withoutUserGuides(options: MonitorViewOptions): MonitorViewOptions {
  return options.guides.length === 0 ? options : { ...options, guides: [] };
}

/** The pixel grid shows only when its switch is on and the zoom reaches 800 per cent. */
export function isPixelGridShown(options: MonitorViewOptions, zoom: number): boolean {
  return options.pixelGrid && zoom >= PIXEL_GRID_MIN_ZOOM - 1e-9;
}

/** The rectangle inside the frame that is kept, for an inset given as a fraction per side. */
export function safeAreaRect(frame: MonitorSize, inset: number): MonitorFrameRect {
  return {
    x: frame.width * inset,
    y: frame.height * inset,
    width: frame.width * (1 - 2 * inset),
    height: frame.height * (1 - 2 * inset),
  };
}

/**
 * The largest rectangle of the aspect that fits inside the frame, centred.
 * Undefined for "none" or an empty frame.
 */
export function previewAspectRect(
  frame: MonitorSize,
  aspect: MonitorPreviewAspect,
): MonitorFrameRect | undefined {
  if (aspect === 'none' || !(frame.width > 0) || !(frame.height > 0)) return undefined;
  const ratio = ASPECT_RATIOS[aspect];
  let width: number;
  let height: number;
  if (frame.width / frame.height > ratio) {
    height = frame.height;
    width = frame.height * ratio;
  } else {
    width = frame.width;
    height = frame.width / ratio;
  }
  return {
    x: (frame.width - width) / 2,
    y: (frame.height - height) / 2,
    width,
    height,
  };
}

/** The interior grid line positions along one side, in authored pixels. */
export function gridPositions(length: number): number[] {
  const lines: number[] = [];
  for (let index = 1; index < GRID_DIVISIONS; index += 1)
    lines.push((length * index) / GRID_DIVISIONS);
  return lines;
}

const RULER_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000] as const;

/** The smallest round step (authored px) whose ticks are at least the minimum apart on screen. */
export function rulerStep(zoom: number): number {
  if (!(zoom > 0)) return RULER_STEPS[RULER_STEPS.length - 1]!;
  for (const step of RULER_STEPS) if (step * zoom >= RULER_MIN_TICK_SPACING_PX) return step;
  return RULER_STEPS[RULER_STEPS.length - 1]!;
}

/**
 * Ruler tick values (authored px) from 0 to `length` that fall in the visible
 * range. Capped so a deep zoom cannot create thousands of elements.
 */
export function rulerTicks(
  length: number,
  zoom: number,
  visibleStart: number,
  visibleEnd: number,
): number[] {
  if (!(length > 0) || !(zoom > 0)) return [];
  const step = rulerStep(zoom);
  const low = Math.min(visibleStart, visibleEnd);
  const high = Math.max(visibleStart, visibleEnd);
  const from = Math.max(0, Math.floor(low / step) * step);
  const to = Math.min(length, high);
  const ticks: number[] = [];
  for (let value = from; value <= to && ticks.length < MAX_RULER_TICKS; value += step)
    ticks.push(value);
  return ticks;
}

export function userGuideLength(frame: MonitorSize, axis: 'x' | 'y'): number {
  return axis === 'x' ? frame.width : frame.height;
}

/**
 * Applies the end of a guide drag. `index` is the guide dragged; undefined means a
 * new guide from a ruler. A guide dropped outside the frame is removed; a new
 * guide dropped outside is not added.
 */
export function commitUserGuideDrag(
  guides: readonly MonitorUserGuide[],
  index: number | undefined,
  axis: 'x' | 'y',
  position: number,
  frame: MonitorSize,
): readonly MonitorUserGuide[] {
  const inside =
    Number.isFinite(position) && position >= 0 && position <= userGuideLength(frame, axis);
  if (index === undefined) {
    if (!inside || guides.length >= MAX_USER_GUIDES) return guides;
    return [...guides, { axis, position }];
  }
  if (index < 0 || index >= guides.length) return guides;
  if (!inside) return guides.filter((_, current) => current !== index);
  return guides.map((guide, current) => (current === index ? { axis, position } : guide));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUserGuide(value: unknown): value is MonitorUserGuide {
  return (
    isRecord(value) &&
    (value.axis === 'x' || value.axis === 'y') &&
    typeof value.position === 'number' &&
    Number.isFinite(value.position)
  );
}

/**
 * Reads the saved View options. Anything missing or malformed falls back to its
 * default, field by field, so one bad value never drops the other settings.
 */
export function sanitizeMonitorViewOptions(value: unknown): MonitorViewOptions {
  const defaults = DEFAULT_MONITOR_VIEW_OPTIONS;
  if (!isRecord(value)) return defaults;
  const flag = (key: MonitorViewSwitch): boolean =>
    typeof value[key] === 'boolean' ? value[key] : defaults[key];
  const background = MONITOR_BACKGROUNDS.find((candidate) => candidate === value.background);
  const previewAspect = MONITOR_PREVIEW_ASPECTS.find(
    (candidate) => candidate === value.previewAspect,
  );
  const guides = Array.isArray(value.guides)
    ? value.guides.filter(isUserGuide).slice(0, MAX_USER_GUIDES)
    : defaults.guides;
  return {
    titleSafe: flag('titleSafe'),
    actionSafe: flag('actionSafe'),
    grid: flag('grid'),
    centreMarks: flag('centreMarks'),
    rulers: flag('rulers'),
    canvasBorder: flag('canvasBorder'),
    pixelGrid: flag('pixelGrid'),
    showPerformanceStats: flag('showPerformanceStats'),
    background: background ?? defaults.background,
    previewAspect: previewAspect ?? defaults.previewAspect,
    guides: guides.map((guide) => ({ axis: guide.axis, position: guide.position })),
  };
}
