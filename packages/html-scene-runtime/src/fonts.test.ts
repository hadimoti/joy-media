import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { loadNotoSansArabicFaces, notoSansArabicFontCss } from './fonts.js';
import { missingCanonicalFontCodePoints } from './font-coverage.js';

function base128(value: number): Buffer {
  const bytes = [value & 0x7f];
  value >>>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  return Buffer.from(bytes);
}

function woff2WithCmap(cmap: Buffer): Buffer {
  const maxp = Buffer.alloc(6);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(16, 4);
  const stream = Buffer.concat([cmap, maxp]);
  const compressed = brotliCompressSync(stream);
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'ascii');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(
    header.length +
      2 +
      base128(cmap.length).length +
      base128(maxp.length).length +
      compressed.length,
    8,
  );
  header.writeUInt16BE(2, 12);
  header.writeUInt32BE(stream.length, 16);
  header.writeUInt32BE(compressed.length, 20);
  return Buffer.concat([header, Buffer.from([0, cmap.length, 4, maxp.length]), compressed]);
}

function woff2WithoutCmap(): Buffer {
  const payload = Buffer.from([0x12]);
  const compressed = brotliCompressSync(payload);
  const directory = Buffer.concat([Buffer.from([0x3f]), Buffer.from('TEST'), Buffer.from([1])]);
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'ascii');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(header.length + directory.length + compressed.length, 8);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(payload.length, 16);
  header.writeUInt32BE(compressed.length, 20);
  return Buffer.concat([header, directory, compressed]);
}

function cmapFormat4WithMalformedSegments(): Buffer {
  const cmap = Buffer.alloc(12 + 24 + 8);
  cmap.writeUInt16BE(0, 0);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(3, 4);
  cmap.writeUInt16BE(1, 6);
  cmap.writeUInt32BE(12, 8);
  cmap.writeUInt16BE(4, 12);
  cmap.writeUInt16BE(32, 14);
  cmap.writeUInt16BE(0, 16);
  cmap.writeUInt16BE(4, 18);
  cmap.writeUInt16BE(2, 20);
  cmap.writeUInt16BE(0, 22);
  cmap.writeUInt16BE(0, 24);
  cmap.writeUInt16BE(0, 26);
  cmap.writeUInt16BE(1, 26);
  cmap.writeUInt16BE(0, 28);
  cmap.writeUInt16BE(2, 30);
  cmap.writeUInt16BE(0, 32);
  cmap.writeUInt16BE(0, 34);
  return cmap;
}

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

describe('canonical Noto Sans Arabic coverage', () => {
  const arabic400 = loadNotoSansArabicFaces().find(
    (face) => face.subset === 'arabic' && face.weight === 400,
  )!;

  it('covers the required Persian letters with the bundled Arabic 400 face', () => {
    const text = 'پچژکگی';
    expect(missingCanonicalFontCodePoints(arabic400, text)).toEqual([]);
  });

  it('reports emoji absent from a Latin string', () => {
    const latin400 = loadNotoSansArabicFaces().find(
      (face) => face.subset === 'latin' && face.weight === 400,
    )!;
    expect(missingCanonicalFontCodePoints(latin400, 'Hello 😀')).toEqual([0x1f600]);
  });

  it('rejects a truncated WOFF2 file', () => {
    expect(() =>
      missingCanonicalFontCodePoints({ ...arabic400, bytes: arabic400.bytes.slice(0, 24) }, 'x'),
    ).toThrow(/truncated WOFF2/i);
  });

  it('rejects a WOFF2 directory without cmap', () => {
    const noCmap = woff2WithoutCmap();
    expect(() => missingCanonicalFontCodePoints({ ...arabic400, bytes: noCmap }, 'x')).toThrow(
      /cmap/i,
    );
  });

  it('rejects malformed cmap format 4 segments', () => {
    const bytes = woff2WithCmap(cmapFormat4WithMalformedSegments());
    expect(() => missingCanonicalFontCodePoints({ ...arabic400, bytes }, 'x')).toThrow(/cmap/i);
  });
});
