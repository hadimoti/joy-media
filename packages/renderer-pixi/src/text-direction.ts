import {
  resolveLogicalTextAlign,
  resolveParagraphTextDirections as resolveSharedParagraphTextDirections,
  resolveTextDirection,
} from '@joy-media/render-ir';

export type CanvasTextDirection = 'ltr' | 'rtl' | 'auto';
export type CanvasTextAlignment = 'left' | 'center' | 'right' | 'start' | 'end';
export type PhysicalTextAlignment = 'left' | 'center' | 'right';

export interface WrappedCanvasText {
  readonly text: string;
  readonly lineDirections: readonly ('ltr' | 'rtl')[];
}

export interface CanvasTextFontRequest {
  readonly text: string;
  readonly families: readonly string[];
  readonly fontSizePx: number;
  readonly fontWeight: number;
  readonly italic: boolean;
}

export const CANVAS_TEXT_FONT_FAMILIES = [
  'Inter Variable',
  'Vazirmatn Variable',
  'Noto Sans Arabic',
  'Noto Naskh Arabic',
] as const;

const CANVAS_TEXT_FONT_SAMPLES = [
  { family: 'Inter Variable', text: 'JOY 123' },
  { family: 'Vazirmatn Variable', text: 'سلام ۱۲۳' },
  { family: 'Noto Sans Arabic', text: 'مرحبا' },
  { family: 'Noto Naskh Arabic', text: 'مرحبا' },
] as const;

export async function waitForCanvasTextFonts(): Promise<void> {
  if (typeof document === 'undefined' || document.fonts === undefined) return;
  await Promise.all(
    CANVAS_TEXT_FONT_SAMPLES.map(({ family, text }) =>
      document.fonts.load(`16px ${JSON.stringify(family)}`, text),
    ),
  );
}

export async function waitForCanvasTextFontsForText(request: CanvasTextFontRequest): Promise<void> {
  if (typeof document === 'undefined' || document.fonts === undefined || request.text.length === 0)
    return;
  const style = `${request.italic ? 'italic ' : ''}${request.fontWeight} ${request.fontSizePx}px`;
  await Promise.all(
    [...new Set(request.families)].map((family) =>
      document.fonts.load(`${style} ${JSON.stringify(family)}`, request.text),
    ),
  );
}

const RTL_STRONG = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u{1ee00}-\u{1eeff}]/u;
const PERSIAN_SPECIFIC = /[\u067e\u0686\u0698\u06a9\u06af\u06cc\u06f0-\u06f9\u200c]/u;
const ARABIC_JOINING_SCRIPT = /\p{Script=Arabic}/u;
const segmenterCache = new Map<string, Intl.Segmenter>();

function getSegmenter(
  locale: string | undefined,
  granularity: 'grapheme' | 'word',
): Intl.Segmenter | undefined {
  if (typeof Intl.Segmenter !== 'function') return undefined;
  const key = `${locale ?? ''}:${granularity}`;
  let segmenter = segmenterCache.get(key);
  if (segmenter === undefined) {
    segmenter = new Intl.Segmenter(locale, { granularity });
    segmenterCache.set(key, segmenter);
  }
  return segmenter;
}

function fallbackGraphemes(text: string): string[] {
  const graphemes: string[] = [];
  for (const character of text) {
    const previous = graphemes.length - 1;
    const extendsPrevious =
      previous >= 0 &&
      (/^\p{Mark}$/u.test(character) ||
        character === '\u200c' ||
        character === '\u200d' ||
        graphemes[previous]!.endsWith('\u200d'));
    if (extendsPrevious) graphemes[previous] += character;
    else graphemes.push(character);
  }
  return graphemes;
}

export function countTextGraphemes(text: string): number {
  const segmenter = getSegmenter(undefined, 'grapheme');
  return segmenter === undefined
    ? fallbackGraphemes(text).length
    : [...segmenter.segment(text)].length;
}

/** Keep Arabic/Persian letters joined by omitting character tracking for their runs. */
export function resolveCanvasTextTracking(text: string, tracking: number): number {
  return ARABIC_JOINING_SCRIPT.test(text) ? 0 : tracking;
}

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
  return resolveSharedParagraphTextDirections(text, requested);
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
    const isolatedText = text
      .split(/(https?:\/\/[^\s]+)/giu)
      .map((part) => (/^https?:\/\//iu.test(part) ? `\u2068${part}\u2069` : part))
      .join('');
    return { text: isolatedText, lineDirections: getLineDirections(isolatedText, direction) };
  }

  const outputLines: string[] = [];
  const outputDirections: ('ltr' | 'rtl')[] = [];
  for (const paragraph of text.split(/\r\n|\n|\r/u)) {
    const paragraphDirection = resolveParagraphDirection(paragraph, direction);
    const locale = resolveTextLocale(paragraph, paragraphDirection);
    const tokens = segmentWords(paragraph, locale);
    let line = '';
    for (const token of tokens) {
      if (/^\s+$/u.test(token)) {
        if (line.trim().length === 0) continue;
        if (measure(line + token, paragraphDirection) > maxWidth) {
          pushLine(line.trimEnd(), paragraphDirection, outputLines, outputDirections);
          line = '';
        } else {
          line += token;
        }
        continue;
      }

      const content = token.trimStart();
      if (content.length === 0) continue;
      if (line.trim().length > 0) {
        const candidate = line + content;
        if (measure(candidate.trimEnd(), paragraphDirection) > maxWidth) {
          pushLine(line.trimEnd(), paragraphDirection, outputLines, outputDirections);
          line = '';
        } else {
          line = candidate;
          continue;
        }
      }

      const isIsolatedUrl = /^\u2068https?:\/\/.*\u2069$/u.test(content);
      if (!isIsolatedUrl && measure(content, paragraphDirection) > maxWidth) {
        const chunks = breakLongToken(content, maxWidth, measure, paragraphDirection);
        for (let index = 0; index < chunks.length - 1; index += 1) {
          pushLine(chunks[index]!, paragraphDirection, outputLines, outputDirections);
        }
        line = chunks.at(-1) ?? '';
      } else {
        line = content;
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

function segmentWords(text: string, locale: string): string[] {
  const urlPattern = /https?:\/\/[^\s]+/giu;
  const segments: string[] = [];
  let offset = 0;
  for (const match of text.matchAll(urlPattern)) {
    const index = match.index ?? 0;
    if (index > offset)
      segments.push(...segmentWordsWithoutUrls(text.slice(offset, index), locale));
    const url = match[0];
    segments.push(`\u2068${url}\u2069`);
    offset = index + url.length;
  }
  if (offset === 0) return segmentWordsWithoutUrls(text, locale);
  if (offset < text.length) segments.push(...segmentWordsWithoutUrls(text.slice(offset), locale));
  return segments;
}

function segmentWordsWithoutUrls(text: string, locale: string): string[] {
  const segmenter = getSegmenter(locale, 'word');
  if (segmenter !== undefined) {
    return [...segmenter.segment(text)].map(({ segment }) => segment);
  }
  return text.match(/\s+|[^\s]+/gu) ?? [];
}

function breakLongToken(
  token: string,
  maxWidth: number,
  measure: (candidate: string, direction: 'ltr' | 'rtl') => number,
  direction: 'ltr' | 'rtl',
): string[] {
  const segmenter = getSegmenter(undefined, 'grapheme');
  const graphemes =
    segmenter === undefined
      ? fallbackGraphemes(token)
      : [...segmenter.segment(token)].map(({ segment }) => segment);
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

/**
 * Creates the same word-wrap helper's runtime source for Playwright's isolated page context.
 * The caller supplies a resolved paragraph direction; font measurement still runs in the page.
 */
export function serializeTextWrapRuntimeSource(): string {
  return `(() => {
    const PERSIAN_SPECIFIC = new RegExp(${JSON.stringify(PERSIAN_SPECIFIC.source)}, ${JSON.stringify(PERSIAN_SPECIFIC.flags)});
    const segmenterCache = new Map();
    const getSegmenter = ${getSegmenter.toString()};
    const fallbackGraphemes = ${fallbackGraphemes.toString()};
    const resolveParagraphDirection = (_text, requested = 'auto') => {
      if (requested === 'ltr' || requested === 'rtl') return requested;
      throw new Error('A resolved direction is required by the GPU text wrapper');
    };
    const getLineDirections = ${getLineDirections.toString()};
    const resolveTextLocale = ${resolveTextLocale.toString()};
    const segmentWords = ${segmentWords.toString()};
    const segmentWordsWithoutUrls = ${segmentWordsWithoutUrls.toString()};
    const breakLongToken = ${breakLongToken.toString()};
    const pushLine = ${pushLine.toString()};
    return ${wrapTextByWords.toString()};
  })()`;
}
