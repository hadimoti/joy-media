export interface TextPlateBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const RTL_LETTER = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u{1ee00}-\u{1eeff}]/u;
const UNICODE_LETTER = /\p{Letter}/u;
const RTL_DIGIT = /[\u0660-\u0669\u06f0-\u06f9]/u;

export function resolveTextDirection(
  text: string,
  requested: 'ltr' | 'rtl' | 'auto' = 'auto',
): 'ltr' | 'rtl' {
  if (requested !== 'auto') return requested;
  let hasRtlDigit = false;
  for (const character of text) {
    if (UNICODE_LETTER.test(character)) return RTL_LETTER.test(character) ? 'rtl' : 'ltr';
    if (RTL_DIGIT.test(character)) hasRtlDigit = true;
  }
  return hasRtlDigit ? 'rtl' : 'ltr';
}

export function resolveLogicalTextAlign(
  align: 'left' | 'center' | 'right' | 'start' | 'end',
  direction: 'ltr' | 'rtl',
): 'left' | 'center' | 'right' {
  if (align === 'center') return 'center';
  if (align === 'left' || align === 'right') return align;
  if (align === 'start') return direction === 'rtl' ? 'right' : 'left';
  return direction === 'rtl' ? 'left' : 'right';
}

/** Shared text-plate geometry so browser and headless renderers anchor identically. */
export function textPlateBounds(
  textWidth: number,
  textHeight: number,
  align: 'left' | 'center' | 'right' | 'start' | 'end' = 'left',
  padding = 0,
  direction: 'ltr' | 'rtl' = 'ltr',
): TextPlateBounds {
  const safeWidth = Math.max(0, textWidth);
  const safeHeight = Math.max(0, textHeight);
  const safePadding = Math.max(0, padding);
  const physicalAlign = resolveLogicalTextAlign(align, direction);
  const anchorOffset =
    physicalAlign === 'center' ? safeWidth / 2 : physicalAlign === 'right' ? safeWidth : 0;
  const leftOffset = anchorOffset + safePadding;
  return {
    x: leftOffset === 0 ? 0 : -leftOffset,
    y: safePadding === 0 ? 0 : -safePadding,
    width: safeWidth + safePadding * 2,
    height: safeHeight + safePadding * 2,
  };
}
