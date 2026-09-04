import { describe, expect, it } from 'vitest';
import { CONTENT_FONT_FAMILIES, PACKAGE_NAME, canonicalizeContentFontFamily } from './index.js';

describe('@joy-media/project-schema scaffold', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@joy-media/project-schema');
  });

  it('exports canonical content font helpers', () => {
    expect(CONTENT_FONT_FAMILIES).toContain('Vazirmatn Variable');
    expect(canonicalizeContentFontFamily('Yekan Bakh')).toBe('Vazirmatn Variable');
  });
});
