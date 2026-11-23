/**
 * Persian half-spaces in generated speech words (SP-04).
 *
 * A speech model transcribes Persian compound verbs as two separate words
 * ("می باشد") while Persian orthography writes them joined by a zero width
 * non-joiner ("می" + U+200C + "بشاد"). This module repairs that gap for
 * display only.
 *
 * Rules that keep the repair honest:
 * - it works on copies of the source words, so the caption document is never
 *   mutated;
 * - ids, order, timestamps, confidence and speaker are preserved;
 * - only the explicit whitelist of word pairs below is ever joined, so no
 *   other morpheme is guessed;
 * - Arabic, English, digits and punctuation are left alone, and an existing
 *   half-space is never stripped or doubled.
 *
 * Two source words keep their own ids and intervals. The first word carries a
 * trailing half-space as the display annotation, and the display formatter
 * (next slice) joins a word that ends with U+200C to the next word without
 * inserting a space.
 */

import type { CaptionWordV1 } from '@joy-media/project-schema';

/** The Persian half-space: ZERO WIDTH NON-JOINER (U+200C). */
export const PERSIAN_HALF_SPACE = '\u200C';

/**
 * The conservative whitelist: word pairs Persian writes with a half-space.
 * Both sides must match exactly; nothing outside this list is touched.
 */
const PERSIAN_HALF_SPACE_PAIRS: readonly (readonly [string, string])[] = [
  ['نمی', 'باشد'],
  ['می', 'باشد'],
];

/** True when the two words form a whitelisted pair. */
function isWhitelistedPair(first: string, second: string): boolean {
  return PERSIAN_HALF_SPACE_PAIRS.some((pair) => pair[0] === first && pair[1] === second);
}

/**
 * Joins a whitelisted pair that sits inside a single token, such as
 * "می باشد". The pair has to stand between whitespace or the token edges, so
 * punctuation and digits around it are never swallowed.
 */
function repairInsideToken(text: string): string {
  let repaired = text;
  for (const [first, second] of PERSIAN_HALF_SPACE_PAIRS) {
    const pattern = new RegExp(`(^|\\s)(${first}) (${second})(?=\\s|$)`, 'g');
    repaired = repaired.replace(pattern, `$1$2${PERSIAN_HALF_SPACE}$3`);
  }
  return repaired;
}

/**
 * Returns display copies of the speech words with whitelisted Persian pairs
 * joined by a half-space. The source words are never modified.
 */
export function repairPersianSpeechTokens(
  words: readonly CaptionWordV1[],
): readonly CaptionWordV1[] {
  const texts = words.map((word) => repairInsideToken(word.text));

  for (let index = 0; index + 1 < texts.length; index += 1) {
    const first = texts[index];
    const second = texts[index + 1];
    if (first === undefined || second === undefined) continue;
    if (!isWhitelistedPair(first, second)) continue;
    // Annotate the first word with a trailing half-space; the display
    // formatter then joins the pair without a space between the two words.
    texts[index] = `${first}${PERSIAN_HALF_SPACE}`;
  }

  return words.map((word, index) => ({ ...word, text: texts[index] ?? word.text }));
}
