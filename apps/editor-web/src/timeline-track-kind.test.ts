import { describe, expect, it } from 'vitest';
import type { Clip, Track } from '@joy-media/project-schema';
import {
  timelineTrackKind,
  timelineTrackCode,
  timelineTrackDisplayName,
} from './timeline-track-kind.js';

function videoClip(id: string, assetId: string): Clip {
  return {
    id,
    kind: 'video',
    assetId,
    startUs: 0,
    durationUs: 1_000_000,
    sourceInUs: 0,
  };
}

function track(id: string, clips: readonly Clip[] = [], kind: Track['kind'] = 'video'): Track {
  return { id, kind, order: 0, enabled: true, clips };
}

describe('timelineTrackKind', () => {
  it('keeps unknown and ordinary visual tracks as video', () => {
    expect(timelineTrackKind(track('V1', [videoClip('intro', 'camera-a')]))).toBe('video');
    expect(timelineTrackKind(track('empty-row'))).toBe('video');
  });

  it('recognizes audio tracks from either the row or all clip identities', () => {
    expect(timelineTrackKind(track('A1-voice'))).toBe('audio');
    expect(timelineTrackKind(track('track-7', [], 'audio'))).toBe('audio');
    expect(
      timelineTrackKind(
        track('track-2', [
          videoClip('voice-opening', 'take-1.wav'),
          videoClip('music-bed', 'score.mp3'),
        ]),
      ),
    ).toBe('audio');
  });

  it('recognizes script tracks from either the row or all clip identities', () => {
    expect(timelineTrackKind(track('captions-en'))).toBe('script');
    expect(
      timelineTrackKind(
        track('track-3', [
          videoClip('script-scene-1', 'draft-a'),
          videoClip('subtitle-scene-2', 'dialogue.vtt'),
        ]),
      ),
    ).toBe('script');
  });

  it('does not relabel mixed-purpose rows', () => {
    expect(
      timelineTrackKind(
        track('track-4', [
          videoClip('voice-opening', 'take-1.wav'),
          videoClip('intro', 'camera-a'),
        ]),
      ),
    ).toBe('video');
  });
});

describe('timelineTrack chrome labels', () => {
  it('names the first video row Main Video', () => {
    expect(timelineTrackCode('video', 1)).toBe('V1');
    expect(timelineTrackDisplayName('video', 1)).toBe('Main Video');
    expect(timelineTrackDisplayName('video', 2)).toBe('B-roll');
  });

  it('names audio and script rows with kind prefixes', () => {
    expect(timelineTrackCode('audio', 1)).toBe('A1');
    expect(timelineTrackDisplayName('audio', 1)).toBe('Voice');
    expect(timelineTrackCode('script', 2)).toBe('S2');
    expect(timelineTrackDisplayName('script', 2)).toBe('Script 2');
  });
});
