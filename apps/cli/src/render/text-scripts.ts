/** Scripts needing bidi or shaping support from the renderer. */
const COMPLEX_RANGES = [
  [0x0590, 0x08ff], // Hebrew, Arabic, Syriac, Thaana, N'Ko and related blocks
  [0xfb1d, 0xfdff],
  [0xfe70, 0xfeff],
  [0x0900, 0x0dff], // Indic scripts
  [0x0e00, 0x0eff], // Thai and Lao
  [0x0f00, 0x109f], // Tibetan, Myanmar
  [0x1700, 0x18af], // Philippine scripts
  [0x1900, 0x1cff], // Tai, Khmer, and related scripts
  [0xa800, 0xabff],
  [0x11000, 0x11fff], // supplementary Brahmic scripts
] as const;

const ARABIC_RANGES = [
  [0x0600, 0x08ff],
  [0xfb50, 0xfdff],
  [0xfe70, 0xfeff],
] as const;

export function containsRtlOrComplexScript(text: string): boolean {
  return containsCodePoint(text, COMPLEX_RANGES);
}

export function containsArabicScript(text: string): boolean {
  return containsCodePoint(text, ARABIC_RANGES);
}

function containsCodePoint(text: string, ranges: readonly (readonly [number, number])[]): boolean {
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if (ranges.some(([first, last]) => point >= first && point <= last)) return true;
  }
  return false;
}
