export interface TextPlateBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Shared text-plate geometry so browser and headless renderers anchor identically. */
export function textPlateBounds(
  textWidth: number,
  textHeight: number,
  align: 'left' | 'center' | 'right' = 'left',
  padding = 0,
): TextPlateBounds {
  const safeWidth = Math.max(0, textWidth);
  const safeHeight = Math.max(0, textHeight);
  const safePadding = Math.max(0, padding);
  const anchorOffset = align === 'center' ? safeWidth / 2 : align === 'right' ? safeWidth : 0;
  const leftOffset = anchorOffset + safePadding;
  return {
    x: leftOffset === 0 ? 0 : -leftOffset,
    y: safePadding === 0 ? 0 : -safePadding,
    width: safeWidth + safePadding * 2,
    height: safeHeight + safePadding * 2,
  };
}
