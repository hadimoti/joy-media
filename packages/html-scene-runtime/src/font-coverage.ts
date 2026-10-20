import { brotliDecompressSync } from 'node:zlib';
import type { NotoSansArabicFace } from './fonts.js';

const MAX_COMPRESSED_SIZE = 32 * 1024 * 1024;
const MAX_TABLES = 128;
const MAX_TABLE_SIZE = 32 * 1024 * 1024;
const KNOWN_TAGS = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
];

interface TableRange {
  readonly tag: string;
  readonly offset: number;
  readonly length: number;
}

function fail(message: string): never {
  throw new Error(`Invalid canonical WOFF2 font: ${message}`);
}

function readBase128(bytes: Buffer, state: { offset: number }): number {
  let result = 0;
  for (let count = 0; count < 5; count += 1) {
    if (state.offset >= bytes.length) fail('truncated Base128 table length');
    const byte = bytes[state.offset++]!;
    if (count === 0 && byte === 0x80) fail('noncanonical Base128 table length');
    if (result & 0xfe000000) fail('Base128 table length overflows');
    result = (result << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return result;
  }
  return fail('Base128 table length exceeds five bytes');
}

function fontCmap(bytes: Uint8Array): { readonly cmap: Buffer; readonly glyphCount: number } {
  const font = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (font.length < 48) fail('truncated WOFF2 header');
  if (font.toString('ascii', 0, 4) !== 'wOF2') fail('bad WOFF2 signature');
  if (font.readUInt32BE(8) !== font.length) fail('declared WOFF2 length does not match data');
  if (font.readUInt32BE(4) === 0x74746366) fail('font collections are unsupported');
  if (font.readUInt16BE(14) !== 0) fail('WOFF2 reserved header field must be zero');
  const tableCount = font.readUInt16BE(12);
  const sfntSize = font.readUInt32BE(16);
  const compressedSize = font.readUInt32BE(20);
  if (tableCount === 0 || tableCount > MAX_TABLES) fail('malformed WOFF2 table count');
  if (sfntSize > MAX_COMPRESSED_SIZE || compressedSize > MAX_COMPRESSED_SIZE)
    fail('WOFF2 allocation bound exceeded');

  const state = { offset: 48 };
  const tables: TableRange[] = [];
  const tags = new Set<string>();
  let storedTotal = 0;
  for (let index = 0; index < tableCount; index += 1) {
    if (state.offset >= font.length) fail('truncated WOFF2 table directory');
    const flags = font[state.offset++]!;
    const tagIndex = flags & 0x3f;
    const transformVersion = flags >>> 6;
    let tag: string;
    if (tagIndex === 0x3f) {
      if (state.offset + 4 > font.length) fail('truncated custom table tag');
      tag = font.toString('ascii', state.offset, state.offset + 4);
      state.offset += 4;
    } else {
      const knownTag = KNOWN_TAGS[tagIndex];
      if (!knownTag) fail(`reserved WOFF2 table tag index ${tagIndex}`);
      tag = knownTag;
    }
    if (tags.has(tag)) fail(`duplicate WOFF2 table ${tag}`);
    tags.add(tag);
    const originalLength = readBase128(font, state);
    if (originalLength > MAX_TABLE_SIZE) fail(`table ${tag} exceeds the allocation bound`);
    const glyfTransform = (tag === 'glyf' || tag === 'loca') && transformVersion === 0;
    const hmtxTransform = tag === 'hmtx' && transformVersion === 1;
    const validTransformVersion =
      tag === 'glyf' || tag === 'loca'
        ? transformVersion === 0 || transformVersion === 3
        : tag === 'hmtx'
          ? transformVersion === 0 || transformVersion === 1
          : transformVersion === 0;
    if (!validTransformVersion)
      fail(`unsupported transformed ${tag} table (version ${transformVersion})`);
    const storedLength = glyfTransform || hmtxTransform ? readBase128(font, state) : originalLength;
    if (storedLength > MAX_TABLE_SIZE || storedTotal + storedLength > MAX_COMPRESSED_SIZE)
      fail(`table ${tag} exceeds the allocation bound`);
    tables.push({ tag, offset: storedTotal, length: storedLength });
    storedTotal += storedLength;
  }
  if (state.offset + compressedSize > font.length) fail('malformed WOFF2 compressed stream length');
  if (storedTotal === 0 || storedTotal > MAX_COMPRESSED_SIZE)
    fail('empty or oversized WOFF2 table stream');

  let stream: Buffer;
  try {
    stream = brotliDecompressSync(font.subarray(state.offset, state.offset + compressedSize), {
      maxOutputLength: MAX_COMPRESSED_SIZE,
    });
  } catch (error) {
    fail(
      `Brotli stream cannot be decompressed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (stream.length !== storedTotal) fail('decompressed WOFF2 table stream length mismatch');
  const cmap = tables.find((table) => table.tag === 'cmap');
  if (!cmap) fail('cmap table is missing');
  if (cmap.offset + cmap.length > stream.length) fail('cmap table extends beyond the font stream');
  const maxp = tables.find((table) => table.tag === 'maxp');
  if (!maxp || maxp.length < 6 || maxp.offset + maxp.length > stream.length)
    fail('maxp table is missing or truncated');
  const glyphCount = stream.readUInt16BE(maxp.offset + 4);
  if (glyphCount === 0) fail('maxp glyph count is zero');
  return {
    cmap: stream.subarray(cmap.offset, cmap.offset + cmap.length),
    glyphCount,
  };
}

function coveredCodePoints(cmap: Buffer, glyphCount: number): Set<number> {
  if (cmap.length < 4) fail('cmap header is truncated');
  const version = cmap.readUInt16BE(0);
  const count = cmap.readUInt16BE(2);
  if (version !== 0 || count === 0 || 4 + count * 8 > cmap.length)
    fail('malformed cmap encoding records');
  const tables = new Set<number>();
  for (let i = 0; i < count; i += 1) {
    const offset = cmap.readUInt32BE(4 + i * 8 + 4);
    if (offset + 2 > cmap.length) fail('cmap subtable offset is out of range');
    const format = cmap.readUInt16BE(offset);
    if (format !== 4 && format !== 12) continue;
    tables.add(offset);
  }
  if (tables.size === 0) fail('cmap has no supported format 4 or 12 subtable');

  const result = new Set<number>();
  for (const offset of tables) {
    const format = cmap.readUInt16BE(offset);
    if (format === 4) {
      if (offset + 14 > cmap.length) fail('cmap format 4 header is truncated');
      const length = cmap.readUInt16BE(offset + 2);
      const segCountX2 = cmap.readUInt16BE(offset + 6);
      if (length < 16 || offset + length > cmap.length || segCountX2 === 0 || segCountX2 % 2 !== 0)
        fail('malformed cmap format 4 length or segment count');
      const segments = segCountX2 / 2;
      const endStart = offset + 14;
      const startStart = endStart + segments * 2 + 2;
      const deltaStart = startStart + segments * 2;
      const rangeStart = deltaStart + segments * 2;
      if (rangeStart + segments * 2 > offset + length) fail('malformed cmap format 4 segments');
      let previousEnd = -1;
      for (let segment = 0; segment < segments; segment += 1) {
        const end = cmap.readUInt16BE(endStart + segment * 2);
        const start = cmap.readUInt16BE(startStart + segment * 2);
        const delta = cmap.readInt16BE(deltaStart + segment * 2);
        const rangeOffsetPosition = rangeStart + segment * 2;
        const rangeOffset = cmap.readUInt16BE(rangeOffsetPosition);
        if (start > end || start <= previousEnd) fail('malformed cmap format 4 segment ordering');
        previousEnd = end;
        for (let codePoint = start; codePoint <= end && codePoint !== 0xffff; codePoint += 1) {
          let glyph: number;
          if (rangeOffset === 0) {
            glyph = (codePoint + delta) & 0xffff;
          } else {
            const glyphPosition = rangeOffsetPosition + rangeOffset + (codePoint - start) * 2;
            if (glyphPosition + 2 > offset + length)
              fail('cmap format 4 glyph array is out of range');
            const glyphIndex = cmap.readUInt16BE(glyphPosition);
            glyph = glyphIndex === 0 ? 0 : (glyphIndex + delta) & 0xffff;
          }
          if (glyph >= glyphCount) fail('cmap format 4 glyph ID exceeds maxp glyph count');
          if (glyph !== 0) result.add(codePoint);
        }
      }
    } else {
      if (offset + 16 > cmap.length) fail('cmap format 12 header is truncated');
      const length = cmap.readUInt32BE(offset + 4);
      const groups = cmap.readUInt32BE(offset + 12);
      if (
        length < 16 ||
        offset + length > cmap.length ||
        groups > 1_000_000 ||
        16 + groups * 12 > length
      )
        fail('malformed cmap format 12 groups');
      let previousEnd = -1;
      for (let group = 0; group < groups; group += 1) {
        const record = offset + 16 + group * 12;
        const start = cmap.readUInt32BE(record);
        const end = cmap.readUInt32BE(record + 4);
        const startGlyph = cmap.readUInt32BE(record + 8);
        if (start > end || start <= previousEnd || end > 0x10ffff)
          fail('malformed cmap format 12 group ordering');
        if (startGlyph + end - start >= glyphCount)
          fail('cmap format 12 glyph IDs exceed maxp glyph count');
        previousEnd = end;
        for (let codePoint = start; codePoint <= end; codePoint += 1) {
          if (startGlyph + codePoint - start !== 0) result.add(codePoint);
        }
      }
    }
  }
  return result;
}

/** Returns non-control Unicode code points missing from the selected canonical face. */
export function missingCanonicalFontCodePoints(
  face: Pick<NotoSansArabicFace, 'bytes'>,
  text: string,
): number[] {
  const { cmap, glyphCount } = fontCmap(face.bytes);
  const coverage = coveredCodePoints(cmap, glyphCount);
  const missing = new Set<number>();
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      codePoint === 0x20 ||
      codePoint === 0x200c ||
      codePoint === 0x200d
    )
      continue;
    if (!coverage.has(codePoint)) missing.add(codePoint);
  }
  return [...missing].sort((a, b) => a - b);
}
