import { describe, expect, it } from 'vitest';
import { createObservationCacheKey } from './observation-cache-key.js';

const input = {
  assetDigest: 'a'.repeat(64),
  streamId: 'video-0',
  crop: { x: 0, y: 0, width: 1920, height: 1080 },
  rotationDeg: 0 as const,
  representation: 'original' as const,
  modelId: 'openrouter/example',
  analysisVersion: 'observation-v1',
};

describe('observation cache keys', () => {
  it('is deterministic and separates every rendered/analysis identity dimension', () => {
    const key = createObservationCacheKey(input);
    expect(createObservationCacheKey({ ...input })).toBe(key);
    expect(createObservationCacheKey({ ...input, rotationDeg: 90 })).not.toBe(key);
    expect(createObservationCacheKey({ ...input, representation: 'proxy' })).not.toBe(key);
    expect(createObservationCacheKey({ ...input, modelId: 'openrouter/other' })).not.toBe(key);
    expect(createObservationCacheKey({ ...input, analysisVersion: 'observation-v2' })).not.toBe(
      key,
    );
    expect(createObservationCacheKey({ ...input, crop: { ...input.crop, width: 1280 } })).not.toBe(
      key,
    );
  });

  it('rejects unsafe cache identity components instead of accepting paths or URLs', () => {
    expect(() => createObservationCacheKey({ ...input, assetDigest: '../not-a-digest' })).toThrow(
      'assetDigest',
    );
    expect(() =>
      createObservationCacheKey({ ...input, streamId: 'https://example.test/media' }),
    ).toThrow('streamId');
  });
});
