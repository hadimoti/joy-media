export interface TextPlateBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const RTL_LETTER =
  /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;
const UNICODE_LETTER = /\p{Letter}/u;
const RTL_DIGIT = /[\u0660-\u0669\u06f0-\u06f9\u{10e60}-\u{10e7f}]/u;

export function resolveTextDirection(
  text: string,
  requested: 'ltr' | 'rtl' | 'auto' = 'auto',
): 'ltr' | 'rtl' {
  if (requested !== 'auto') return requested;
  let hasRtlDigit = false;
  for (const character of text) {
    if (UNICODE_LETTER.test(character)) {
      if (RTL_LETTER.test(character)) return 'rtl';
      return 'ltr';
    }
    if (RTL_DIGIT.test(character)) hasRtlDigit = true;
  }
  return hasRtlDigit ? 'rtl' : 'ltr';
}

export function resolveParagraphTextDirections(
  text: string,
  requested: 'ltr' | 'rtl' | 'auto' = 'auto',
): readonly ('ltr' | 'rtl')[] {
  return text.split(/\r\n|\n|\r/u).map((paragraph) => resolveTextDirection(paragraph, requested));
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

/** Each edge of the shared text safe area keeps five percent of the frame clear. */
export const TEXT_SAFE_AREA_MARGIN_FRACTION = 0.05;

/** Default text wrap width: the same central 90 percent that QC treats as safe. */
export function resolveTextWrapWidth(compositionWidth: number, maxWidth?: number): number {
  return maxWidth ?? compositionWidth * (1 - TEXT_SAFE_AREA_MARGIN_FRACTION * 2);
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
