import { describe, expect, it } from 'vitest';
import { layoutTextSpanOffsets } from './text-span-layout.js';

type Direction = 'ltr' | 'rtl';
type Alignment = 'left' | 'center' | 'right' | 'start' | 'end';

describe('layoutTextSpanOffsets', () => {
  it.each([
    ['ltr', 'left', [0, 7, 18]],
    ['ltr', 'center', [-15.5, -8.5, 2.5]],
    ['ltr', 'right', [-31, -24, -13]],
    ['ltr', 'start', [0, 7, 18]],
    ['ltr', 'end', [-31, -24, -13]],
    ['rtl', 'left', [24, 13, 0]],
    ['rtl', 'center', [8.5, -2.5, -15.5]],
    ['rtl', 'right', [-7, -18, -31]],
    ['rtl', 'start', [-7, -18, -31]],
    ['rtl', 'end', [24, 13, 0]],
  ] as const)('places cumulative prefixes for %s %s alignment', (direction, align, expected) => {
    const measuredWidths = new Map([
      ['a', 7],
      ['ab', 18],
      ['abc', 31],
    ]);
    const measuredPrefixes: string[] = [];
    const offsets = layoutTextSpanOffsets(
      [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
      align as Alignment,
      direction as Direction,
      (prefix) => {
        measuredPrefixes.push(prefix);
        const width = measuredWidths.get(prefix);
        if (width === undefined) throw new Error(`unexpected prefix ${prefix}`);
        return width;
      },
    );

    expect(offsets).toEqual(expected);
    expect(measuredPrefixes).toEqual(['a', 'ab', 'abc']);
  });
});
