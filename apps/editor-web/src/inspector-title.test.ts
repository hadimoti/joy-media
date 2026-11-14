import { describe, expect, it } from 'vitest';
import { inspectorClipTitle } from './inspector-title.js';

describe('inspectorClipTitle (the Inspector header never shows a clip id)', () => {
  it('uses the media file name first', () => {
    expect(inspectorClipTitle({ assetName: 'Golden hour.mp4', kindLabel: 'Video' })).toBe(
      'Golden hour.mp4',
    );
  });

  it('uses the words of a text clip, joined and shortened', () => {
    expect(
      inspectorClipTitle({
        object: {
          kind: 'text',
          textDocument: { blocks: [{ runs: [{ text: 'Clean ' }, { text: 'title' }] }] },
        },
        kindLabel: 'Text',
      }),
    ).toBe('Clean title');
    const long = 'x'.repeat(80);
    const shortened = inspectorClipTitle({ object: { kind: 'text', text: long } });
    expect(shortened).toHaveLength(40);
    expect(shortened.endsWith('…')).toBe(true);
  });

  it('falls back to the kind of element, then to Clip', () => {
    expect(inspectorClipTitle({ object: { kind: 'text', text: '  ' }, kindLabel: 'Text' })).toBe(
      'Text',
    );
    expect(inspectorClipTitle({ kindLabel: 'Sticker' })).toBe('Sticker');
    expect(inspectorClipTitle({})).toBe('Clip');
  });
});
