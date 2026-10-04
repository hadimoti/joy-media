import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { missingFontCodePoints } from './font-cmap.js';
import { resolveTextFont } from './text-font.js';

describe('font cmap coverage', () => {
  it('reads format 4 BMP mappings and ignores whitespace', () => {
    expect(missingFontCodePoints(syntheticFont(4), 'A B')).toEqual([0x42]);
  });

  it('reads format 12 mappings, including supplementary code points', () => {
    expect(missingFontCodePoints(syntheticFont(12), '界😀')).toEqual([0x1f600]);
  });

  const installedFont = resolveTextFont();
  it.skipIf(!installedFont)(
    'reads actual installed font coverage without assuming glyph count',
    () => {
      const font = readFileSync(installedFont!);
      expect(missingFontCodePoints(font, 'Joy Media 2026')).toEqual([]);
      expect(missingFontCodePoints(font, '\u{10ffff}')).toEqual([0x10ffff]);
    },
  );
});

function syntheticFont(format: 4 | 12): Uint8Array {
  const tableOffset = 28;
  const subtableLength = format === 4 ? 32 : 28;
  const bytes = new Uint8Array(tableOffset + 12 + subtableLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, 1);
  bytes.set([0x63, 0x6d, 0x61, 0x70], 12);
  view.setUint32(20, tableOffset);
  view.setUint32(24, 12 + subtableLength);
  view.setUint16(tableOffset, 0);
  view.setUint16(tableOffset + 2, 1);
  view.setUint16(tableOffset + 4, 3);
  view.setUint16(tableOffset + 6, format === 12 ? 10 : 1);
  view.setUint32(tableOffset + 8, 12);
  const sub = tableOffset + 12;
  view.setUint16(sub, format);
  if (format === 12) {
    view.setUint32(sub + 4, subtableLength);
    view.setUint32(sub + 12, 1);
    view.setUint32(sub + 16, 0x754c);
    view.setUint32(sub + 20, 0x754c);
    view.setUint32(sub + 24, 1);
  } else {
    view.setUint16(sub + 2, subtableLength);
    view.setUint16(sub + 6, 4);
    view.setUint16(sub + 14, 0x41);
    view.setUint16(sub + 16, 0xffff);
    view.setUint16(sub + 18, 0);
    view.setUint16(sub + 20, 0x41);
    view.setUint16(sub + 22, 0xffff);
    view.setInt16(sub + 24, -0x40);
    view.setInt16(sub + 26, 1);
    view.setUint16(sub + 28, 0);
    view.setUint16(sub + 30, 0);
  }
  return bytes;
}
