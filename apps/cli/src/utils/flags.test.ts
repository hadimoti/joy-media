import { describe, expect, it } from 'vitest';
import { FlagValidationError, parseFloatFlag, parseIntFlag } from './flags.js';

describe('utils/flags (numeric flag validation)', () => {
  describe('parseIntFlag', () => {
    it('returns undefined for empty inputs', () => {
      expect(parseIntFlag('width', undefined)).toBeUndefined();
      expect(parseIntFlag('width', null)).toBeUndefined();
      expect(parseIntFlag('width', '')).toBeUndefined();
      expect(parseIntFlag('width', '   ')).toBeUndefined();
    });

    it('parses valid integers', () => {
      expect(parseIntFlag('width', '1920')).toBe(1920);
      expect(parseIntFlag('width', '0')).toBe(0);
      expect(parseIntFlag('width', 1080)).toBe(1080);
    });

    it('throws FlagValidationError on NaN / non-numeric strings', () => {
      expect(() => parseIntFlag('width', 'abc')).toThrow(FlagValidationError);
      expect(() => parseIntFlag('width', '12abc')).toThrow(FlagValidationError);
      expect(() => parseIntFlag('width', Number.NaN)).toThrow(FlagValidationError);
      expect(() => parseIntFlag('width', Number.POSITIVE_INFINITY)).toThrow(FlagValidationError);
    });

    it('enforces min/max ranges', () => {
      expect(() => parseIntFlag('fps', '0', { min: 1, max: 240 })).toThrow(/must be > 1/);
      expect(() => parseIntFlag('fps', '300', { min: 1, max: 240 })).toThrow(/must be <= 240/);
      expect(parseIntFlag('fps', '60', { min: 1, max: 240 })).toBe(60);
    });
  });

  describe('parseFloatFlag', () => {
    it('returns undefined for empty inputs', () => {
      expect(parseFloatFlag('start', undefined)).toBeUndefined();
      expect(parseFloatFlag('start', '')).toBeUndefined();
    });

    it('parses valid floats', () => {
      expect(parseFloatFlag('start', '1.5')).toBe(1.5);
      expect(parseFloatFlag('start', '-2.25')).toBe(-2.25);
    });

    it('throws on non-numeric strings', () => {
      expect(() => parseFloatFlag('start', 'foo')).toThrow(FlagValidationError);
      expect(() => parseFloatFlag('start', '1.2.3')).toThrow(FlagValidationError);
    });

    it('enforces ranges', () => {
      expect(() => parseFloatFlag('start', '-1', { min: 0, max: 100 })).toThrow(/must be >= 0/);
      expect(() => parseFloatFlag('duration', '0', { min: 0.001, max: 100 })).toThrow(
        /must be > 0/,
      );
      expect(parseFloatFlag('duration', '5', { min: 0.001, max: 100 })).toBe(5);
    });
  });

  it('FlagValidationError carries flag name and received value', () => {
    try {
      parseIntFlag('width', 'not-a-number');
      throw new Error('Expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FlagValidationError);
      const e = err as FlagValidationError;
      expect(e.flag).toBe('width');
      expect(e.received).toBe('not-a-number');
      expect(e.message).toMatch(/--width/);
    }
  });
});
