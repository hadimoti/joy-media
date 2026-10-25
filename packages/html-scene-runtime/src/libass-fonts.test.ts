import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadNotoSansArabicLibassFaces, notoSansArabicArabic400Path } from './fonts.js';

describe('Noto Sans Arabic libass faces', () => {
  it('ships TrueType faces whose bytes match their pinned digests', () => {
    const faces = loadNotoSansArabicLibassFaces();
    expect(faces.map(({ weight, subset }) => `${subset}-${weight}`)).toEqual([
      'arabic-400',
      'arabic-700',
      'latin-400',
      'latin-700',
    ]);
    for (const face of faces) {
      expect(face.bytes.subarray(0, 4).toString('hex')).toBe('00010000');
      expect(`sha256:${createHash('sha256').update(face.bytes).digest('hex')}`).toBe(face.sha256);
    }
  });

  it('points the caption renderer at the TrueType face, not the WOFF2 file', () => {
    expect(notoSansArabicArabic400Path()).toMatch(
      /[\\/]libass[\\/]fonts[\\/]noto-sans-arabic-arabic-400-normal\.ttf$/,
    );
  });
});
