import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadNotoSansArabicLibassFaces, notoSansArabicArabic400Path } from './fonts.js';

/** The Windows ascent and descent from a TrueType face's OS/2 table. */
function windowsMetrics(bytes: Buffer): { ascent: number; descent: number } {
  for (let index = 0; index < bytes.readUInt16BE(4); index += 1) {
    const record = 12 + index * 16;
    if (bytes.toString('latin1', record, record + 4) === 'OS/2') {
      const offset = bytes.readUInt32BE(record + 8);
      return { ascent: bytes.readUInt16BE(offset + 74), descent: bytes.readUInt16BE(offset + 76) };
    }
  }
  throw new Error('OS/2 table is missing');
}

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

  it('sets the Windows metrics that make libass draw captions at the requested size, as Arial does', () => {
    for (const face of loadNotoSansArabicLibassFaces()) {
      expect(windowsMetrics(face.bytes)).toEqual({ ascent: 905, descent: 212 });
    }
  });

  it('points the caption renderer at the TrueType face, not the WOFF2 file', () => {
    expect(notoSansArabicArabic400Path()).toMatch(
      /[\\/]libass[\\/]fonts[\\/]noto-sans-arabic-arabic-400-normal\.ttf$/,
    );
  });
});
