import { describe, expect, it } from 'vitest';
import { canvasFontWeight } from './browser.js';

describe('canvasFontWeight', () => {
  it('keeps the old bold and normal mapping for left-to-right text', () => {
    expect(canvasFontWeight(undefined, false)).toBe('normal');
    expect(canvasFontWeight(400, false)).toBe('normal');
    expect(canvasFontWeight(600, false)).toBe('normal');
    expect(canvasFontWeight(700, false)).toBe('bold');
    expect(canvasFontWeight(850, false)).toBe('bold');
  });

  it('gives right-to-left text the exact numeric weight of a variable font', () => {
    expect(canvasFontWeight(undefined, true)).toBe('400');
    expect(canvasFontWeight(600, true)).toBe('600');
    expect(canvasFontWeight(850, true)).toBe('850');
    expect(canvasFontWeight(5000, true)).toBe('1000');
    expect(canvasFontWeight(0, true)).toBe('1');
  });
});
