import type { ExportPresetId } from '@joy-media/project-schema';
import { EXPORT_PRESETS, type CanvasSize } from './export-presets.js';

/** The format choices the New project form offers, in the order they are shown. */
export type NewProjectFormatId =
  'youtube-16-9' | 'reels-9-16' | 'square-1-1' | 'feed-4-5' | 'custom';

export interface NewProjectFormatChoice {
  readonly id: NewProjectFormatId;
  /** Name shown on the tile, e.g. "YouTube 16:9". */
  readonly label: string;
  /** Canvas for the tile; undefined for Custom, which asks for its own size. */
  readonly size: CanvasSize | undefined;
  readonly presetId: ExportPresetId;
}

/** What the New project form hands to project creation. */
export interface NewProjectSpec {
  readonly canvas: CanvasSize;
  readonly presetId: ExportPresetId;
}

/** Custom canvas sides are whole pixels between these limits (8K is the top). */
export const CUSTOM_CANVAS_MIN_SIDE = 16;
export const CUSTOM_CANVAS_MAX_SIDE = 7680;

export const NEW_PROJECT_FORMATS: readonly NewProjectFormatChoice[] = [
  {
    id: 'youtube-16-9',
    label: 'YouTube 16:9',
    size: { width: 1920, height: 1080 },
    presetId: 'youtube-1080',
  },
  {
    id: 'reels-9-16',
    label: 'Reels and Shorts 9:16',
    size: { width: 1080, height: 1920 },
    presetId: 'reels-1080',
  },
  {
    id: 'square-1-1',
    label: 'Square 1:1',
    size: { width: 1080, height: 1080 },
    presetId: 'square-1080',
  },
  {
    id: 'feed-4-5',
    label: 'Feed 4:5',
    size: { width: 1080, height: 1350 },
    presetId: 'instagram-feed-4x5',
  },
  { id: 'custom', label: 'Custom', size: undefined, presetId: 'custom' },
];

/** The default selection: 16:9 at 1920×1080. */
export const DEFAULT_NEW_PROJECT_FORMAT_ID: NewProjectFormatId = 'youtube-16-9';

/** Size the Custom fields start from. */
export const CUSTOM_DEFAULT_CANVAS: CanvasSize = Object.freeze({ width: 1920, height: 1080 });

export function newProjectFormatChoice(id: NewProjectFormatId): NewProjectFormatChoice {
  const choice = NEW_PROJECT_FORMATS.find((format) => format.id === id);
  if (choice === undefined) throw new Error(`unknown new-project format "${id}"`);
  return choice;
}

/** The preset name shown under a tile, e.g. "YouTube · 1080p". */
export function newProjectPresetLabel(choice: NewProjectFormatChoice): string {
  return EXPORT_PRESETS[choice.presetId].label;
}

/** Reads the two Custom fields. Whole numbers only; returns an error sentence otherwise. */
export function parseCustomCanvas(
  widthText: string,
  heightText: string,
): { readonly canvas: CanvasSize } | { readonly error: string } {
  const width = parseSide(widthText);
  const height = parseSide(heightText);
  if (width === undefined || height === undefined) {
    return {
      error: `Enter a width and a height from ${CUSTOM_CANVAS_MIN_SIDE} to ${CUSTOM_CANVAS_MAX_SIDE} pixels.`,
    };
  }
  return { canvas: { width, height } };
}

function parseSide(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (value < CUSTOM_CANVAS_MIN_SIDE || value > CUSTOM_CANVAS_MAX_SIDE) return undefined;
  return value;
}

/** Resolves a tile, or the Custom fields, to the canvas and preset a new project gets. */
export function newProjectSpecFor(
  id: NewProjectFormatId,
  customWidth: string,
  customHeight: string,
): NewProjectSpec | { readonly error: string } {
  const choice = newProjectFormatChoice(id);
  if (choice.size !== undefined) return { canvas: { ...choice.size }, presetId: choice.presetId };
  const custom = parseCustomCanvas(customWidth, customHeight);
  if ('error' in custom) return custom;
  return { canvas: custom.canvas, presetId: choice.presetId };
}
