import { describe, expect, it } from 'vitest';
import {
  CANONICAL_CONTENT_FONT_ALIASES,
  CONTENT_FONT_CATALOG,
  CONTENT_FONT_FAMILIES,
  canonicalizeContentFontFamily,
  isContentFontFamily,
  resolveContentFontFamily,
} from './content-fonts.js';

describe('canonical content fonts', () => {
  it('publishes only the local redistribution-safe font catalog', () => {
    expect(CONTENT_FONT_FAMILIES).toEqual([
      'Vazirmatn Variable',
      'Noto Sans Arabic',
      'Noto Naskh Arabic',
      'Inter Variable',
      'system-ui',
    ]);
    expect(
      CONTENT_FONT_CATALOG.every(
        (font) => font.license === 'OFL-1.1' || font.family === 'system-ui',
      ),
    ).toBe(true);
    expect(CONTENT_FONT_FAMILIES).not.toContain('YekanBakh');
    expect(CONTENT_FONT_FAMILIES).not.toContain('Vazin');
  });

  it('normalizes legacy aliases while preserving unknown values', () => {
    expect(canonicalizeContentFontFamily('Yekan Bakh')).toBe('Vazirmatn Variable');
    expect(canonicalizeContentFontFamily('YekanBakh')).toBe('Vazirmatn Variable');
    expect(canonicalizeContentFontFamily('Vazirmatn')).toBe('Vazirmatn Variable');
    expect(canonicalizeContentFontFamily('  Vazin ')).toBe('Vazirmatn Variable');
    expect(canonicalizeContentFontFamily('Modam Pro')).toBe('Inter Variable');
    expect(canonicalizeContentFontFamily('Custom Font')).toBe('Custom Font');
    expect(CANONICAL_CONTENT_FONT_ALIASES['Yekan Bakh']).toBe('Vazirmatn Variable');
    expect(resolveContentFontFamily('missing-font')).toBe('Vazirmatn Variable');
  });

  it('accepts catalog families and legacy aliases at the schema boundary', () => {
    expect(isContentFontFamily('YekanBakh')).toBe(true);
    expect(isContentFontFamily('Vazirmatn')).toBe(true);
    expect(isContentFontFamily('Noto Naskh Arabic')).toBe(true);
    expect(isContentFontFamily('system-ui')).toBe(true);
    expect(isContentFontFamily('')).toBe(false);
    expect(isContentFontFamily(undefined)).toBe(false);
  });
});
