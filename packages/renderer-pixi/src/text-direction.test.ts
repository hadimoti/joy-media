import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canvasFontFamilyStack,
  countTextGraphemes,
  resolveCanvasTextAlign,
  resolveCanvasTextTracking,
  resolveParagraphDirection,
  resolveParagraphDirections,
  waitForCanvasTextFontsForText,
  waitForCanvasTextFonts,
  wrapTextByWords,
} from './text-direction.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('canvas text direction', () => {
  it('does not apply character tracking inside Arabic joining runs', () => {
    expect(resolveCanvasTextTracking('سلام دنیا', 2)).toBe(0);
    expect(resolveCanvasTextTracking('שלום', 2)).toBe(2);
    expect(resolveCanvasTextTracking('JOY MEDIA', 2)).toBe(2);
  });

  it('reuses word and grapheme segmenters across repeated wraps', () => {
    const NativeSegmenter = Intl.Segmenter;
    const constructions = vi.fn();
    class CountingSegmenter extends NativeSegmenter {
      constructor(locales?: Intl.LocalesArgument, options?: Intl.SegmenterOptions) {
        constructions();
        super(locales, options);
      }
    }
    const intl = new Proxy(Intl, {
      get(target, property, receiver) {
        return property === 'Segmenter'
          ? CountingSegmenter
          : Reflect.get(target, property, receiver);
      },
    });
    vi.stubGlobal('Intl', intl);

    const text = 'exceptionallylongenglishword';
    wrapTextByWords(text, 10, (candidate) => [...candidate].length, 'ltr');
    wrapTextByWords(text, 10, (candidate) => [...candidate].length, 'ltr');

    expect(constructions).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['Persian', 'سلام', 'rtl'],
    ['Arabic', 'مرحبا', 'rtl'],
    ['Latin', 'JOY Media', 'ltr'],
    ['mixed text after digits', '123 سلام', 'rtl'],
    ['Latin digits only', '123 456', 'ltr'],
    ['Arabic-Indic digits only', '\u0661\u0662\u0663', 'rtl'],
    ['Persian digits only', '\u06F1\u06F2\u06F3', 'rtl'],
    ['empty text', '', 'ltr'],
  ] as const)('resolves %s from its first strong character', (_name, text, direction) => {
    expect(resolveParagraphDirection(text, 'auto')).toBe(direction);
  });

  it('resolves auto direction separately for each paragraph', () => {
    expect(resolveParagraphDirection('سلام\nJOY', 'auto')).toBe('rtl');
    expect(resolveParagraphDirection('JOY\nسلام', 'auto')).toBe('ltr');
    expect(resolveParagraphDirections('سلام\nJOY', 'auto')).toEqual(['rtl', 'ltr']);
  });

  it('uses the shared strong-direction resolver for CJK-prefixed Arabic paragraphs', () => {
    expect(resolveParagraphDirection('日本語 سلام', 'auto')).toBe('ltr');
  });

  it('wraps Persian at word boundaries and keeps the ZWNJ word intact', () => {
    const result = wrapTextByWords(
      'من می‌خواهم فارسی بخوانم',
      9,
      (text) => [...text].length,
      'auto',
    );
    expect(
      result.text.split('\n').every((line) => !line.includes('می') || line.includes('می‌خواهم')),
    ).toBe(true);
    expect(result.text).toContain('می‌خواهم');
    expect(result.lineDirections).toEqual(result.text.split('\n').map(() => 'rtl'));
  });

  it('keeps an RTL word intact when it exceeds the available width', () => {
    const result = wrapTextByWords('سلام', 2, (text) => [...text].length, 'auto');

    expect(result.text).toBe('سل\nام');
    expect(result.lineDirections).toEqual(['rtl', 'rtl']);
  });

  it('splits an oversized RTL token only at grapheme boundaries', () => {
    const result = wrapTextByWords('\u0628\u0650\u0633', 1, countTextGraphemes, 'auto');

    expect(result.text).toBe('\u0628\u0650\n\u0633');
    expect(result.lineDirections).toEqual(['rtl', 'rtl']);
  });

  it('keeps combining marks attached when Intl.Segmenter is unavailable', () => {
    const intl = new Proxy(Intl, {
      get(target, property, receiver) {
        return property === 'Segmenter' ? undefined : Reflect.get(target, property, receiver);
      },
    });
    vi.stubGlobal('Intl', intl);

    const result = wrapTextByWords('\u0628\u0650\u0633', 1, countTextGraphemes, 'auto');

    expect(result.text).toBe('\u0628\u0650\n\u0633');
  });

  it('wraps oversized punctuation tokens instead of allowing them past maxWidth', () => {
    const result = wrapTextByWords('\u0633 !!!', 2, countTextGraphemes, 'auto');

    expect(result.text).toBe('\u0633\n!!\n!');
    expect(result.lineDirections).toEqual(['rtl', 'rtl', 'rtl']);
    expect(result.text.split('\n').every((line) => countTextGraphemes(line) <= 2)).toBe(true);
  });

  it('keeps Latin word wrapping compatible with the existing line breaks', () => {
    const result = wrapTextByWords('The story starts here', 11, (text) => [...text].length, 'ltr');
    expect(result.text).toBe('The story\nstarts here');
    expect(result.lineDirections).toEqual(['ltr', 'ltr']);
  });

  it('resolves logical alignment against paragraph direction', () => {
    expect(resolveCanvasTextAlign('start', 'rtl')).toBe('right');
    expect(resolveCanvasTextAlign('start', 'ltr')).toBe('left');
    expect(resolveCanvasTextAlign('end', 'ltr')).toBe('right');
    expect(resolveCanvasTextAlign('end', 'rtl')).toBe('left');
    expect(resolveCanvasTextAlign('center', 'rtl')).toBe('center');
    expect(resolveCanvasTextAlign('right', 'ltr')).toBe('right');
  });

  it('puts the Latin font first and chooses the script font before the fallback', () => {
    const latin = canvasFontFamilyStack('JOY Media');
    const persian = canvasFontFamilyStack('می‌خواهم');
    const arabic = canvasFontFamilyStack('مرحبا');

    expect(latin[0]).toBe('Inter Variable');
    expect(persian.slice(0, 3)).toEqual([
      'Inter Variable',
      'Vazirmatn Variable',
      'Noto Sans Arabic',
    ]);
    expect(arabic.slice(0, 3)).toEqual([
      'Inter Variable',
      'Noto Sans Arabic',
      'Vazirmatn Variable',
    ]);
  });

  it('prefers Vazirmatn for Arabic-script text containing a ZWNJ', () => {
    expect(canvasFontFamilyStack('\u0646\u0647\u200c').slice(0, 3)).toEqual([
      'Inter Variable',
      'Vazirmatn Variable',
      'Noto Sans Arabic',
    ]);
  });

  it('loads script-specific font subsets before the first canvas render', async () => {
    const calls: Array<{ font: string; text: string | undefined }> = [];
    vi.stubGlobal('document', {
      fonts: {
        load: async (font: string, text?: string) => {
          calls.push({ font, text });
          return [];
        },
      },
    });

    await waitForCanvasTextFonts();

    expect(calls).toContainEqual({ font: '16px "Vazirmatn Variable"', text: 'سلام ۱۲۳' });
    expect(calls).toContainEqual({ font: '16px "Noto Sans Arabic"', text: 'مرحبا' });
    expect(calls).toContainEqual({ font: '16px "Inter Variable"', text: 'JOY 123' });
  });

  it('loads the exact text sample at its family, size, weight, and style', async () => {
    const calls: Array<{ font: string; text: string | undefined }> = [];
    vi.stubGlobal('document', {
      fonts: {
        load: async (font: string, text?: string) => {
          calls.push({ font, text });
          return [];
        },
      },
    });

    await waitForCanvasTextFontsForText({
      text: '\u0633\u0644\u0627\u0645 \u06f1\u06f2\u06f3',
      families: ['Vazirmatn Variable', 'Noto Sans Arabic'],
      fontSizePx: 108,
      fontWeight: 850,
      italic: true,
    });

    expect(calls).toEqual([
      {
        font: 'italic 850 108px "Vazirmatn Variable"',
        text: '\u0633\u0644\u0627\u0645 \u06f1\u06f2\u06f3',
      },
      {
        font: 'italic 850 108px "Noto Sans Arabic"',
        text: '\u0633\u0644\u0627\u0645 \u06f1\u06f2\u06f3',
      },
    ]);
  });
});
