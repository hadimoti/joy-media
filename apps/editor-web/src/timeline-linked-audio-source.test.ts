import { describe, expect, it } from 'vitest';
import type { Track } from '@joy-media/project-schema';
import { makeVideoClip } from '@joy-media/test-fixtures';
import {
  collectLinkedAudioInputs,
  linkedStripMedia,
  type LinkedAudioVideoClip,
} from './timeline-linked-audio-source.js';

const SECOND_US = 1_000_000;

function track(id: string, order: number, family: 'visual' | 'audio', extra: Partial<Track> = {}) {
  return { id, kind: 'video', family, order, enabled: true, clips: [], ...extra } as Track;
}

describe('collectLinkedAudioInputs', () => {
  it('returns the video clips and the real clips of the first audio row', () => {
    const tracks = [
      track('v1', 1, 'visual', { clips: [makeVideoClip('clip-a', 0, 2 * SECOND_US)] }),
      track('a-low', 0, 'audio', { clips: [makeVideoClip('clip-low', 0, SECOND_US)] }),
      track('a-high', 2, 'audio', {
        clips: [makeVideoClip('clip-high', SECOND_US, SECOND_US, { assetId: 'wav-1' })],
      }),
    ];
    const inputs = collectLinkedAudioInputs(tracks);
    // Audio rows display in descending order, so the highest order is A1.
    expect(inputs.a1TrackId).toBe('a-high');
    expect(inputs.a1Clips).toEqual([{ startUs: SECOND_US, durationUs: SECOND_US }]);
    expect(inputs.videoClips.map((clip) => clip.clipId)).toEqual(['clip-a']);
    expect(inputs.videoClips[0]).toMatchObject({
      assetId: 'asset-clip-a',
      startUs: 0,
      durationUs: 2 * SECOND_US,
      sourceInUs: 5 * SECOND_US,
    });
  });

  it('has no A1 row when the timeline has no audio row', () => {
    const inputs = collectLinkedAudioInputs([
      track('v1', 0, 'visual', { clips: [makeVideoClip('clip-a', 0, SECOND_US)] }),
    ]);
    expect(inputs.a1TrackId).toBeUndefined();
    expect(inputs.a1Clips).toEqual([]);
  });

  it('skips hidden and muted rows, audio-kind clips and clips with a time remap', () => {
    const remapped = {
      ...makeVideoClip('remapped', 0, SECOND_US),
      timeRemap: { keyframes: [] },
    } as unknown as ReturnType<typeof makeVideoClip>;
    const inputs = collectLinkedAudioInputs([
      track('hidden', 0, 'visual', {
        enabled: false,
        clips: [makeVideoClip('hidden-clip', 0, SECOND_US)],
      }),
      track('muted', 1, 'visual', {
        muted: true,
        clips: [makeVideoClip('muted-clip', 0, SECOND_US)],
      }),
      track('shown', 2, 'visual', {
        clips: [
          makeVideoClip('shown-clip', 0, SECOND_US),
          makeVideoClip('voice-clip', 0, SECOND_US),
          remapped,
        ],
      }),
      track('a1', 3, 'audio'),
    ]);
    expect(inputs.videoClips.map((clip) => clip.clipId)).toEqual(['shown-clip']);
  });

  it('does not change the tracks it reads', () => {
    const tracks = Object.freeze([
      Object.freeze(
        track('v1', 0, 'visual', {
          clips: Object.freeze([makeVideoClip('clip-a', 0, SECOND_US)]) as never,
        }),
      ),
      Object.freeze(track('a1', 1, 'audio')),
    ]);
    const before = JSON.stringify(tracks);
    collectLinkedAudioInputs(tracks);
    expect(JSON.stringify(tracks)).toBe(before);
  });
});

describe('linkedStripMedia', () => {
  const clip: LinkedAudioVideoClip = {
    clipId: 'c',
    assetId: 'asset-c',
    startUs: 10 * SECOND_US,
    durationUs: 8 * SECOND_US,
    sourceInUs: 20 * SECOND_US,
  };
  const strip = (startUs: number, endUs: number) => ({
    clipId: 'c',
    assetId: 'asset-c',
    startUs,
    endUs,
  });

  it('keeps the clip in-point for a strip that starts with the clip', () => {
    expect(linkedStripMedia(clip, strip(10 * SECOND_US, 18 * SECOND_US))).toEqual({
      assetId: 'asset-c',
      sourceInUs: 20 * SECOND_US,
      durationUs: 8 * SECOND_US,
    });
  });

  it('moves the in-point forward by the cut offset', () => {
    expect(linkedStripMedia(clip, strip(14 * SECOND_US, 18 * SECOND_US))).toMatchObject({
      sourceInUs: 24 * SECOND_US,
      durationUs: 4 * SECOND_US,
    });
  });

  it('scales the offset by the playback rate', () => {
    expect(
      linkedStripMedia({ ...clip, playbackRate: 2 }, strip(14 * SECOND_US, 18 * SECOND_US)),
    ).toMatchObject({ sourceInUs: 28 * SECOND_US, playbackRate: 2 });
  });

  it('moves the in-point backward for a reversed clip', () => {
    expect(
      linkedStripMedia({ ...clip, reversed: true }, strip(14 * SECOND_US, 18 * SECOND_US)),
    ).toMatchObject({ sourceInUs: 16 * SECOND_US, reversed: true });
  });

  it('never goes below zero', () => {
    expect(
      linkedStripMedia(
        { ...clip, sourceInUs: SECOND_US, reversed: true },
        strip(14 * SECOND_US, 18 * SECOND_US),
      ).sourceInUs,
    ).toBe(0);
  });
});
