import { describe, expect, it } from 'vitest';
import { splitTextUnits, staggerOffsets } from './text.js';

describe('splitTextUnits', () => {
  it('splits by character, word, and line', () => {
    expect(splitTextUnits('ab', 'character')).toEqual(['a', 'b']);
    expect(splitTextUnits('hello  world', 'word')).toEqual(['hello', 'world']);
    expect(splitTextUnits('one\ntwo', 'line')).toEqual(['one', 'two']);
  });

  it('counts Persian characters by code point', () => {
    expect(splitTextUnits('سلام', 'character')).toHaveLength(4);
    expect(splitTextUnits('سلام به جوی', 'word')).toEqual(['سلام', 'به', 'جوی']);
  });
});

describe('staggerOffsets', () => {
  it('delays each unit by its index', () => {
    expect(staggerOffsets({ unitCount: 3, startUs: 0, perUnitDelayUs: 100_000 })).toEqual([
      0, 100_000, 200_000,
    ]);
  });

  it('honors a start offset', () => {
    expect(staggerOffsets({ unitCount: 2, startUs: 500_000, perUnitDelayUs: 50_000 })).toEqual([
      500_000, 550_000,
    ]);
  });

  it('reverses so the last unit starts first', () => {
    expect(
      staggerOffsets({ unitCount: 3, startUs: 0, perUnitDelayUs: 100_000, reverse: true }),
    ).toEqual([200_000, 100_000, 0]);
  });

  it('rejects negative counts and delays', () => {
    expect(() => staggerOffsets({ unitCount: -1, startUs: 0, perUnitDelayUs: 0 })).toThrow();
    expect(() => staggerOffsets({ unitCount: 1, startUs: 0, perUnitDelayUs: -5 })).toThrow();
  });
});
