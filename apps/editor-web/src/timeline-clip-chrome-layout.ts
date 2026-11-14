/** Which small parts a timeline clip can show at its current width. */
export interface ClipChromeLayout {
  /** The kind icon row at all. Below this the clip shows only a compact icon. */
  readonly chrome: boolean;
  /** The speed badge (for example "2x"). It survives longer than the other parts. */
  readonly badge: boolean;
  /** The effects and transition icons. */
  readonly flags: boolean;
  /** The length label. It is the first part to go. */
  readonly duration: boolean;
}

// Pixel costs of each part, with its gap: kind icon and padding, one flag icon, the speed badge,
// and the length label.
const BASE_PX = 30;
const FLAG_PX = 18;
const BADGE_PX = 54;
const DURATION_PX = 44;

/**
 * Parts are dropped in this order as a clip shrinks: length, then the effects and transition icons,
 * then the speed badge. The kind icon stays. Nothing is ever cut in half: a part shows only when it
 * fits whole next to the parts that rank above it.
 */
export function clipChromeLayout(
  widthPx: number,
  options: { readonly flagCount: number; readonly hasBadge: boolean },
): ClipChromeLayout {
  const chrome = widthPx >= 48;
  if (!chrome) return { chrome: false, badge: false, flags: false, duration: false };
  const badge = options.hasBadge && widthPx >= BASE_PX + BADGE_PX;
  const badgeCost = badge ? BADGE_PX : 0;
  const flags =
    options.flagCount > 0 && widthPx >= BASE_PX + badgeCost + options.flagCount * FLAG_PX;
  const flagCost = flags ? options.flagCount * FLAG_PX : 0;
  const duration = widthPx >= BASE_PX + badgeCost + flagCost + DURATION_PX;
  return { chrome, badge, flags, duration };
}
