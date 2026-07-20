import { describe, expect, it } from 'vitest';
import { PreviewStemCache, computeStemHash } from './stems.js';
import type { PreviewStem } from './stems.js';

describe('preview stem cache', () => {
  function createStem(
    stemId: string,
    clipId: string,
    effectId: string,
    hash: string,
  ): PreviewStem {
    return {
      stemId,
      clipId,
      effectId,
      hash,
      samples: new Float32Array([0.1, 0.2, 0.3]),
      sampleRate: 48000,
      createdAt: new Date().toISOString(),
    };
  }

  describe('PreviewStemCache', () => {
    it('stores and retrieves stems', () => {
      const cache = new PreviewStemCache();
      const stem = createStem('stem1', 'clip1', 'eq1', 'hash1');
      cache.set(stem);
      expect(cache.get('stem1')).toBe(stem);
    });

    it('returns undefined for missing stem', () => {
      const cache = new PreviewStemCache();
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('invalidates stems by clipId', () => {
      const cache = new PreviewStemCache();
      cache.set(createStem('stem1', 'clip1', 'eq1', 'hash1'));
      cache.set(createStem('stem2', 'clip1', 'comp1', 'hash2'));
      cache.set(createStem('stem3', 'clip2', 'eq1', 'hash3'));

      cache.invalidate('clip1');

      expect(cache.get('stem1')).toBeUndefined();
      expect(cache.get('stem2')).toBeUndefined();
      expect(cache.get('stem3')).toBeDefined();
    });

    it('invalidates all stems', () => {
      const cache = new PreviewStemCache();
      cache.set(createStem('stem1', 'clip1', 'eq1', 'hash1'));
      cache.set(createStem('stem2', 'clip2', 'eq1', 'hash2'));

      cache.invalidateAll();

      expect(cache.get('stem1')).toBeUndefined();
      expect(cache.get('stem2')).toBeUndefined();
    });

    it('checks for valid stem with matching hash', () => {
      const cache = new PreviewStemCache();
      cache.set(createStem('stem1', 'clip1', 'eq1', 'hash1'));

      expect(cache.hasValidStem('clip1', 'eq1', 'hash1')).toBe(true);
      expect(cache.hasValidStem('clip1', 'eq1', 'different-hash')).toBe(false);
      expect(cache.hasValidStem('clip1', 'comp1', 'hash1')).toBe(false);
      expect(cache.hasValidStem('clip2', 'eq1', 'hash1')).toBe(false);
    });

    it('gets stem for clip and effect', () => {
      const cache = new PreviewStemCache();
      const stem = createStem('stem1', 'clip1', 'eq1', 'hash1');
      cache.set(stem);

      expect(cache.getStemForClip('clip1', 'eq1')).toBe(stem);
      expect(cache.getStemForClip('clip1', 'comp1')).toBeUndefined();
      expect(cache.getStemForClip('clip2', 'eq1')).toBeUndefined();
    });

    it('handles multiple stems for same clip', () => {
      const cache = new PreviewStemCache();
      const stem1 = createStem('stem1', 'clip1', 'eq1', 'hash1');
      const stem2 = createStem('stem2', 'clip1', 'comp1', 'hash2');
      cache.set(stem1);
      cache.set(stem2);

      expect(cache.getStemForClip('clip1', 'eq1')).toBe(stem1);
      expect(cache.getStemForClip('clip1', 'comp1')).toBe(stem2);
    });
  });

  describe('computeStemHash', () => {
    it('produces consistent hash for same inputs', () => {
      const params = { frequency: 1000, gain: 3 };
      const samples = new Float32Array([0.1, 0.2, 0.3]);

      const hash1 = computeStemHash(params, samples);
      const hash2 = computeStemHash(params, samples);

      expect(hash1).toBe(hash2);
    });

    it('produces different hash when params change', () => {
      const samples = new Float32Array([0.1, 0.2, 0.3]);

      const hash1 = computeStemHash({ frequency: 1000 }, samples);
      const hash2 = computeStemHash({ frequency: 2000 }, samples);

      expect(hash1).not.toBe(hash2);
    });

    it('produces different hash when samples change', () => {
      const params = { frequency: 1000 };
      const samples1 = new Float32Array([0.1, 0.2, 0.3]);
      const samples2 = new Float32Array([0.4, 0.5, 0.6]);

      const hash1 = computeStemHash(params, samples1);
      const hash2 = computeStemHash(params, samples2);

      expect(hash1).not.toBe(hash2);
    });

    it('produces different hash for different param types', () => {
      const samples = new Float32Array([0.1, 0.2, 0.3]);

      const hash1 = computeStemHash({ type: 'eq' }, samples);
      const hash2 = computeStemHash({ type: 'compressor' }, samples);

      expect(hash1).not.toBe(hash2);
    });

    it('handles empty samples', () => {
      const params = { frequency: 1000 };
      const samples = new Float32Array(0);

      const hash = computeStemHash(params, samples);
      expect(hash).toBeDefined();
      expect(hash.length).toBeGreaterThan(0);
    });

    it('handles complex nested params', () => {
      const params = {
        type: 'eq',
        bands: [
          { frequency: 100, gain: 3, q: 1 },
          { frequency: 1000, gain: -2, q: 2 },
        ],
      };
      const samples = new Float32Array([0.1, 0.2, 0.3]);

      const hash = computeStemHash(params, samples);
      expect(hash).toBeDefined();
      expect(hash.length).toBeGreaterThan(0);
    });
  });
});
