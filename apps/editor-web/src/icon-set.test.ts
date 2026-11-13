import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-D09 — one icon set.
 *
 * The app draws its icons from one outline set: 16 px on a 16 px grid, a
 * 1.5 px stroke, in the secondary text colour. A glyph character standing in
 * for an icon breaks that rule, because no two glyphs carry the same weight:
 * the emoji font draws its own.
 */

/**
 * The characters Unicode marks as emoji: the pictograph blocks, the symbol
 * blocks, and the dingbats that carry an emoji presentation. The plain
 * multiplication sign, the plain check mark and the plain cross are ordinary
 * typography, so they are left out on purpose.
 */
const EMOJI_PATTERN =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2B00}-\u{2BFF}\u{2705}\u{2708}\u{2709}\u{270A}\u{270B}\u{270C}\u{270D}\u{270F}\u{2712}\u{2714}\u{2716}\u{271D}\u{2721}\u{2728}\u{2733}\u{2734}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2795}-\u{2797}\u{27B0}\u{27BF}]/u;

/** The two invisible marks that turn a plain sign into an emoji. */
const EMOJI_JOINER_PATTERN = /[\u{FE0F}\u{200D}]/u;

/** Every source file of the app, apart from the tests themselves. */
const sources = (): readonly { file: string; source: string }[] => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const found: { file: string; source: string }[] = [];
  const walk = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${folder}/${entry.name}`, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
        found.push({
          file: `${prefix}${entry.name}`,
          source: readFileSync(`${folder}/${entry.name}`, 'utf8'),
        });
      }
    }
  };
  walk(here, '');
  return found;
};

describe('the one icon set (T-D09)', () => {
  it('holds no emoji character in the app', () => {
    const offenders: string[] = [];

    for (const { file, source } of sources()) {
      const found: string[] = [];
      for (const character of source) {
        if (EMOJI_PATTERN.test(character) || EMOJI_JOINER_PATTERN.test(character)) {
          found.push(`${character} (U+${character.codePointAt(0)?.toString(16).toUpperCase()})`);
        }
      }
      if (found.length > 0) offenders.push(`${file}: ${found.join(', ')}`);
    }

    expect(offenders, 'the app draws its icons from the shared outline set').toEqual([]);
  });

  it('draws the shared set on one grid with one weight', () => {
    const icons = readFileSync(fileURLToPath(new URL('./icons.tsx', import.meta.url)), 'utf8');
    const helper = icons.slice(
      icons.indexOf('function Svg('),
      icons.indexOf('function PngMaskIcon('),
    );

    expect(helper).toContain('viewBox="0 0 16 16"');
    expect(helper).toContain('stroke="currentColor"');
    expect(helper).toContain('strokeWidth="1.5"');
    expect(helper).toContain('strokeLinecap="round"');
    expect(helper).toContain('strokeLinejoin="round"');
    expect(helper).toContain('aria-hidden="true"');
  });
});
