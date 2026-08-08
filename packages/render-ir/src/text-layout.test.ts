import { describe, expect, it } from 'vitest';
import { textPlateBounds } from './text-layout.js';

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
});
