/** Minimal OpenType cmap coverage reader for TrueType/OpenType fonts. */
export function missingFontCodePoints(font: Uint8Array, text: string): readonly number[] {
  const { cmapOffset, cmapLength } = findCmap(font);
  const tableEnd = cmapOffset + cmapLength;
  const count = u16(font, cmapOffset + 2);
  const subtables: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const record = cmapOffset + 4 + index * 8;
    const offset = cmapOffset + u32(font, record + 4);
    if (offset + 2 > tableEnd) continue;
    const format = u16(font, offset);
    if (format === 4 || format === 12) {
      const subtableLength = format === 4 ? u16(font, offset + 2) : u32(font, offset + 4);
      if (subtableLength < 2 || offset + subtableLength > tableEnd)
        throw new Error('Font cmap subtable is outside the cmap table.');
      subtables.push(offset);
    }
  }
  if (subtables.length === 0) throw new Error('Font has no supported cmap format 4 or 12 table.');
  const missing = new Set<number>();
  for (const character of text) {
    if (/^\s+$/u.test(character)) continue;
    const codePoint = character.codePointAt(0)!;
    if (!subtables.some((offset) => hasGlyph(font, offset, codePoint))) missing.add(codePoint);
  }
  return [...missing].sort((a, b) => a - b);
}

function findCmap(font: Uint8Array): { cmapOffset: number; cmapLength: number } {
  assertRange(font, 0, 12);
  const tag = ascii(font, 0, 4);
  let faceOffset = 0;
  if (tag === 'ttcf') {
    const faces = u32(font, 8);
    if (faces < 1) throw new Error('Font collection has no face.');
    faceOffset = u32(font, 12);
  }
  assertRange(font, faceOffset, 12);
  const tableCount = u16(font, faceOffset + 4);
  assertRange(font, faceOffset + 12, tableCount * 16);
  for (let index = 0; index < tableCount; index += 1) {
    const record = faceOffset + 12 + index * 16;
    if (ascii(font, record, 4) === 'cmap') {
      const offset = u32(font, record + 8);
      const length = u32(font, record + 12);
      assertRange(font, offset, length);
      return { cmapOffset: offset, cmapLength: length };
    }
  }
  throw new Error('Font has no cmap table.');
}

function hasGlyph(font: Uint8Array, offset: number, codePoint: number): boolean {
  const format = u16(font, offset);
  if (format === 12) {
    const length = u32(font, offset + 4);
    assertRange(font, offset, length);
    if (length < 16) throw new Error('Font cmap format 12 table is malformed.');
    const groups = u32(font, offset + 12);
    if (16 + groups * 12 > length) throw new Error('Font cmap format 12 table is malformed.');
    for (let index = 0; index < groups; index += 1) {
      const group = offset + 16 + index * 12;
      const start = u32(font, group);
      const end = u32(font, group + 4);
      if (codePoint < start) return false;
      if (codePoint <= end) return u32(font, group + 8) + codePoint - start !== 0;
    }
    return false;
  }
  if (format !== 4 || codePoint > 0xffff) return false;
  const length = u16(font, offset + 2);
  assertRange(font, offset, length);
  const segments = u16(font, offset + 6) / 2;
  if (segments < 1 || 16 + segments * 8 > length)
    throw new Error('Font cmap format 4 table is malformed.');
  const endCodes = offset + 14;
  const startCodes = endCodes + segments * 2 + 2;
  const deltas = startCodes + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  for (let index = 0; index < segments; index += 1) {
    const end = u16(font, endCodes + index * 2);
    if (codePoint > end) continue;
    const start = u16(font, startCodes + index * 2);
    if (codePoint < start) return false;
    const delta = i16(font, deltas + index * 2);
    const rangeAddress = rangeOffsets + index * 2;
    const range = u16(font, rangeAddress);
    const glyphAddress = range === 0 ? undefined : rangeAddress + range + (codePoint - start) * 2;
    const glyph = glyphAddress === undefined ? codePoint : u16(font, glyphAddress);
    return glyph === 0 ? false : ((glyph + delta) & 0xffff) !== 0;
  }
  return false;
}

function u16(data: Uint8Array, offset: number): number {
  assertRange(data, offset, 2);
  return (data[offset]! << 8) | data[offset + 1]!;
}

function i16(data: Uint8Array, offset: number): number {
  const value = u16(data, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

function u32(data: Uint8Array, offset: number): number {
  assertRange(data, offset, 4);
  return (
    (data[offset]! * 0x1000000 +
      (data[offset + 1]! << 16) +
      (data[offset + 2]! << 8) +
      data[offset + 3]!) >>>
    0
  );
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  assertRange(data, offset, length);
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

function assertRange(data: Uint8Array, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > data.length
  )
    throw new Error('Font file has a malformed table directory.');
}
