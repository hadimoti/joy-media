// Lossless WOFF2 to TrueType conversion, following the W3C WOFF2 specification (sections 5 and 6).
//
// Only Node's built-in Brotli decoder is used. A file that the specification forbids throws Woff2Error. Nothing is
// guessed, and nothing is repaired. Font outlines are reconstructed exactly; the output is an ordinary sfnt file.
import { brotliDecompressSync } from 'node:zlib';

export class Woff2Error extends Error {
  constructor(message) {
    super(`WOFF2: ${message}`);
    this.name = 'Woff2Error';
  }
}

const SIGNATURE = 0x774f4632;
const COLLECTION_FLAVOR = 0x74746366;

// Known table tags, indexed by the low six bits of a directory flags byte (WOFF2 spec, "Known Table Tags").
export const KNOWN_TAGS = [
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

// Triplet encoding of glyph coordinates (WOFF2 spec, section 5.2), one row per flag index:
// [byteCount, xBits, yBits, deltaX, deltaY, xSign, ySign]. byteCount includes the flag byte. A sign of 1 is
// positive, -1 negative, and 0 where the coordinate has no bits. Rows were read from the specification's table.
export const TRIPLETS = [
  [2, 0, 8, 0, 0, 0, -1],
  [2, 0, 8, 0, 0, 0, 1],
  [2, 0, 8, 0, 256, 0, -1],
  [2, 0, 8, 0, 256, 0, 1],
  [2, 0, 8, 0, 512, 0, -1],
  [2, 0, 8, 0, 512, 0, 1],
  [2, 0, 8, 0, 768, 0, -1],
  [2, 0, 8, 0, 768, 0, 1],
  [2, 0, 8, 0, 1024, 0, -1],
  [2, 0, 8, 0, 1024, 0, 1],
  [2, 8, 0, 0, 0, -1, 0],
  [2, 8, 0, 0, 0, 1, 0],
  [2, 8, 0, 256, 0, -1, 0],
  [2, 8, 0, 256, 0, 1, 0],
  [2, 8, 0, 512, 0, -1, 0],
  [2, 8, 0, 512, 0, 1, 0],
  [2, 8, 0, 768, 0, -1, 0],
  [2, 8, 0, 768, 0, 1, 0],
  [2, 8, 0, 1024, 0, -1, 0],
  [2, 8, 0, 1024, 0, 1, 0],
  [2, 4, 4, 1, 1, -1, -1],
  [2, 4, 4, 1, 1, 1, -1],
  [2, 4, 4, 1, 1, -1, 1],
  [2, 4, 4, 1, 1, 1, 1],
  [2, 4, 4, 1, 17, -1, -1],
  [2, 4, 4, 1, 17, 1, -1],
  [2, 4, 4, 1, 17, -1, 1],
  [2, 4, 4, 1, 17, 1, 1],
  [2, 4, 4, 1, 33, -1, -1],
  [2, 4, 4, 1, 33, 1, -1],
  [2, 4, 4, 1, 33, -1, 1],
  [2, 4, 4, 1, 33, 1, 1],
  [2, 4, 4, 1, 49, -1, -1],
  [2, 4, 4, 1, 49, 1, -1],
  [2, 4, 4, 1, 49, -1, 1],
  [2, 4, 4, 1, 49, 1, 1],
  [2, 4, 4, 17, 1, -1, -1],
  [2, 4, 4, 17, 1, 1, -1],
  [2, 4, 4, 17, 1, -1, 1],
  [2, 4, 4, 17, 1, 1, 1],
  [2, 4, 4, 17, 17, -1, -1],
  [2, 4, 4, 17, 17, 1, -1],
  [2, 4, 4, 17, 17, -1, 1],
  [2, 4, 4, 17, 17, 1, 1],
  [2, 4, 4, 17, 33, -1, -1],
  [2, 4, 4, 17, 33, 1, -1],
  [2, 4, 4, 17, 33, -1, 1],
  [2, 4, 4, 17, 33, 1, 1],
  [2, 4, 4, 17, 49, -1, -1],
  [2, 4, 4, 17, 49, 1, -1],
  [2, 4, 4, 17, 49, -1, 1],
  [2, 4, 4, 17, 49, 1, 1],
  [2, 4, 4, 33, 1, -1, -1],
  [2, 4, 4, 33, 1, 1, -1],
  [2, 4, 4, 33, 1, -1, 1],
  [2, 4, 4, 33, 1, 1, 1],
  [2, 4, 4, 33, 17, -1, -1],
  [2, 4, 4, 33, 17, 1, -1],
  [2, 4, 4, 33, 17, -1, 1],
  [2, 4, 4, 33, 17, 1, 1],
  [2, 4, 4, 33, 33, -1, -1],
  [2, 4, 4, 33, 33, 1, -1],
  [2, 4, 4, 33, 33, -1, 1],
  [2, 4, 4, 33, 33, 1, 1],
  [2, 4, 4, 33, 49, -1, -1],
  [2, 4, 4, 33, 49, 1, -1],
  [2, 4, 4, 33, 49, -1, 1],
  [2, 4, 4, 33, 49, 1, 1],
  [2, 4, 4, 49, 1, -1, -1],
  [2, 4, 4, 49, 1, 1, -1],
  [2, 4, 4, 49, 1, -1, 1],
  [2, 4, 4, 49, 1, 1, 1],
  [2, 4, 4, 49, 17, -1, -1],
  [2, 4, 4, 49, 17, 1, -1],
  [2, 4, 4, 49, 17, -1, 1],
  [2, 4, 4, 49, 17, 1, 1],
  [2, 4, 4, 49, 33, -1, -1],
  [2, 4, 4, 49, 33, 1, -1],
  [2, 4, 4, 49, 33, -1, 1],
  [2, 4, 4, 49, 33, 1, 1],
  [2, 4, 4, 49, 49, -1, -1],
  [2, 4, 4, 49, 49, 1, -1],
  [2, 4, 4, 49, 49, -1, 1],
  [2, 4, 4, 49, 49, 1, 1],
  [3, 8, 8, 1, 1, -1, -1],
  [3, 8, 8, 1, 1, 1, -1],
  [3, 8, 8, 1, 1, -1, 1],
  [3, 8, 8, 1, 1, 1, 1],
  [3, 8, 8, 1, 257, -1, -1],
  [3, 8, 8, 1, 257, 1, -1],
  [3, 8, 8, 1, 257, -1, 1],
  [3, 8, 8, 1, 257, 1, 1],
  [3, 8, 8, 1, 513, -1, -1],
  [3, 8, 8, 1, 513, 1, -1],
  [3, 8, 8, 1, 513, -1, 1],
  [3, 8, 8, 1, 513, 1, 1],
  [3, 8, 8, 257, 1, -1, -1],
  [3, 8, 8, 257, 1, 1, -1],
  [3, 8, 8, 257, 1, -1, 1],
  [3, 8, 8, 257, 1, 1, 1],
  [3, 8, 8, 257, 257, -1, -1],
  [3, 8, 8, 257, 257, 1, -1],
  [3, 8, 8, 257, 257, -1, 1],
  [3, 8, 8, 257, 257, 1, 1],
  [3, 8, 8, 257, 513, -1, -1],
  [3, 8, 8, 257, 513, 1, -1],
  [3, 8, 8, 257, 513, -1, 1],
  [3, 8, 8, 257, 513, 1, 1],
  [3, 8, 8, 513, 1, -1, -1],
  [3, 8, 8, 513, 1, 1, -1],
  [3, 8, 8, 513, 1, -1, 1],
  [3, 8, 8, 513, 1, 1, 1],
  [3, 8, 8, 513, 257, -1, -1],
  [3, 8, 8, 513, 257, 1, -1],
  [3, 8, 8, 513, 257, -1, 1],
  [3, 8, 8, 513, 257, 1, 1],
  [3, 8, 8, 513, 513, -1, -1],
  [3, 8, 8, 513, 513, 1, -1],
  [3, 8, 8, 513, 513, -1, 1],
  [3, 8, 8, 513, 513, 1, 1],
  [4, 12, 12, 0, 0, -1, -1],
  [4, 12, 12, 0, 0, 1, -1],
  [4, 12, 12, 0, 0, -1, 1],
  [4, 12, 12, 0, 0, 1, 1],
  [5, 16, 16, 0, 0, -1, -1],
  [5, 16, 16, 0, 0, 1, -1],
  [5, 16, 16, 0, 0, -1, 1],
  [5, 16, 16, 0, 0, 1, 1],
];

class Reader {
  constructor(bytes, offset = 0) {
    this.bytes = bytes;
    this.offset = offset;
  }

  take(length) {
    if (this.offset + length > this.bytes.length) throw new Woff2Error('a stream is truncated');
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  u8() {
    return this.take(1)[0];
  }

  u16() {
    return this.take(2).readUInt16BE(0);
  }

  i16() {
    return this.take(2).readInt16BE(0);
  }

  u32() {
    return this.take(4).readUInt32BE(0);
  }

  // UIntBase128 (WOFF2 spec, section 6.1.1): no leading zero byte, at most five bytes, value at most 2^32 - 1.
  uintBase128() {
    let value = 0;
    for (let index = 0; index < 5; index++) {
      const byte = this.u8();
      if (index === 0 && byte === 0x80) throw new Woff2Error('UIntBase128 has a leading zero');
      value = value * 128 + (byte & 0x7f);
      if (value > 0xffffffff) throw new Woff2Error('UIntBase128 exceeds 32 bits');
      if ((byte & 0x80) === 0) return value;
    }
    throw new Woff2Error('UIntBase128 is longer than five bytes');
  }

  // 255UInt16 (WOFF2 spec, section 6.1.2).
  read255UInt16() {
    const code = this.u8();
    if (code === 253) return this.u16();
    if (code === 255) return 253 + this.u8();
    if (code === 254) return 506 + this.u8();
    return code;
  }
}

function transformed(tag, version) {
  if (tag === 'glyf' || tag === 'loca') {
    if (version !== 0 && version !== 3)
      throw new Woff2Error(`${tag} has unknown transform version ${version}`);
    return version === 0;
  }
  if (tag === 'hmtx') {
    if (version !== 0 && version !== 1)
      throw new Woff2Error(`hmtx has unknown transform version ${version}`);
    return version === 1;
  }
  if (version !== 0) throw new Woff2Error(`${tag} has unknown transform version ${version}`);
  return false;
}

function bboxBitmapLength(numGlyphs) {
  return 4 * Math.floor((numGlyphs + 31) / 32);
}

function bitIsSet(bitmap, index) {
  return (bitmap[index >> 3] & (0x80 >> (index & 7))) !== 0;
}

function pad4(bytes) {
  const remainder = bytes.length % 4;
  return remainder === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(4 - remainder)]);
}

// TrueType simple glyph encoding (OpenType glyf spec): one flag per point, with a repeat count for runs.
function encodeSimpleGlyph({ contourCount, endPoints, points, instructions, bbox, overlap }) {
  const header = Buffer.alloc(10);
  header.writeInt16BE(contourCount, 0);
  header.writeInt16BE(bbox.xMin, 2);
  header.writeInt16BE(bbox.yMin, 4);
  header.writeInt16BE(bbox.xMax, 6);
  header.writeInt16BE(bbox.yMax, 8);
  const ends = Buffer.alloc(2 * endPoints.length);
  endPoints.forEach((end, index) => ends.writeUInt16BE(end, 2 * index));
  const instructionLength = Buffer.alloc(2);
  instructionLength.writeUInt16BE(instructions.length, 0);

  const flags = [];
  const xBytes = [];
  const yBytes = [];
  points.forEach((point, index) => {
    let flag = point.onCurve ? 0x01 : 0x00;
    if (index === 0 && overlap) flag |= 0x40;
    if (point.dx === 0) {
      flag |= 0x10;
    } else if (Math.abs(point.dx) <= 255) {
      flag |= 0x02 | (point.dx > 0 ? 0x10 : 0);
      xBytes.push(Math.abs(point.dx));
    } else {
      xBytes.push((point.dx >> 8) & 0xff, point.dx & 0xff);
    }
    if (point.dy === 0) {
      flag |= 0x20;
    } else if (Math.abs(point.dy) <= 255) {
      flag |= 0x04 | (point.dy > 0 ? 0x20 : 0);
      yBytes.push(Math.abs(point.dy));
    } else {
      yBytes.push((point.dy >> 8) & 0xff, point.dy & 0xff);
    }
    flags.push(flag);
  });

  const flagBytes = [];
  for (let index = 0; index < flags.length;) {
    let run = 1;
    while (index + run < flags.length && flags[index + run] === flags[index] && run < 256) run++;
    if (run > 1) flagBytes.push(flags[index] | 0x08, run - 1);
    else flagBytes.push(flags[index]);
    index += run;
  }

  return pad4(
    Buffer.concat([
      header,
      ends,
      instructionLength,
      Buffer.from(instructions),
      Buffer.from(flagBytes),
      Buffer.from(xBytes),
      Buffer.from(yBytes),
    ]),
  );
}

// Reconstructs glyf and loca from a transformed glyf table (WOFF2 spec, section 5.1 and 5.3).
function reconstructGlyf(table) {
  const header = new Reader(table);
  const reserved = header.u16();
  const optionFlags = header.u16();
  const numGlyphs = header.u16();
  const indexFormat = header.u16();
  if (reserved !== 0) throw new Woff2Error('transformed glyf reserved field is not zero');
  if (indexFormat !== 0 && indexFormat !== 1)
    throw new Woff2Error('transformed glyf has an unknown indexFormat');
  const sizes = Array.from({ length: 7 }, () => header.u32());
  const [nContourSize, nPointsSize, flagSize, glyphSize, compositeSize, bboxSize, instructionSize] =
    sizes;

  const streams = new Reader(table, header.offset);
  const nContours = new Reader(streams.take(nContourSize));
  const nPoints = new Reader(streams.take(nPointsSize));
  const flags = new Reader(streams.take(flagSize));
  const glyphs = new Reader(streams.take(glyphSize));
  const composites = new Reader(streams.take(compositeSize));
  const bboxes = streams.take(bboxSize);
  const instructions = new Reader(streams.take(instructionSize));
  const overlapBitmap = optionFlags & 1 ? streams.take(Math.ceil(numGlyphs / 8)) : null;
  if (streams.offset !== table.length)
    throw new Woff2Error('transformed glyf has unused trailing data');

  const bitmapBytes = bboxBitmapLength(numGlyphs);
  if (bboxes.length < bitmapBytes) throw new Woff2Error('bounding box bitmap is truncated');
  const bboxBitmap = bboxes.subarray(0, bitmapBytes);
  const bboxValues = new Reader(bboxes, bitmapBytes);

  const records = [];
  for (let glyph = 0; glyph < numGlyphs; glyph++) {
    const contourCount = nContours.i16();
    if (contourCount < -1) throw new Woff2Error('a glyph has an invalid contour count');
    const hasBox = bitIsSet(bboxBitmap, glyph);
    if (contourCount === 0) {
      if (hasBox) throw new Woff2Error('an empty glyph carries a bounding box');
      records.push(Buffer.alloc(0));
      continue;
    }
    if (contourCount === -1) {
      if (!hasBox) throw new Woff2Error('a composite glyph has no bounding box');
      const bbox = readBox(bboxValues);
      const components = [];
      let moreComponents = true;
      let withInstructions = false;
      while (moreComponents) {
        const flagWord = composites.u16();
        const argumentBytes =
          2 +
          (flagWord & 0x0001 ? 4 : 2) +
          (flagWord & 0x0008 ? 2 : 0) +
          (flagWord & 0x0040 ? 4 : 0) +
          (flagWord & 0x0080 ? 8 : 0);
        const component = Buffer.alloc(2);
        component.writeUInt16BE(flagWord, 0);
        components.push(component, Buffer.from(composites.take(argumentBytes)));
        moreComponents = (flagWord & 0x0020) !== 0;
        if (flagWord & 0x0100) withInstructions = true;
      }
      const instructionBytes = withInstructions
        ? instructions.take(glyphs.read255UInt16())
        : Buffer.alloc(0);
      const boxHeader = Buffer.alloc(10);
      boxHeader.writeInt16BE(-1, 0);
      boxHeader.writeInt16BE(bbox.xMin, 2);
      boxHeader.writeInt16BE(bbox.yMin, 4);
      boxHeader.writeInt16BE(bbox.xMax, 6);
      boxHeader.writeInt16BE(bbox.yMax, 8);
      const instructionLength = Buffer.alloc(2);
      instructionLength.writeUInt16BE(instructionBytes.length, 0);
      records.push(
        pad4(
          withInstructions
            ? Buffer.concat([boxHeader, ...components, instructionLength, instructionBytes])
            : Buffer.concat([boxHeader, ...components]),
        ),
      );
      continue;
    }

    const endPoints = [];
    let pointCount = 0;
    for (let contour = 0; contour < contourCount; contour++) {
      pointCount += nPoints.read255UInt16();
      endPoints.push(pointCount - 1);
    }
    const flagBytes = flags.take(pointCount);
    const points = [];
    let x = 0;
    let y = 0;
    for (let index = 0; index < pointCount; index++) {
      const flag = flagBytes[index];
      const [byteCount, xBits, yBits, deltaX, deltaY, xSign, ySign] = TRIPLETS[flag & 0x7f];
      let value = 0;
      for (const byte of glyphs.take(byteCount - 1)) value = value * 256 + byte;
      const yValue = value % 2 ** yBits;
      const xValue = Math.floor(value / 2 ** yBits) % 2 ** xBits;
      let dx = xBits === 0 ? 0 : deltaX + xValue;
      let dy = yBits === 0 ? 0 : deltaY + yValue;
      if (xSign < 0) dx = -dx;
      if (ySign < 0) dy = -dy;
      x += dx;
      y += dy;
      points.push({ onCurve: (flag & 0x80) === 0, dx, dy, x, y });
    }
    const instructionBytes = instructions.take(glyphs.read255UInt16());
    const bbox = hasBox
      ? readBox(bboxValues)
      : {
          xMin: Math.min(...points.map((point) => point.x)),
          yMin: Math.min(...points.map((point) => point.y)),
          xMax: Math.max(...points.map((point) => point.x)),
          yMax: Math.max(...points.map((point) => point.y)),
        };
    const overlap = overlapBitmap !== null && bitIsSet(overlapBitmap, glyph);
    records.push(
      encodeSimpleGlyph({
        contourCount,
        endPoints,
        points,
        instructions: instructionBytes,
        bbox,
        overlap,
      }),
    );
  }

  const offsets = [0];
  for (const record of records) offsets.push(offsets[offsets.length - 1] + record.length);
  const loca = Buffer.alloc((numGlyphs + 1) * (indexFormat === 0 ? 2 : 4));
  offsets.forEach((offset, index) => {
    if (indexFormat === 0) loca.writeUInt16BE(offset / 2, 2 * index);
    else loca.writeUInt32BE(offset, 4 * index);
  });
  return { glyf: Buffer.concat(records), loca };
}

function readBox(reader) {
  return { xMin: reader.i16(), yMin: reader.i16(), xMax: reader.i16(), yMax: reader.i16() };
}

function tableChecksum(bytes) {
  const padded = pad4(bytes);
  let sum = 0;
  for (let offset = 0; offset < padded.length; offset += 4)
    sum = (sum + padded.readUInt32BE(offset)) >>> 0;
  return sum;
}

// Assembles an sfnt file: sorted table directory, four-byte aligned tables, and the head checksum adjustment.
function assembleSfnt(flavor, tables) {
  // Table data is laid out in the order given (the WOFF2 directory order); the table directory is sorted by tag.
  const count = tables.length;
  const entrySelector = Math.floor(Math.log2(count));
  const searchRange = 2 ** entrySelector * 16;
  let offset = 12 + 16 * count;
  const placed = tables.map((table) => {
    const entry = { ...table, offset };
    offset += pad4(table.bytes).length;
    return entry;
  });
  const out = Buffer.alloc(offset);
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(count, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(count * 16 - searchRange, 10);
  const byTag = [...placed].sort((left, right) =>
    left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0,
  );
  byTag.forEach((table, index) => {
    const at = 12 + 16 * index;
    out.write(table.tag, at, 4, 'latin1');
    const body = table.tag === 'head' ? Buffer.from(table.bytes) : table.bytes;
    if (table.tag === 'head') body.writeUInt32BE(0, 8);
    out.writeUInt32BE(tableChecksum(body), at + 4);
    out.writeUInt32BE(table.offset, at + 8);
    out.writeUInt32BE(table.bytes.length, at + 12);
    pad4(body).copy(out, table.offset);
  });
  const head = placed.find((table) => table.tag === 'head');
  if (head) {
    let total = 0;
    for (let at = 0; at < out.length; at += 4) total = (total + out.readUInt32BE(at)) >>> 0;
    out.writeUInt32BE((0xb1b0afba - total) >>> 0, head.offset + 8);
  }
  return out;
}

/**
 * Decodes a WOFF2 font into its sfnt flavor and its reconstructed tables (tag to bytes). Throws Woff2Error for any
 * input the specification does not allow.
 */
export function decodeWoff2Tables(input) {
  const bytes = Buffer.from(input);
  const header = new Reader(bytes);
  if (header.u32() !== SIGNATURE) throw new Woff2Error('the signature is not wOF2');
  const flavor = header.u32();
  if (flavor === COLLECTION_FLAVOR) throw new Woff2Error('font collections are not supported');
  if (header.u32() !== bytes.length)
    throw new Woff2Error('the declared length differs from the file size');
  const tableCount = header.u16();
  header.u16();
  header.u32();
  const totalCompressedSize = header.u32();
  header.take(4);
  header.take(20);

  const directory = [];
  for (let index = 0; index < tableCount; index++) {
    const flags = header.u8();
    const tagIndex = flags & 0x3f;
    const tag = tagIndex === 63 ? header.take(4).toString('latin1') : KNOWN_TAGS[tagIndex];
    const version = flags >> 6;
    const originalLength = header.uintBase128();
    const isTransformed = transformed(tag, version);
    const storedLength = isTransformed ? header.uintBase128() : originalLength;
    directory.push({ tag, version, transformed: isTransformed, storedLength });
  }

  const stream = brotliDecompressSync(header.take(totalCompressedSize));
  const tables = new Map();
  let position = 0;
  for (const entry of directory) {
    if (position + entry.storedLength > stream.length)
      throw new Woff2Error('decompressed table data is truncated');
    if (tables.has(entry.tag)) throw new Woff2Error(`table ${entry.tag} appears twice`);
    tables.set(entry.tag, {
      ...entry,
      data: stream.subarray(position, position + entry.storedLength),
    });
    position += entry.storedLength;
  }
  if (position !== stream.length) throw new Woff2Error('decompressed data has unused bytes');

  // Tables keep the WOFF2 directory order: the sfnt file stores table data in that order.
  const glyf = tables.get('glyf');
  const loca = tables.get('loca');
  if (glyf?.transformed && (!loca || !loca.transformed || loca.storedLength !== 0)) {
    throw new Woff2Error('transformed glyf needs a transformed loca of length 0');
  }
  if (loca?.transformed && !glyf?.transformed)
    throw new Woff2Error('transformed loca requires a transformed glyf');
  const rebuilt = glyf?.transformed ? reconstructGlyf(glyf.data) : null;
  const output = new Map();
  for (const entry of directory) {
    if (rebuilt && entry.tag === 'glyf') output.set('glyf', rebuilt.glyf);
    else if (rebuilt && entry.tag === 'loca') output.set('loca', rebuilt.loca);
    else if (entry.transformed) throw new Woff2Error(`transformed ${entry.tag} is not supported`);
    else output.set(entry.tag, tables.get(entry.tag).data);
  }
  return { flavor, tables: output };
}

/** Converts a WOFF2 font to TrueType: every table reconstructed, the sfnt directory and checksums recomputed. */
export function woff2ToTrueType(input) {
  const { flavor, tables } = decodeWoff2Tables(input);
  return assembleSfnt(
    flavor,
    [...tables].map(([tag, bytes]) => ({ tag, bytes })),
  );
}

// Renames the PostScript name (nameID 6) of a face. The new name must have the same length, so no offset moves.
function renamePostScriptName(name, from, to) {
  if (from.length !== to.length) throw new Error('a PostScript rename must keep the length');
  const edited = Buffer.from(name);
  const count = edited.readUInt16BE(2);
  const stringOffset = edited.readUInt16BE(4);
  let renamed = 0;
  for (let index = 0; index < count; index++) {
    const record = 6 + 12 * index;
    if (edited.readUInt16BE(record + 6) !== 6) continue;
    const platform = edited.readUInt16BE(record);
    const length = edited.readUInt16BE(record + 8);
    const start = stringOffset + edited.readUInt16BE(record + 10);
    const encoding = platform === 3 ? 'utf16le' : 'latin1';
    const bigEndian = platform === 3;
    const current = bigEndian
      ? Buffer.from(edited.subarray(start, start + length))
          .swap16()
          .toString('utf16le')
      : edited.toString('latin1', start, start + length);
    if (current !== from)
      throw new Error(`nameID 6 is ${JSON.stringify(current)}, not ${JSON.stringify(from)}`);
    const replacement = Buffer.from(to, encoding);
    if (bigEndian) replacement.swap16();
    replacement.copy(edited, start);
    renamed++;
  }
  if (renamed === 0) throw new Error('the name table has no PostScript name (nameID 6)');
  return edited;
}

/**
 * Builds one libass caption face from its pinned WOFF2 source: the decoded outlines, the win metrics that size
 * captions to the Arial proportion, and, for the Latin subset only, a PostScript name that cannot be confused with
 * the Arabic faces. The output matches the pinned TrueType files byte for byte (see the libass manifest).
 */
export function libassCaptionFace(input, { weight, subset }) {
  const style = weight === 400 ? 'Regular' : weight === 700 ? 'Bold' : null;
  if (style === null) throw new Error(`unsupported weight ${weight}`);
  if (subset !== 'arabic' && subset !== 'latin') throw new Error(`unsupported subset ${subset}`);
  const { flavor, tables } = decodeWoff2Tables(input);
  const os2 = Buffer.from(tables.get('OS/2'));
  os2.writeUInt16BE(905, 74);
  os2.writeUInt16BE(212, 76);
  tables.set('OS/2', os2);
  if (subset === 'latin') {
    tables.set(
      'name',
      renamePostScriptName(
        tables.get('name'),
        `NotoSansArabic-${style}`,
        `NotoSansLatinX-${style}`,
      ),
    );
  }
  return assembleSfnt(
    flavor,
    [...tables].map(([tag, bytes]) => ({ tag, bytes })),
  );
}
