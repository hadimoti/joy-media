import { describe, expect, it } from 'vitest';
import { resolveLogicalTextAlign, resolveTextDirection, textPlateBounds } from './text-layout.js';

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
    expect(resolveTextDirection('123 ٤٥٦', 'auto')).toBe('ltr');
    expect(resolveTextDirection('سلام', 'auto')).toBe('rtl');
    expect(resolveTextDirection('JOY Media', 'auto')).toBe('ltr');
    expect(resolveLogicalTextAlign('start', 'rtl')).toBe('right');
    expect(resolveLogicalTextAlign('end', 'rtl')).toBe('left');
    expect(textPlateBounds(100, 20, 'start', 4, 'rtl').x).toBe(-104);
    expect(textPlateBounds(100, 20, 'start', 4, 'ltr').x).toBe(-4);
  });
});
