import { describe, expect, it } from 'vitest';
import { listBuiltinEffects } from '@joy-media/visual-effects';
import {
  allLibraryEffectIds,
  EFFECT_CATEGORIES,
  EFFECT_PANEL_RULE,
  effectEffectIds,
  FILTER_CATEGORIES,
  FILTER_PANEL_RULE,
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

  it('states the Filter or Effect rule in one line per panel', () => {
    expect(FILTER_PANEL_RULE).toMatch(/^A Filter changes the look of the picture/);
    expect(EFFECT_PANEL_RULE).toMatch(
      /^An Effect changes the shape, motion or marks of the picture/,
    );
    expect(FILTER_PANEL_RULE.split('\n')).toHaveLength(1);
    expect(EFFECT_PANEL_RULE.split('\n')).toHaveLength(1);
  });

  it('pins the Effect rule to the tone tools Effects keeps, by their registry names', () => {
    const labels = new Map(
      listBuiltinEffects().map((descriptor) => [descriptor.id, descriptor.label]),
    );
    for (const id of ['brightness-contrast', 'curves']) {
      expect(libraryHomeOf(id)).toBe('effects');
      expect(EFFECT_PANEL_RULE).toContain(labels.get(id) ?? '');
    }
    expect(EFFECT_PANEL_RULE).toContain('Brightness / Contrast, Curves');
    expect(EFFECT_PANEL_RULE).not.toMatch(/breaks the image|draws new marks/);
  });

  it('names the moved items in the Effects categories that hold them', () => {
    expect(libraryCategoryOf('halftone')?.label).toBe('Drawn & Printed');
    expect(libraryCategoryOf('pixel-sort')?.label).toBe('Distort & Move');
    expect(libraryCategoryOf('scatter-mosaic')?.label).toBe('Distort & Move');
    expect(libraryCategoryOf('contour-map')?.label).toBe('Drawn & Printed');
    expect(libraryCategoryOf('glyph-matrix')?.label).toBe('Drawn & Printed');
  });
});
