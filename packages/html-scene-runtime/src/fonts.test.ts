import { describe, expect, it } from 'vitest';
import { loadNotoSansArabicFaces, notoSansArabicFontCss } from './fonts.js';

describe('Noto Sans Arabic font assets', () => {
  it('loads all canonical faces with verified bytes', () => {
    const faces = loadNotoSansArabicFaces();

    expect(faces.map(({ weight, subset }) => `${subset}-${weight}`)).toEqual([
      'arabic-400',
      'arabic-700',
      'latin-400',
      'latin-700',
    ]);
    expect(faces.every(({ bytes }) => bytes.byteLength > 0)).toBe(true);
    expect(faces.every(({ sha256 }) => /^sha256:[a-f0-9]{64}$/.test(sha256))).toBe(true);
  });

  it('builds CSS from the verified font bytes', () => {
    const faces = loadNotoSansArabicFaces();
    const css = notoSansArabicFontCss(faces);

    expect(css.match(/@font-face/g)).toHaveLength(4);
    expect(css).toContain("font-family:'Noto Sans Arabic'");
    expect(css).toContain("format('woff2')");
  });
});
