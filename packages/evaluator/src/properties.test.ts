import { describe, expect, it } from 'vitest';
import { evaluateStaticProperty, queryActiveIntervals } from './properties.js';

describe('active intervals and static properties', () => {
  it('uses end-exclusive intervals and stable timeline order', () => {
    expect(
      queryActiveIntervals(
        [
          { id: 'later', startUs: 0, durationUs: 1_000, order: 2 },
          { id: 'first', startUs: 0, durationUs: 1_000, order: 1 },
          { id: 'ended', startUs: 0, durationUs: 1_000, order: 0 },
        ],
        1_000,
      ),
    ).toEqual([]);
    expect(
      queryActiveIntervals(
        [
          { id: 'later', startUs: 0, durationUs: 1_000, order: 2 },
          { id: 'first', startUs: 0, durationUs: 1_000, order: 1 },
        ],
        999,
      ).map((entity) => entity.id),
    ).toEqual(['first', 'later']);
  });

  it('evaluates static properties without renderer state', () => {
    expect(evaluateStaticProperty({ value: 0.75 })).toBe(0.75);
    expect(evaluateStaticProperty({ value: 0.75, enabled: false })).toBeUndefined();
  });
});
