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

function track(id: string, clips: readonly Clip[] = []): Track {
  return { id, kind: 'video', order: 0, enabled: true, clips };
}

describe('timelineTrackKind', () => {
  it('keeps unknown and ordinary visual tracks as video', () => {
    expect(timelineTrackKind(track('V1', [videoClip('intro', 'camera-a')]))).toBe('video');
    expect(timelineTrackKind(track('empty-row'))).toBe('video');
  });

  it('recognizes audio tracks from either the row or all clip identities', () => {
    expect(timelineTrackKind(track('A1-voice'))).toBe('audio');
    expect(
      timelineTrackKind(
        track('track-2', [
          videoClip('voice-opening', 'take-1.wav'),
          videoClip('music-bed', 'score.mp3'),
        ]),
      ),
    ).toBe('audio');
  });

  it('distinguishes CC caption lanes from script/agent data lanes', () => {
    expect(timelineTrackKind(track('captions-en'))).toBe('caption');
    expect(timelineTrackKind(track('script-notes'))).toBe('script');
    expect(
      timelineTrackKind(
        track('track-3', [
          videoClip('caption-scene-1', 'dialogue.srt'),
          videoClip('subtitle-scene-2', 'dialogue.vtt'),
        ]),
      ),
    ).toBe('caption');
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

  it('uses durable authored kinds before name heuristics', () => {
    const row = track('ordinary-row', [videoClip('controller', 'generic')]);
    for (const kind of [
      'text',
      'caption',
      'motion',
      'effect',
      'filter',
      'adjust',
      'overlay',
      'audio',
    ] as const) {
      expect(timelineTrackKind(row, { controller: kind })).toBe(kind);
    }
  });
});

describe('timelineTrack chrome labels', () => {
  it('names the first video row Main Video', () => {
    expect(timelineTrackCode('video', 1)).toBe('V1');
    expect(timelineTrackDisplayName('video', 1)).toBe('Main Video');
    expect(timelineTrackDisplayName('video', 2)).toBe('B-roll');
  });

  it('names audio, captions, and script rows with kind prefixes', () => {
    expect(timelineTrackCode('audio', 1)).toBe('A1');
    expect(timelineTrackDisplayName('audio', 1)).toBe('Audio');
    expect(timelineTrackCode('caption', 1)).toBe('CC1');
    expect(timelineTrackDisplayName('caption', 1)).toBe('Captions');
    expect(timelineTrackCode('script', 2)).toBe('S2');
    expect(timelineTrackDisplayName('script', 2)).toBe('Script 2');
  });

  it('gives each requested element kind compact, distinct track chrome', () => {
    expect(
      (['text', 'motion', 'effect', 'filter', 'adjust', 'overlay'] as const).map((kind) => [
        timelineTrackCode(kind, 1),
        timelineTrackDisplayName(kind, 1),
      ]),
    ).toEqual([
      ['T1', 'Text'],
      ['M1', 'Motion'],
      ['FX1', 'Effects'],
      ['F1', 'Filters'],
      ['ADJ1', 'Adjust'],
      ['O1', 'Overlay'],
    ]);
  });
});
