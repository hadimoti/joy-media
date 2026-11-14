import { describe, expect, it } from 'vitest';
import { listBuiltinEffects } from '@joy-media/visual-effects';
import {
  allLibraryEffectIds,
  EFFECT_CATEGORIES,
  effectEffectIds,
  FILTER_CATEGORIES,
  filterEffectIds,
  libraryCategoryOf,
  libraryHomeOf,
  MOVED_TO_EFFECTS,
} from './library-homes.js';

describe('one home for each library item (T-V06)', () => {
  it('shows no id in both panels', () => {
    const filters = new Set(filterEffectIds());
    for (const id of effectEffectIds()) expect(filters.has(id)).toBe(false);
  });

  it('gives every registry id exactly one home', () => {
    const registryIds = listBuiltinEffects()
      .map((descriptor) => descriptor.id)
      .sort();
    expect([...allLibraryEffectIds()].sort()).toEqual(registryIds);
  });

  it('keeps fifteen filters and eighteen effects', () => {
    expect(filterEffectIds()).toHaveLength(15);
    expect(effectEffectIds()).toHaveLength(18);
  });

  it('moves the five drawn styles to Effects', () => {
    expect([...MOVED_TO_EFFECTS].sort()).toEqual([
      'contour-map',
      'glyph-matrix',
      'halftone',
      'pixel-sort',
      'scatter-mosaic',
    ]);
    for (const id of MOVED_TO_EFFECTS) expect(libraryHomeOf(id)).toBe('effects');
  });

  it('keeps the other fifteen doubles in Filters', () => {
    for (const id of [
      'gaussian-blur',
      'zoom-blur',
      'radial-blur',
      'tilt-shift',
      'bloom',
      'glow',
      'noise',
      'pixelate',
      'bayer-dither',
      'posterize',
      'monochrome',
      'vignette',
      'sepia',
      'hue-saturation',
      'vibrance',
    ])
      expect(libraryHomeOf(id)).toBe('filters');
  });

  it('lists every id once inside its own panel', () => {
    for (const category of [...FILTER_CATEGORIES, ...EFFECT_CATEGORIES]) {
      expect(new Set(category.effectIds).size, category.label).toBe(category.effectIds.length);
      for (const id of category.effectIds)
        expect(libraryCategoryOf(id)?.label, id).toBe(category.label);
    }
  });

  it('keeps the two tone tools in Effects', () => {
    for (const id of ['brightness-contrast', 'curves']) expect(libraryHomeOf(id)).toBe('effects');
  });

  it('names the moved items in the Effects categories that hold them', () => {
    expect(libraryCategoryOf('halftone')?.label).toBe('Drawn & Printed');
    expect(libraryCategoryOf('pixel-sort')?.label).toBe('Distort & Move');
    expect(libraryCategoryOf('scatter-mosaic')?.label).toBe('Distort & Move');
    expect(libraryCategoryOf('contour-map')?.label).toBe('Drawn & Printed');
    expect(libraryCategoryOf('glyph-matrix')?.label).toBe('Drawn & Printed');
  });
});
