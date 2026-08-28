/**
 * Deterministic text layout primitives shared by the software preview and
 * headless golden renderers.
 *
 * Render IR carries logical text plus a resolved base direction. This helper
 * performs the Unicode Bidirectional Algorithm ordering pass needed by the
 * golden bitmap adapters. Production browser/libass renderers still perform
 * their own full shaping; this pass keeps the two software paths honest and
 * identical for the same IR.
 */

import bidiFactory from 'bidi-js';

export interface VisualTextGlyph {
  readonly character: string;
  /** Index into Array.from(logicalText), used to resolve span colours. */
  readonly sourceIndex: number;
}

/**
 * Returns the Unicode-bidi visual sequence for a resolved base direction.
 * `bidi-js` works in UTF-16 indices, while Render IR glyphs are code points;
 * the explicit spans below bridge those index spaces without splitting a
 * surrogate pair and retain each glyph's logical source index.
 */
export function visualTextGlyphs(
  logicalText: string,
  direction: 'ltr' | 'rtl' = 'ltr',
): readonly VisualTextGlyph[] {
  const processor = bidiFactory();
  const characters: IndexedGlyph[] = [];
  let utf16Index = 0;
  for (const [sourceIndex, character] of Array.from(logicalText).entries()) {
    const start = utf16Index;
    utf16Index += character.length;
    characters.push({ character, sourceIndex, start, end: utf16Index - 1 });
  }
  const embeddingLevels = processor.getEmbeddingLevels(logicalText, direction);
  const reordered = [...characters];
  for (const [start, end] of processor.getReorderSegments(logicalText, embeddingLevels)) {
    const indexes = reordered
      .map((glyph, index) => (glyph.end >= start && glyph.start <= end ? index : -1))
      .filter((index) => index >= 0);
    for (let left = 0, right = indexes.length - 1; left < right; left += 1, right -= 1) {
      const leftIndex = indexes[left]!;
      const rightIndex = indexes[right]!;
      [reordered[leftIndex], reordered[rightIndex]] = [
        reordered[rightIndex]!,
        reordered[leftIndex]!,
      ];
    }
  }
  const mirrored = processor.getMirroredCharactersMap(logicalText, embeddingLevels.levels);
  return reordered.map(({ character, sourceIndex, start }) => ({
    character: mirrored.get(start) ?? character,
    sourceIndex,
  }));
}

interface IndexedGlyph extends VisualTextGlyph {
  readonly start: number;
  readonly end: number;
}

/** Pinned bitmap glyphs used by the original JOY parity fixture. */
export const PINNED_TEXT_GLYPHS: Readonly<Record<string, readonly string[]>> = {
  J: ['011', '001', '001', '101', '010'],
  O: ['010', '101', '101', '101', '010'],
  Y: ['101', '101', '010', '010', '010'],
};

export function pinnedTextGlyph(
  character: string,
  column: number,
  row: number,
): boolean | undefined {
  const bitmap = PINNED_TEXT_GLYPHS[character];
  return bitmap === undefined ? undefined : bitmap[row]?.[column] === '1';
}
