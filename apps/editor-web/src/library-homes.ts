/**
 * One home for each library item (T-V06).
 *
 * The Filters and the Effects panels used to show the same twenty items in
 * both. The rule from the library audit (T-V01, signed off as "List A") puts
 * every id in exactly one panel:
 *
 * - A **Filter** changes the look of the picture: colour, softness, grain,
 *   glow. The pixels stay where they are.
 * - An **Effect** changes the picture itself: it bends or moves the pixels,
 *   breaks the image, or draws new marks over it.
 *
 * The registry ids do not change, so an old project that uses a moved item
 * still renders exactly as it did. Only the panel that shows the item moves.
 *
 * The category names below are the panel's own; the registry keeps its own
 * `category` field for the effect machinery.
 */

import type { EffectDescriptor } from '@joy-media/visual-effects';

/** Which panel owns an item. */
export type LibraryPanelId = 'filters' | 'effects';

export type FilterCategoryId =
  'black-white' | 'blur-focus' | 'grain-texture' | 'light-glow' | 'tone-colour';

export type EffectCategoryId =
  | 'colour-light'
  | 'depth-shadow'
  | 'distort-move'
  | 'drawn-printed'
  | 'edge-detail'
  | 'retro-screen';

/** A group of items inside one panel. */
export interface LibraryCategory {
  readonly id: string;
  readonly label: string;
  readonly effectIds: readonly string[];
}

/** Filters — 15 items in 5 categories, sorted. */
export const FILTER_CATEGORIES: readonly LibraryCategory[] = [
  { id: 'black-white', label: 'Black & White', effectIds: ['monochrome', 'bayer-dither'] },
  {
    id: 'blur-focus',
    label: 'Blur & Focus',
    effectIds: ['gaussian-blur', 'zoom-blur', 'radial-blur', 'tilt-shift'],
  },
  { id: 'grain-texture', label: 'Grain & Texture', effectIds: ['noise', 'pixelate'] },
  { id: 'light-glow', label: 'Light & Glow', effectIds: ['bloom', 'glow'] },
  {
    id: 'tone-colour',
    label: 'Tone & Colour',
    effectIds: ['hue-saturation', 'vibrance', 'sepia', 'posterize', 'vignette'],
  },
];

/** Effects — 18 items in 6 categories, sorted. */
export const EFFECT_CATEGORIES: readonly LibraryCategory[] = [
  {
    id: 'colour-light',
    label: 'Colour & Light',
    effectIds: ['brightness-contrast', 'color-overlay', 'curves'],
  },
  { id: 'depth-shadow', label: 'Depth & Shadow', effectIds: ['drop-shadow'] },
  {
    id: 'distort-move',
    label: 'Distort & Move',
    effectIds: ['bulge', 'twist', 'ripple', 'pixel-sort', 'scatter-mosaic'],
  },
  {
    id: 'drawn-printed',
    label: 'Drawn & Printed',
    effectIds: ['tone-geometry', 'halftone', 'contour-map', 'glyph-matrix'],
  },
  {
    id: 'edge-detail',
    label: 'Edge & Detail',
    effectIds: ['edge-detect', 'emboss', 'unsharp-mask'],
  },
  { id: 'retro-screen', label: 'Retro & Screen', effectIds: ['crt', 'mosaic'] },
];

/** The filter ids by category (the shape the Filters panel used before). */
export const FILTER_LIBRARY: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  FILTER_CATEGORIES.map((category) => [category.id, category.effectIds]),
);

/** The effect ids by category. */
export const EFFECT_LIBRARY: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  EFFECT_CATEGORIES.map((category) => [category.id, category.effectIds]),
);

/** The one line each panel shows under its title. */
export const FILTER_PANEL_RULE =
  'A Filter changes the look of the picture — colour, softness, grain, glow. The pixels stay where they are.';
export const EFFECT_PANEL_RULE =
  'An Effect changes the picture itself — it moves the pixels, breaks the image, or draws new marks over it.';

/**
 * The five doubles that move to Effects. Their registry ids do not change, so
 * a project that uses one of them keeps rendering exactly as before.
 */
export const MOVED_TO_EFFECTS: readonly string[] = [
  'halftone',
  'scatter-mosaic',
  'contour-map',
  'glyph-matrix',
  'pixel-sort',
];

const FILTER_IDS: readonly string[] = FILTER_CATEGORIES.flatMap((category) => category.effectIds);
const EFFECT_IDS: readonly string[] = EFFECT_CATEGORIES.flatMap((category) => category.effectIds);

/** Every id the Filters panel shows. */
export function filterEffectIds(): readonly string[] {
  return FILTER_IDS;
}

/** Every id the Effects panel shows. */
export function effectEffectIds(): readonly string[] {
  return EFFECT_IDS;
}

/** Every id in the library, in either panel. */
export function allLibraryEffectIds(): readonly string[] {
  return [...FILTER_IDS, ...EFFECT_IDS];
}

/** The panel an item lives in, or undefined when the id is not in the library. */
export function libraryHomeOf(effectId: string): LibraryPanelId | undefined {
  if (FILTER_IDS.includes(effectId)) return 'filters';
  if (EFFECT_IDS.includes(effectId)) return 'effects';
  return undefined;
}

/** The category an item sits in, in either panel. */
export function libraryCategoryOf(effectId: string): LibraryCategory | undefined {
  return [...FILTER_CATEGORIES, ...EFFECT_CATEGORIES].find((category) =>
    category.effectIds.includes(effectId),
  );
}

/** Does an item match what the owner typed? */
export function matchesLibraryQuery(descriptor: EffectDescriptor, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    descriptor.label.toLowerCase().includes(needle) ||
    descriptor.id.toLowerCase().includes(needle) ||
    descriptor.description?.toLowerCase().includes(needle) === true ||
    descriptor.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
}
