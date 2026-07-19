import { describe, expect, it } from 'vitest';
import { VISUAL_INSPECTOR, sharedValue } from './index.js';
describe('visual property schemas', () => {
  it('covers transform, opacity, and crop without per-object forms', () => {
    expect(VISUAL_INSPECTOR.map((field) => field.key)).toEqual([
      'x',
      'y',
      'scaleX',
      'scaleY',
      'rotationDeg',
      'opacity',
      'crop',
    ]);
    expect(sharedValue([1, 1])).toBe(1);
    expect(sharedValue([1, 2])).toBeUndefined();
  });
});
