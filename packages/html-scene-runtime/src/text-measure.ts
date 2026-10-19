import type { HeadlessSceneDriver } from './headless.js';

const MAX_CACHE_ENTRIES = 4096;

/**
 * Same shape as motion-core's TextMeasure. It is declared here so this package keeps its
 * dependencies; the CLI passes the result straight to the title compiler.
 */
export type ChromiumTextMeasure = (text: string, fontSizePx: number, weight: 400 | 700) => number;

/** Creates a synchronous title measurer with bounded exact-input memoization. */
export function createChromiumTextMeasure(driver: HeadlessSceneDriver): ChromiumTextMeasure {
  const measureTextWidths = driver.measureTextWidths;
  if (!measureTextWidths) throw new Error('Chromium driver does not support text measurement');
  const cache = new Map<string, number>();
  return (text, fontSizePx, weight) => {
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    if (!Number.isFinite(fontSizePx) || fontSizePx <= 0)
      throw new RangeError('fontSizePx must be finite and positive');
    if (weight !== 400 && weight !== 700) throw new RangeError('weight must be 400 or 700');
    const key = JSON.stringify([text, fontSizePx, weight]);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const width = measureTextWidths.call(driver, [{ text, fontSizePx, weight }])[0];
    if (width === undefined || !Number.isFinite(width) || width < 0)
      throw new Error('Chromium returned an invalid text width');
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(key, width);
    return width;
  };
}
