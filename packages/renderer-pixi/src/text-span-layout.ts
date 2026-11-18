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
