export type TextSpanAlignment = 'left' | 'center' | 'right' | 'start' | 'end';
export type TextSpanDirection = 'ltr' | 'rtl';

export function layoutTextSpanOffsets(
  spans: readonly { readonly text: string }[],
  align: TextSpanAlignment,
  direction: TextSpanDirection,
  measurePrefix: (prefix: string, direction: TextSpanDirection) => number,
): readonly number[] {
  if (spans.length === 0) return [];

  let prefix = '';
  const prefixWidths = spans.map((span) => {
    prefix += span.text;
    return measurePrefix(prefix, direction);
  });
  const totalWidth = prefixWidths[prefixWidths.length - 1] ?? 0;
  const physicalAlign =
    align === 'start'
      ? direction === 'rtl'
        ? 'right'
        : 'left'
      : align === 'end'
        ? direction === 'rtl'
          ? 'left'
          : 'right'
        : align;
  const alignmentOffset =
    physicalAlign === 'right' ? -totalWidth : physicalAlign === 'center' ? -totalWidth / 2 : 0;

  return prefixWidths.map((width, index) => {
    const runOffset =
      direction === 'ltr' ? (index === 0 ? 0 : (prefixWidths[index - 1] ?? 0)) : totalWidth - width;
    return runOffset + alignmentOffset;
  });
}

interface ColoredTextSpan {
  readonly text: string;
  readonly color: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
  };
}

interface PositionedTextSpan extends ColoredTextSpan {
  readonly direction: TextSpanDirection;
  readonly x: number;
}

function styledRunsForLine(
  sourceLine: string,
  sourceStart: number,
  spans: readonly ColoredTextSpan[],
  direction: TextSpanDirection,
) {
  const urls = Array.from(sourceLine.matchAll(/https?:\/\/[^\s\u2066-\u2069]+/giu), (match) => ({
    start: sourceStart + match.index,
    end: sourceStart + match.index + match[0].length,
  }));
  const runs: Array<ColoredTextSpan & { direction: TextSpanDirection }> = [];
  const sourceEnd = sourceStart + sourceLine.length;
  let spanStart = 0;
  for (const span of spans) {
    const spanEnd = spanStart + span.text.length;
    const start = Math.max(sourceStart, spanStart);
    const end = Math.min(sourceEnd, spanEnd);
    if (start < end) {
      const boundaries = [
        start,
        ...urls.flatMap((url) =>
          [url.start, url.end].filter((point) => point > start && point < end),
        ),
        end,
      ].sort((left, right) => left - right);
      for (let index = 1; index < boundaries.length; index += 1) {
        const from = boundaries[index - 1]!;
        const to = boundaries[index]!;
        const text = span.text.slice(from - spanStart, to - spanStart);
        runs.push({
          text,
          color: span.color,
          direction: urls.some((url) => from >= url.start && to <= url.end) ? 'ltr' : direction,
        });
      }
    }
    if (spanEnd >= sourceEnd) break;
    spanStart = spanEnd;
  }
  return runs;
}

/** Place colored spans on wrapped lines while retaining URL order across color boundaries. */
export function layoutWrappedTextSpans(
  source: string,
  spans: readonly ColoredTextSpan[],
  lines: readonly string[],
  directions: readonly TextSpanDirection[],
  alignments: readonly ('left' | 'center' | 'right')[],
  measure: (text: string, direction: TextSpanDirection) => number,
): readonly (readonly PositionedTextSpan[])[] {
  // Ignore formatting controls for matching while keeping offsets in the source
  // spans. Both authored and generated URL isolates can occur on the same line.
  let unisolatedSource = '';
  const sourceOffsets: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (/[\u2066-\u2069]/u.test(character)) continue;
    unisolatedSource += character;
    sourceOffsets.push(index);
  }
  let sourceCursor = 0;
  return lines.map((line, index) => {
    const unisolatedLine = line.replace(/[\u2066-\u2069]/gu, '');
    if (unisolatedLine.length === 0) return [];
    const match = unisolatedSource.indexOf(unisolatedLine, sourceCursor);
    if (match < 0) throw new Error('Wrapped text span line could not be matched');
    sourceCursor = match + unisolatedLine.length;
    const start = sourceOffsets[match]!;
    const end = sourceOffsets[sourceCursor - 1]! + 1;
    const direction = directions[index] ?? 'ltr';
    const align = alignments[index] ?? 'left';
    const runs = styledRunsForLine(source.slice(start, end), start, spans, direction);
    if (runs.every((run) => run.direction === direction)) {
      const offsets = layoutTextSpanOffsets(runs, align, direction, measure);
      return runs.map((run, runIndex) => ({ ...run, x: offsets[runIndex] ?? 0 }));
    }

    const groups: Array<{ direction: TextSpanDirection; runs: typeof runs }> = [];
    for (const run of runs) {
      const previous = groups.at(-1);
      if (previous?.direction === run.direction) previous.runs.push(run);
      else groups.push({ direction: run.direction, runs: [run] });
    }
    const lineWidth = measure(line, direction);
    let x = align === 'right' ? -lineWidth : align === 'center' ? -lineWidth / 2 : 0;
    if (direction === 'rtl') groups.reverse();
    return groups.flatMap((group) => {
      const offsets = layoutTextSpanOffsets(group.runs, 'left', group.direction, measure);
      const positioned = group.runs.map((run, runIndex) => ({
        ...run,
        x: x + (offsets[runIndex] ?? 0),
      }));
      x += measure(group.runs.map((run) => run.text).join(''), group.direction);
      return positioned;
    });
  });
}

export function serializeTextSpanLayoutRuntimeSource(): string {
  return [
    '(() => {',
    'const layoutTextSpanOffsets = ' + layoutTextSpanOffsets.toString() + ';',
    'const styledRunsForLine = ' + styledRunsForLine.toString() + ';',
    'return ' + layoutWrappedTextSpans.toString() + ';',
    '})()',
  ].join('\n');
}
