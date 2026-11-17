import { resolveLogicalTextAlign, resolveTextDirection } from '@joy-media/render-ir';

export type CanvasTextDirection = 'ltr' | 'rtl' | 'auto';
export type CanvasTextAlignment = 'left' | 'center' | 'right' | 'start' | 'end';
export type PhysicalTextAlignment = 'left' | 'center' | 'right';

export interface WrappedCanvasText {
  readonly text: string;
  readonly lineDirections: readonly ('ltr' | 'rtl')[];
}

export const CANVAS_TEXT_FONT_FAMILIES = [
  'Inter Variable',
  'Vazirmatn Variable',
  'Noto Sans Arabic',
  'Noto Naskh Arabic',
] as const;

export async function waitForCanvasTextFonts(): Promise<void> {
  if (typeof document === 'undefined' || document.fonts === undefined) return;
  await Promise.all(
    CANVAS_TEXT_FONT_FAMILIES.map((family) =>
      document.fonts.load(`16px ${JSON.stringify(family)}`),
    ),
  );
}

const RTL_STRONG = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u{1ee00}-\u{1eeff}]/u;
const PERSIAN_SPECIFIC = /[\u067e\u0686\u0698\u06a9\u06af\u06cc\u06f0-\u06f9]/u;

export function resolveParagraphDirection(
  text: string,
  requested: CanvasTextDirection = 'auto',
): 'ltr' | 'rtl' {
  return resolveTextDirection(text, requested);
}

export function resolveParagraphDirections(
  text: string,
  requested: CanvasTextDirection = 'auto',
): readonly ('ltr' | 'rtl')[] {
  return text
    .split(/\r\n|\n|\r/u)
    .map((paragraph) => resolveParagraphDirection(paragraph, requested));
}

export function resolveCanvasTextAlign(
  align: CanvasTextAlignment,
  direction: 'ltr' | 'rtl',
): PhysicalTextAlignment {
  return resolveLogicalTextAlign(align, direction);
}

export function canvasFontFamilyStack(text: string, preferred?: string): readonly string[] {
  const scriptFallbacks = PERSIAN_SPECIFIC.test(text)
    ? ['Vazirmatn Variable', 'Noto Sans Arabic', 'Noto Naskh Arabic']
    : RTL_STRONG.test(text)
      ? ['Noto Sans Arabic', 'Vazirmatn Variable', 'Noto Naskh Arabic']
      : ['Vazirmatn Variable', 'Noto Sans Arabic', 'Noto Naskh Arabic'];
  return [
    ...new Set([
      ...(preferred === undefined ? [] : [preferred]),
      'Inter Variable',
      ...scriptFallbacks,
      'sans-serif',
    ]),
  ];
}

export function wrapTextByWords(
  text: string,
  maxWidth: number,
  measure: (candidate: string, direction: 'ltr' | 'rtl') => number,
  direction: CanvasTextDirection = 'auto',
): WrappedCanvasText {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    return { text, lineDirections: getLineDirections(text, direction) };
  }

  const outputLines: string[] = [];
  const outputDirections: ('ltr' | 'rtl')[] = [];
  for (const paragraph of text.split(/\r\n|\n|\r/u)) {
    const paragraphDirection = resolveParagraphDirection(paragraph, direction);
    const locale = resolveTextLocale(paragraph, paragraphDirection);
    const tokens = segmentWords(paragraph, locale);
    let line = '';
    for (const token of tokens) {
      if (token.wordLike) {
        const candidate = line + token.text;
        if (line.trim().length > 0 && measure(candidate.trimEnd(), paragraphDirection) > maxWidth) {
          pushLine(line.trimEnd(), paragraphDirection, outputLines, outputDirections);
          line = token.text.trimStart();
        } else if (
          line.trim().length === 0 &&
          measure(token.text.trim(), paragraphDirection) > maxWidth
        ) {
          if (resolveParagraphDirection(token.text) === 'rtl') {
            line = token.text;
          } else {
            const chunks = breakLongToken(token.text.trim(), maxWidth, measure, paragraphDirection);
            for (let index = 0; index < chunks.length - 1; index += 1) {
              pushLine(chunks[index]!, paragraphDirection, outputLines, outputDirections);
            }
            line = chunks.at(-1) ?? '';
          }
        } else {
          line = candidate;
        }
      } else {
        line += token.text;
      }
    }
    pushLine(line.trimEnd(), paragraphDirection, outputLines, outputDirections);
  }

  return { text: outputLines.join('\n'), lineDirections: outputDirections };
}

function getLineDirections(
  text: string,
  direction: CanvasTextDirection,
): readonly ('ltr' | 'rtl')[] {
  return text.split(/\r\n|\n|\r/u).map((line) => resolveParagraphDirection(line, direction));
}

function resolveTextLocale(text: string, direction: 'ltr' | 'rtl'): string {
  if (PERSIAN_SPECIFIC.test(text)) return 'fa';
  if (direction === 'rtl') return 'ar';
  return 'en';
}

function segmentWords(
  text: string,
  locale: string,
): { readonly text: string; readonly wordLike: boolean }[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
    return [...segmenter.segment(text)].map(({ segment, isWordLike }) => ({
      text: segment,
      wordLike: isWordLike === true,
    }));
  }
  return (text.match(/\s+|[^\s]+/gu) ?? []).map((segment) => ({
    text: segment,
    wordLike: !/^\s+$/u.test(segment),
  }));
}

function breakLongToken(
  token: string,
  maxWidth: number,
  measure: (candidate: string, direction: 'ltr' | 'rtl') => number,
  direction: 'ltr' | 'rtl',
): string[] {
  const graphemes =
    typeof Intl.Segmenter === 'function'
      ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(token)].map(
          ({ segment }) => segment,
        )
      : [...token];
  const chunks: string[] = [];
  let chunk = '';
  for (const grapheme of graphemes) {
    if (chunk.length > 0 && measure(chunk + grapheme, direction) > maxWidth) {
      chunks.push(chunk);
      chunk = grapheme;
    } else {
      chunk += grapheme;
    }
  }
  if (chunk.length > 0 || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

function pushLine(
  line: string,
  direction: 'ltr' | 'rtl',
  lines: string[],
  directions: ('ltr' | 'rtl')[],
): void {
  lines.push(line);
  directions.push(direction);
}
