import { describe, expect, it } from 'vitest';
import { clipChromeLayout } from './timeline-clip-chrome-layout.js';

const both = { flagCount: 2, hasBadge: true };

describe('clipChromeLayout', () => {
  it('shows only a compact icon on a very narrow clip', () => {
    expect(clipChromeLayout(40, both)).toEqual({
      chrome: false,
      badge: false,
      flags: false,
      duration: false,
    });
  });

  it('drops the length first, then the effect icons, then the speed badge', () => {
    // 30 base + 54 badge + 36 flags + 44 length = 164
    expect(clipChromeLayout(170, both)).toMatchObject({ badge: true, flags: true, duration: true });
    expect(clipChromeLayout(150, both)).toMatchObject({
      badge: true,
      flags: true,
      duration: false,
    });
    expect(clipChromeLayout(100, both)).toMatchObject({
      badge: true,
      flags: false,
      duration: false,
    });
    expect(clipChromeLayout(70, both)).toMatchObject({ badge: false, flags: true });
    expect(clipChromeLayout(50, both)).toMatchObject({
      chrome: true,
      badge: false,
      flags: false,
      duration: false,
    });
  });

  it('never shows a part that is not there', () => {
    expect(clipChromeLayout(300, { flagCount: 0, hasBadge: false })).toEqual({
      chrome: true,
      badge: false,
      flags: false,
      duration: true,
    });
  });
});
