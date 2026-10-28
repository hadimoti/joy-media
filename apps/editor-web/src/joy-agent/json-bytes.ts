/** Thrown inside the count when it passes its limit. It never leaves `jsonUtf8Size`. */
class SizeLimitExceeded extends Error {
  constructor() {
    super('The JSON value is over its size limit.');
  }
}

/** Thrown inside the count for a value that JSON.stringify would not write as plain data. */
class UnsupportedJsonValue extends Error {
  constructor() {
    super('The JSON value cannot be written as plain data.');
  }
}

/** Deeper than any legal body. A cycle reaches this depth, so it is refused rather than followed. */
const MAX_DEPTH = 64;

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Printable ASCII without the quote (0x22) and the backslash (0x5c): written as it is. */
const PLAIN_ASCII = /^[ !#-[\]-~]*$/;

const isSkipped = (item: unknown): boolean =>
  item === undefined || typeof item === 'function' || typeof item === 'symbol';

/**
 * The UTF-8 size of `JSON.stringify(value)`, counted without building the text. The count stops as
 * soon as it passes `limit`, so refusing an oversized body costs no more than the limit itself. A
 * character count cannot stand in for this: a Chinese character is one UTF-16 unit and three bytes.
 * Returns undefined when the value is over the limit or cannot be written as plain JSON.
 */
export function jsonUtf8Size(value: unknown, limit: number): number | undefined {
  let bytes = 0;
  const add = (count: number): void => {
    bytes += count;
    if (bytes > limit) throw new SizeLimitExceeded();
  };
  const addString = (text: string): void => {
    // Printable ASCII other than the quote and the backslash is one byte a character, with nothing to
    // escape. Image data is almost all of this, so it is counted in one step.
    // Every UTF-16 unit is at least one byte, so a string already past the budget is refused unread.
    if (bytes + text.length + 2 > limit) throw new SizeLimitExceeded();
    if (PLAIN_ASCII.test(text)) {
      add(text.length + 2);
      return;
    }
    let count = 2; // the quotes
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code < 0x20) {
        // Control characters take a short escape for five of them and \u00XX for the rest.
        count +=
          code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
      } else if (code === 0x22 || code === 0x5c) {
        count += 2;
      } else if (code < 0x80) {
        count += 1;
      } else if (code < 0x800) {
        count += 2;
      } else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(text.charCodeAt(index + 1))) {
        count += 4;
        index += 1;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        count += 6; // a lone surrogate is written as \uXXXX
      } else {
        count += 3;
      }
      if (bytes + count > limit) throw new SizeLimitExceeded();
    }
    add(count);
  };
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) throw new UnsupportedJsonValue();
    if (node === null) {
      add(4);
      return;
    }
    if (typeof node === 'boolean') {
      add(node ? 4 : 5);
      return;
    }
    if (typeof node === 'number') {
      add(Number.isFinite(node) ? String(node).length : 4);
      return;
    }
    if (typeof node === 'string') {
      addString(node);
      return;
    }
    if (typeof node !== 'object') throw new UnsupportedJsonValue(); // a bigint, for one
    if (Array.isArray(node)) {
      add(2);
      for (let index = 0; index < node.length; index += 1) {
        if (index > 0) add(1);
        const item: unknown = node[index];
        if (isSkipped(item)) add(4);
        else visit(item, depth + 1);
      }
      return;
    }
    // Only plain data is counted. A boxed number, a Date or a Map is not the object it looks like, and
    // JSON.stringify writes it differently, so it is refused rather than miscounted.
    if (Object.prototype.toString.call(node) !== '[object Object]') {
      throw new UnsupportedJsonValue();
    }
    const record = node as Record<string, unknown>;
    if (typeof record.toJSON === 'function') throw new UnsupportedJsonValue();
    add(2);
    let first = true;
    for (const name of Object.keys(record)) {
      const item = record[name];
      if (isSkipped(item)) continue;
      if (!first) add(1);
      first = false;
      addString(name);
      add(1); // the colon
      visit(item, depth + 1);
    }
  };
  if (isSkipped(value)) return undefined;
  try {
    visit(value, 0);
    return bytes;
  } catch (error) {
    if (error instanceof SizeLimitExceeded || error instanceof UnsupportedJsonValue)
      return undefined;
    throw error;
  }
}
