import { describe, expect, it, vi } from 'vitest';
import { jsonUtf8Size } from './json-bytes.js';

const utf8 = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe('jsonUtf8Size', () => {
  it('matches the UTF-8 length of JSON.stringify for plain data', () => {
    const samples: unknown[] = [
      null,
      true,
      false,
      0,
      -0,
      1.5,
      1e21,
      NaN,
      Infinity,
      'plain',
      `data:image/png;base64,${'QUJDRA=='.repeat(500)}`,
      'printable edges: space, ! # [ ] ~ and del \u007f',
      'quote " and \\ slash',
      'controls \b\t\n\f\r \u0001 \u001f',
      'accents é, 界 and 😀',
      'lone \ud800 high and \udc00 low',
      [],
      {},
      [1, 'two', null, [3]],
      { a: { b: ['x', { c: true }] } },
      { messages: [{ role: 'user', content: 'hi 界😀' }], image: 'data:image/png;base64,AAAA' },
    ];
    for (const sample of samples) expect(jsonUtf8Size(sample, Infinity)).toBe(utf8(sample));
  });

  it('skips undefined members of objects and writes them as null in arrays, as JSON.stringify does', () => {
    const sample = { a: undefined, b: () => 1, c: [undefined, () => 1, Symbol('x')], d: 'x' };
    expect(jsonUtf8Size(sample, Infinity)).toBe(utf8(sample));
  });

  it('counts a Chinese character as three bytes, so the character count is not the byte count', () => {
    const body = { text: '界'.repeat(1_000) };
    expect(body.text.length).toBe(1_000);
    expect(jsonUtf8Size(body, Infinity)).toBe(utf8(body));
    expect(utf8(body)).toBeGreaterThan(3_000);
    expect(jsonUtf8Size(body, 3_000)).toBeUndefined();
  });

  it('accepts a value exactly at the limit and refuses one byte over it', () => {
    const body = { text: 'x'.repeat(100) };
    const size = utf8(body);
    expect(jsonUtf8Size(body, size)).toBe(size);
    expect(jsonUtf8Size(body, size - 1)).toBeUndefined();
  });

  it('refuses a value it cannot write as plain JSON', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonUtf8Size(cyclic, Infinity)).toBeUndefined();
    expect(jsonUtf8Size({ n: BigInt(1) }, Infinity)).toBeUndefined();
    expect(jsonUtf8Size(undefined, Infinity)).toBeUndefined();
    expect(jsonUtf8Size({ when: { toJSON: () => 'x' } }, Infinity)).toBeUndefined();
  });

  it('refuses a boxed number, a boxed string or a Date, which JSON.stringify writes differently', () => {
    expect(jsonUtf8Size({ n: Object(1e20) }, Infinity)).toBeUndefined();
    expect(jsonUtf8Size({ s: Object('text') }, Infinity)).toBeUndefined();
    expect(jsonUtf8Size({ d: new Date(0) }, Infinity)).toBeUndefined();
  });

  it('stops reading a large list once it passes the limit', () => {
    const items = Array.from({ length: 100_000 }, () => 'x'.repeat(10));
    let reads = 0;
    const counted = new Proxy(items, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });

    expect(jsonUtf8Size(counted, 100)).toBeUndefined();
    expect(reads).toBeLessThan(20);
  });

  it('does not scan a string that is already over the budget', () => {
    const scan = vi.spyOn(RegExp.prototype, 'test');
    try {
      // The string is the whole value, so no shorter string (such as a key name) is scanned first.
      expect(jsonUtf8Size('x'.repeat(10_000), 100)).toBeUndefined();
      expect(scan).not.toHaveBeenCalled();
    } finally {
      scan.mockRestore();
    }
  });

  it('stops at the limit for a body far larger than it', () => {
    const huge = { text: 'x'.repeat(5_000_000) };
    expect(jsonUtf8Size(huge, 1_000)).toBeUndefined();
  });
});
