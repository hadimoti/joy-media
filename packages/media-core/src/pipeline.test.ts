import { describe, expect, it } from 'vitest';
import { derivativeCacheKey, normalizeProbe, relinkExactHash } from './pipeline.js';
describe('media pipeline contracts', () => {
  it('normalizes ffprobe-like metadata without paths', () => {
    expect(
      normalizeProbe({
        format: { duration: '1.25' },
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
          { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000' },
        ],
      }),
    ).toEqual({
      durationUs: 1_250_000,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      sampleRate: 48000,
    });
  });
  it('relinks only an exact content hash and invalidates proxy keys by profile', () => {
    expect(
      relinkExactHash({ state: 'missing', contentHash: 'sha256:x' }, 'sha256:x', 'opaque-1'),
    ).toEqual({ state: 'available', opaqueLocationId: 'opaque-1' });
    expect(
      derivativeCacheKey('sha256:x', { maxHeight: 540, videoCodec: 'h264', audioCodec: 'aac' }),
    ).not.toBe(
      derivativeCacheKey('sha256:x', { maxHeight: 720, videoCodec: 'h264', audioCodec: 'aac' }),
    );
  });
});
