import { describe, expect, it } from 'vitest';
import { TEXT_TEMPLATES } from './text-template-catalog.js';

describe('native text template catalog', () => {
  it('ships editable starter treatments across the requested categories', () => {
    expect(TEXT_TEMPLATES).toHaveLength(19);
    expect(new Set(TEXT_TEMPLATES.map((template) => template.category))).toEqual(
      new Set(['Titles', 'Lower thirds', 'Highlights', 'Social']),
    );
    expect(
      TEXT_TEMPLATES.find((template) => template.id === 'highlight-word')?.document.blocks[0]?.runs,
    ).toEqual([
      { text: 'Make every ' },
      { text: 'FRAME', style: { highlightColor: '#f6c453' } },
      { text: ' count' },
    ]);
  });

  it('includes RTL / Persian treatments on the deployed Vazirmatn face', () => {
    const rtl = TEXT_TEMPLATES.filter((t) => t.style.direction === 'rtl');
    expect(rtl.map((t) => t.id)).toEqual(['rtl-editorial-title', 'rtl-name-role', 'rtl-quote-focus']);
    for (const template of rtl) {
      expect(template.style.fontFamily).toBe('Vazirmatn Variable');
      expect(template.style.align).toBe('start');
    }
  });
});
