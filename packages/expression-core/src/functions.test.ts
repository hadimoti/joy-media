import { describe, expect, it } from 'vitest';
import { ALLOWED_FUNCTIONS, seededUnitRandom } from './functions.js';

describe('ALLOWED_FUNCTIONS', () => {
  it('computes the expected math functions', () => {
    expect(ALLOWED_FUNCTIONS['abs']!([-4])).toBe(4);
    expect(ALLOWED_FUNCTIONS['floor']!([1.9])).toBe(1);
    expect(ALLOWED_FUNCTIONS['ceil']!([1.1])).toBe(2);
    expect(ALLOWED_FUNCTIONS['round']!([1.5])).toBe(2);
    expect(ALLOWED_FUNCTIONS['pow']!([2, 10])).toBe(1024);
    expect(ALLOWED_FUNCTIONS['sqrt']!([9])).toBe(3);
    expect(ALLOWED_FUNCTIONS['min']!([3, 1, 2])).toBe(1);
    expect(ALLOWED_FUNCTIONS['max']!([3, 1, 2])).toBe(3);
    expect(ALLOWED_FUNCTIONS['clamp']!([15, 0, 10])).toBe(10);
    expect(ALLOWED_FUNCTIONS['clamp']!([-5, 0, 10])).toBe(0);
    expect(ALLOWED_FUNCTIONS['lerp']!([0, 100, 0.25])).toBe(25);
    expect(ALLOWED_FUNCTIONS['mix']!([0, 100, 0.75])).toBe(75);
  });

  it('rejects wrong arity instead of silently coercing', () => {
    expect(() => ALLOWED_FUNCTIONS['clamp']!([1, 2])).toThrow(/expects 3 argument/);
    expect(() => ALLOWED_FUNCTIONS['sin']!([])).toThrow(/expects 1 argument/);
    expect(() => ALLOWED_FUNCTIONS['min']!([])).toThrow(/at least 1 argument/);
  });

  it('random() is deterministic and referentially transparent for the same seed', () => {
    const a = ALLOWED_FUNCTIONS['random']!([42]);
    const b = ALLOWED_FUNCTIONS['random']!([42]);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });

  it('random() differs across seeds (not a constant)', () => {
    expect(seededUnitRandom(1)).not.toBe(seededUnitRandom(2));
  });
});
