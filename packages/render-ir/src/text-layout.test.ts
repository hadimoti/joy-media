import { describe, expect, it } from 'vitest';
import {
  resolveLogicalTextAlign,
  resolveTextDirection,
  textPlateBounds,
  resolveTextWrapWidth,
  TEXT_SAFE_AREA_MARGIN_FRACTION,
} from './text-layout.js';
import * as textLayout from './text-layout.js';

describe('resolveTextWrapWidth', () => {
  it('uses the central 90 percent of the composition by default', () => {
    expect(TEXT_SAFE_AREA_MARGIN_FRACTION).toBe(0.05);
    expect(resolveTextWrapWidth(1920)).toBe(1728);
    expect(resolveTextWrapWidth(1080)).toBe(972);
  });

  it('uses an explicit maxWidth when supplied', () => {
    expect(resolveTextWrapWidth(1920, 640)).toBe(640);
  });
});

describe('resolveParagraphTextDirections', () => {
  it('resolves each paragraph separately and carries an explicit direction through all paragraphs', () => {
    const resolver = Reflect.get(textLayout, 'resolveParagraphTextDirections') as
      ((text: string, requested: 'ltr' | 'rtl' | 'auto') => readonly ('ltr' | 'rtl')[]) | undefined;

    expect(typeof resolver).toBe('function');
    expect(resolver?.('日本語\nسلام', 'auto')).toEqual(['ltr', 'rtl']);
    expect(resolver?.('日本語\nسلام', 'rtl')).toEqual(['rtl', 'rtl']);
  });
});

describe('textPlateBounds', () => {
  it('places left, centered, and right-aligned plates around the same text run', () => {
    expect(textPlateBounds(100, 20, 'left', 4)).toEqual({
      x: -4,
      y: -4,
      width: 108,
      height: 28,
    });
    expect(textPlateBounds(100, 20, 'center', 4).x).toBe(-54);
    expect(textPlateBounds(100, 20, 'right', 4).x).toBe(-104);
  });

  it('clamps invalid negative dimensions and padding', () => {
    expect(textPlateBounds(-10, -20, 'left', -3)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it('resolves auto direction and logical alignment without changing physical alignment', () => {
    expect(resolveTextDirection('123 456', 'auto')).toBe('ltr');
    expect(resolveTextDirection('سلام', 'auto')).toBe('rtl');
    expect(resolveTextDirection('JOY Media', 'auto')).toBe('ltr');
    expect(resolveLogicalTextAlign('start', 'rtl')).toBe('right');
    expect(resolveLogicalTextAlign('end', 'rtl')).toBe('left');
    expect(textPlateBounds(100, 20, 'start', 4, 'rtl').x).toBe(-104);
    expect(textPlateBounds(100, 20, 'start', 4, 'ltr').x).toBe(-4);
  });

  it('resolves RTL direction from Persian and Arabic-Indic digits unless a strong letter decides first', () => {
    expect(resolveTextDirection('\u06F1\u06F4\u06F0\u06F2/\u06F0\u06F8/\u06F2\u06F5', 'auto')).toBe(
      'rtl',
    );
    expect(resolveTextDirection('\u0661\u0662\u0663', 'auto')).toBe('rtl');
    expect(resolveTextDirection('123 456', 'auto')).toBe('ltr');
    expect(resolveTextDirection('\u06F1\u06F2\u06F3 JOY', 'auto')).toBe('ltr');
  });

  it('follows UAX #9: CJK letters are strong left-to-right, and the right-to-left script blocks resolve rtl', () => {
    expect(resolveTextDirection('日本語 سلام', 'auto')).toBe('ltr');
    for (const [name, sample] of [
      ['Adlam', '\u{1E900}'],
      ['Garay', '\u{10D4A}'],
      ['Hanifi Rohingya', '\u{10D00}'],
      ['Yezidi', '\u{10E80}'],
      ['Old Uyghur', '\u{10F70}'],
      ['Chorasmian', '\u{10FB0}'],
      ['Rumi numeral', '\u{10E60}'],
    ] as const) {
      expect(resolveTextDirection(sample, 'auto'), name).toBe('rtl');
    }
  });
});
