import { describe, expect, it } from 'vitest';
import { linkedAudioStrips, type LinkedAudioSourceClip } from './timeline-linked-audio.js';

const withAudio = (assetId: string) => assetId === 'with-audio';

function video(clipId: string, assetId: string, startUs: number, durationUs: number) {
  return { clipId, assetId, startUs, durationUs } satisfies LinkedAudioSourceClip;
}

describe('linkedAudioStrips', () => {
  it('draws one strip over a video clip whose asset has an audio stream', () => {
    expect(
      linkedAudioStrips({
        videoClips: [video('c1', 'with-audio', 1_000_000, 4_000_000)],
        a1Clips: [],
        hasAudioStream: withAudio,
      }),
    ).toEqual([{ clipId: 'c1', assetId: 'with-audio', startUs: 1_000_000, endUs: 5_000_000 }]);
  });

  it('draws nothing for a silent or unknown asset', () => {
    expect(
      linkedAudioStrips({
        videoClips: [video('c1', 'silent', 0, 2_000_000), video('c2', 'unknown', 0, 2_000_000)],
        a1Clips: [],
        hasAudioStream: (assetId) => (assetId === 'silent' ? false : undefined),
      }),
    ).toEqual([]);
  });

  it('cuts the strip out where a real A1 clip sits, so the real clip wins', () => {
    expect(
      linkedAudioStrips({
        videoClips: [video('c1', 'with-audio', 0, 10_000_000)],
        a1Clips: [{ startUs: 3_000_000, durationUs: 2_000_000 }],
        hasAudioStream: withAudio,
      }),
    ).toEqual([
      { clipId: 'c1', assetId: 'with-audio', startUs: 0, endUs: 3_000_000 },
      { clipId: 'c1', assetId: 'with-audio', startUs: 5_000_000, endUs: 10_000_000 },
    ]);
  });

  it('draws nothing where a real A1 clip covers the whole video clip', () => {
    expect(
      linkedAudioStrips({
        videoClips: [video('c1', 'with-audio', 2_000_000, 1_000_000)],
        a1Clips: [
          { startUs: 0, durationUs: 5_000_000 },
          { startUs: 4_000_000, durationUs: 1_000_000 },
        ],
        hasAudioStream: withAudio,
      }),
    ).toEqual([]);
  });

  it('merges overlapping real clips before cutting', () => {
    expect(
      linkedAudioStrips({
        videoClips: [video('c1', 'with-audio', 0, 10_000_000)],
        a1Clips: [
          { startUs: 6_000_000, durationUs: 2_000_000 },
          { startUs: 2_000_000, durationUs: 5_000_000 },
        ],
        hasAudioStream: withAudio,
      }),
    ).toEqual([
      { clipId: 'c1', assetId: 'with-audio', startUs: 0, endUs: 2_000_000 },
      { clipId: 'c1', assetId: 'with-audio', startUs: 8_000_000, endUs: 10_000_000 },
    ]);
  });

  it('ignores zero, negative and non-finite spans', () => {
    expect(
      linkedAudioStrips({
        videoClips: [
          video('zero', 'with-audio', 0, 0),
          video('negative', 'with-audio', 0, -5),
          video('nan', 'with-audio', Number.NaN, 1_000_000),
          video('ok', 'with-audio', 4_000_000, 1_000_000),
        ],
        a1Clips: [{ startUs: 0, durationUs: Number.POSITIVE_INFINITY }],
        hasAudioStream: withAudio,
      }),
    ).toEqual([{ clipId: 'ok', assetId: 'with-audio', startUs: 4_000_000, endUs: 5_000_000 }]);
  });

  it('returns strips in time order and does not change its inputs', () => {
    const videoClips = Object.freeze([
      video('late', 'with-audio', 8_000_000, 1_000_000),
      video('early', 'with-audio', 1_000_000, 1_000_000),
    ]);
    const a1Clips = Object.freeze([Object.freeze({ startUs: 0, durationUs: 500_000 })]);
    const result = linkedAudioStrips({ videoClips, a1Clips, hasAudioStream: withAudio });
    expect(result.map((strip) => strip.clipId)).toEqual(['early', 'late']);
    expect(videoClips.map((clip) => clip.clipId)).toEqual(['late', 'early']);
    expect(a1Clips).toHaveLength(1);
  });
});
