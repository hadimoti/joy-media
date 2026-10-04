import { describe, expect, it } from 'vitest';
import { wrapDrawtextDirection } from './text-clip.js';

describe('drawtext bidi direction', () => {
  it('wraps every RTL line in RLE/PDF controls', () => {
    expect(wrapDrawtextDirection('سلام\nJoy 2026', 'rtl')).toBe(
      '\u202bسلام\u202c\n\u202bJoy 2026\u202c',
    );
  });

  it('wraps explicit LTR lines in LRE/PDF controls', () => {
    expect(wrapDrawtextDirection('Joy 2026\nsecond', 'ltr')).toBe(
      '\u202aJoy 2026\u202c\n\u202asecond\u202c',
    );
  });
});
