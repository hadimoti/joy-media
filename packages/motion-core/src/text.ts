/**
 * Text animation scopes (§20.3): split a caption/text string into per-character,
 * per-word, or per-line units and stagger an animation across them. Pure timing
 * math only — the actual per-unit rendering lands with the text renderer. This
 * gives motion presets a way to cascade across a title one letter at a time.
 */

import type { TimeUs } from '@joy-media/project-schema';

export type TextAnimationScope = 'character' | 'word' | 'line';

/** Splits text into animation units for the given scope. */
export function splitTextUnits(text: string, scope: TextAnimationScope): readonly string[] {
  switch (scope) {
    case 'character':
      return Array.from(text);
    case 'word':
      return text.split(/\s+/u).filter((unit) => unit.length > 0);
    case 'line':
      return text.split(/\r?\n/u);
    default:
      return [text];
  }
}

export interface TextStaggerOptions {
  readonly unitCount: number;
  /** Start time of the first unit's animation, object-local microseconds. */
  readonly startUs: TimeUs;
  /** Delay added per unit index, microseconds; must be >= 0. */
  readonly perUnitDelayUs: number;
  /** When true, the last unit starts first (useful for exits). */
  readonly reverse?: boolean;
}

/**
 * Per-unit animation start times. Unit `i` starts at `startUs + i * delay`
 * (or reversed), so a preset applied with these offsets cascades across the
 * text. Returns one time per unit, in unit order.
 */
export function staggerOffsets(options: TextStaggerOptions): readonly TimeUs[] {
  if (options.unitCount < 0) throw new RangeError('unitCount cannot be negative');
  if (options.perUnitDelayUs < 0) throw new RangeError('perUnitDelayUs cannot be negative');
  const start = Math.round(options.startUs);
  const delay = Math.round(options.perUnitDelayUs);
  const offsets: TimeUs[] = [];
  for (let i = 0; i < options.unitCount; i += 1) {
    const index = options.reverse === true ? options.unitCount - 1 - i : i;
    offsets.push(start + index * delay);
  }
  return offsets;
}
