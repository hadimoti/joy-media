import { describe, expect, it } from 'vitest';
import {
  canvasFontFamilyStack,
  resolveCanvasTextAlign,
  resolveParagraphDirection,
  resolveParagraphDirections,
  wrapTextByWords,
} from './text-direction.js';

describe('canvas text direction', () => {
  it.each([
    ['Persian', 'سلام', 'rtl'],
    ['Arabic', 'مرحبا', 'rtl'],
    ['Latin', 'JOY Media', 'ltr'],
    ['mixed text after digits', '123 سلام', 'rtl'],
    ['digits only', '123 ٤٥٦', 'ltr'],
    ['empty text', '', 'ltr'],
  ] as const)('resolves %s from its first strong character', (_name, text, direction) => {
    expect(resolveParagraphDirection(text, 'auto')).toBe(direction);
  });

  it('resolves auto direction separately for each paragraph', () => {
    expect(resolveParagraphDirection('سلام\nJOY', 'auto')).toBe('rtl');
    expect(resolveParagraphDirection('JOY\nسلام', 'auto')).toBe('ltr');
    expect(resolveParagraphDirections('سلام\nJOY', 'auto')).toEqual(['rtl', 'ltr']);
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

    expect(result.text).toBe('سلام');
    expect(result.lineDirections).toEqual(['rtl']);
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
});
