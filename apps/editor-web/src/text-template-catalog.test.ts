import { describe, expect, it } from 'vitest';
import { TEXT_TEMPLATES } from './text-template-catalog.js';

describe('native text template catalog', () => {
  it('ships sixteen editable starter treatments across the requested categories', () => {
    expect(TEXT_TEMPLATES).toHaveLength(16);
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
});
