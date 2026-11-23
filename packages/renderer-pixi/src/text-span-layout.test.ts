import { describe, expect, it } from 'vitest';
import {
  layoutTextSpanOffsets,
  type layoutWrappedTextSpans,
  serializeTextSpanLayoutRuntimeSource,
} from './text-span-layout.js';
import { wrapTextByWords } from './text-direction.js';

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

it('keeps styled URL fragments in LTR order across repeated raw and authored-isolate lines', () => {
  const prefix = 'عنوان ';
  const head = 'https://example.com/';
  const tail = 'long-path';
  const red = { r: 225, g: 20, b: 40, a: 255 };
  const green = { r: 30, g: 235, b: 55, a: 255 };
  const white = { r: 255, g: 255, b: 255, a: 255 };
  const spans = [
    { text: prefix, color: white },
    { text: head, color: red },
    { text: tail, color: green },
    { text: '\n' + prefix + '\u2066', color: white },
    { text: head, color: green },
    { text: tail + '\u2069', color: red },
  ];
  const source = spans.map((span) => span.text).join('');
  const length = (text: string) => text.replace(/[\u2066-\u2069]/gu, '').length;
  const wrapped = wrapTextByWords(source, 18, length, 'rtl');
  const lines = wrapped.text.split('\n');
  expect(lines).toEqual([
    prefix.trimEnd(),
    '\u2068' + head + tail + '\u2069',
    prefix.trimEnd(),
    '\u2066' + head + tail + '\u2069',
  ]);
  const layout = new Function(
    'return ' + serializeTextSpanLayoutRuntimeSource(),
  )() as typeof layoutWrappedTextSpans;
  const runs = layout(
    source,
    spans,
    lines,
    wrapped.lineDirections,
    ['right', 'right', 'right', 'right'],
    length,
  );
  for (const [index, colors] of [
    [1, [red, green]],
    [3, [green, red]],
  ] as const) {
    expect(runs[index]?.map(({ text, color, direction }) => ({ text, color, direction }))).toEqual([
      { text: head, color: colors[0], direction: 'ltr' },
      { text: tail, color: colors[1], direction: 'ltr' },
    ]);
    expect(runs[index]![1]!.x).toBeGreaterThan(runs[index]![0]!.x);
  }
});
