import { describe, expect, it } from 'vitest';
import {
  CANONICAL_CONTENT_FONT_ALIASES,
  CONTENT_FONT_FAMILIES,
  canonicalizeContentFontFamily,
  isContentFontFamily,
} from './content-fonts.js';

describe('canonical content fonts', () => {
  it('publishes the code-owned font catalog', () => {
    expect(CONTENT_FONT_FAMILIES).toContain('YekanBakh');
    expect(CONTENT_FONT_FAMILIES).toContain('Vazin');
    expect(CONTENT_FONT_FAMILIES).not.toContain('Yekan Bakh');
    expect(CONTENT_FONT_FAMILIES).not.toContain('Vazirmatn');
  });

  it('normalizes legacy aliases while preserving unknown values', () => {
    expect(canonicalizeContentFontFamily('Yekan Bakh')).toBe('YekanBakh');
    expect(canonicalizeContentFontFamily('Vazirmatn')).toBe('Vazin');
    expect(canonicalizeContentFontFamily('  Vazin ')).toBe('Vazin');
    expect(canonicalizeContentFontFamily('Custom Font')).toBe('Custom Font');
    expect(CANONICAL_CONTENT_FONT_ALIASES['Yekan Bakh']).toBe('YekanBakh');
  });

  it('accepts only catalog families at the schema boundary', () => {
    expect(isContentFontFamily('YekanBakh')).toBe(true);
    expect(isContentFontFamily('Vazirmatn')).toBe(false);
    expect(isContentFontFamily('system-ui')).toBe(true);
    expect(isContentFontFamily('')).toBe(false);
    expect(isContentFontFamily(undefined)).toBe(false);
  });
});
