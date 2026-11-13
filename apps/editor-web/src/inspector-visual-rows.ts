/**
 * Pure maths for the Inspector Visual rows (T-D08).
 *
 * Opacity is stored as 0 to 1 in the project and shown once, as a percentage.
 * Linked scale keeps the X and Y proportions: changing one axis scales the other
 * by the same ratio. Nothing here touches the document; the panel decides what
 * to write.
 */

/** The smallest scale a row may store (the descriptor's `min` for scale X and Y). */
export const MIN_VISUAL_SCALE = 0.001;

export type ScaleAxis = 'scaleX' | 'scaleY';

export interface ScalePair {
  readonly scaleX: number;
  readonly scaleY: number;
}

/** Stored opacity (0 to 1) as the percentage the row shows, with at most one decimal. */
export function opacityToPercent(opacity: number): number {
  return Math.round(opacity * 1000) / 10;
}

/**
 * A typed or dragged percentage as stored opacity. Clamped to [0, 1] and rounded
 * to four decimals so 33 % stores 0.33, not a float tail. Non-finite input has no
 * stored value and returns undefined.
 */
export function opacityFromPercent(percent: number): number | undefined {
  if (!Number.isFinite(percent)) return undefined;
  const clamped = Math.min(100, Math.max(0, percent));
  return Math.round(clamped * 100) / 10_000;
}

function roundScale(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * The X and Y scales after a linked edit of one axis. The other axis keeps its
 * ratio to the edited one. Returns undefined when the edit cannot be stored as a
 * pair: the requested value or the current one is not a usable scale, or the
 * partner would fall below the minimum scale.
 */
export function linkedScalePair(
  current: ScalePair,
  axis: ScaleAxis,
  next: number,
): ScalePair | undefined {
  if (!Number.isFinite(next) || next < MIN_VISUAL_SCALE) return undefined;
  const from = current[axis];
  if (!Number.isFinite(from) || from <= 0) return undefined;
  const other: ScaleAxis = axis === 'scaleX' ? 'scaleY' : 'scaleX';
  const partner = roundScale(current[other] * (next / from));
  if (!Number.isFinite(partner) || partner < MIN_VISUAL_SCALE) return undefined;
  return axis === 'scaleX' ? { scaleX: next, scaleY: partner } : { scaleX: partner, scaleY: next };
}
