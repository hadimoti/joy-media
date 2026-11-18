import { describe, expect, it } from 'vitest';
import * as textPanelExports from './TextPanel.js';
import type { VisualObjectV1 } from '@joy-media/project-schema';

const textObjectWithDraftText = (
  textPanelExports as unknown as {
    textObjectWithDraftText?: (object: VisualObjectV1, draftText: string) => VisualObjectV1;
  }
).textObjectWithDraftText;

const textObject = (extra: Partial<VisualObjectV1> = {}): VisualObjectV1 =>
  ({
    id: 'title-1',
    kind: 'text',
    text: 'old',
    textDocument: { version: 1, blocks: [{ id: 'title-block', runs: [{ text: 'old' }] }] },
    textStyle: {
      fontFamily: 'Vazirmatn Variable',
      fontSizePx: 48,
      fontWeight: 700,
      italic: false,
      lineHeight: 1.15,
      tracking: 0,
      direction: 'rtl',
      align: 'right',
      fill: { kind: 'solid', color: '#fff' },
      blendMode: 'normal',
      opacity: 1,
    },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    },
    ...extra,
  }) as VisualObjectV1;

describe('TextPanel text document edits', () => {
  it('stores the exact text in the document and keeps RTL direction', () => {
    expect(textObjectWithDraftText).toBeTypeOf('function');
    const updated = textObjectWithDraftText!(textObject(), 'سلام\nدوست من');
    expect(updated.text).toBe('سلام\nدوست من');
    expect(updated.textDocument).toEqual({
      version: 1,
      blocks: [{ id: 'title-block', runs: [{ text: 'سلام\nدوست من' }] }],
    });
    expect(updated.textStyle?.direction).toBe('rtl');
  });

  it('preserves TextPanel empty text as one empty run', () => {
    expect(textObjectWithDraftText).toBeTypeOf('function');
    const updated = textObjectWithDraftText!(textObject(), '');
    expect(updated.text).toBe('');
    expect(updated.textDocument).toEqual({
      version: 1,
      blocks: [{ id: 'title-block', runs: [{ text: '' }] }],
    });
  });
});
