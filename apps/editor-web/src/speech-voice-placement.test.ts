import { describe, expect, it } from 'vitest';
import type { Composition } from '@joy-media/project-schema';
import {
  buildSpeechVoicePlacement,
  speechCaptionPlacement,
  speechCaptionOffsetUs,
} from './speech-voice-placement.js';

const audio = {
  id: 'voice-asset',
  kind: 'audio' as const,
  displayName: 'Generated speech.wav',
  descriptor: { mimeType: 'audio/wav', durationUs: 2_000_000 },
};

describe('buildSpeechVoicePlacement', () => {
  it('uses the captured Generate position relative to the caption layer start', () => {
    expect(speechCaptionOffsetUs(5_000_000, 1_000_000)).toBe(4_000_000);
  });

  it.each([
    {
      name: 'before the first caption clip',
      speechStartUs: 2_000_000,
      expected: { clipStartUs: 2_000_000, clipEndUs: 10_000_000, offsetUs: 0 },
    },
    {
      name: 'inside the caption clip',
      speechStartUs: 6_000_000,
      expected: { clipStartUs: 5_000_000, clipEndUs: 10_000_000, offsetUs: 1_000_000 },
    },
    {
      name: 'after the caption clip',
      speechStartUs: 12_000_000,
      expected: { clipStartUs: 5_000_000, clipEndUs: 14_000_000, offsetUs: 7_000_000 },
    },
  ])('places generated words $name', ({ speechStartUs, expected }) => {
    expect(speechCaptionPlacement(5_000_000, 5_000_000, speechStartUs, 2_000_000)).toEqual(
      expected,
    );
  });

  it('chooses the first unlocked compatible track without overlap', () => {
    const transaction = buildSpeechVoicePlacement({
      composition: composition(),
      asset: audio,
      playheadUs: 3_000_000,
      clipId: 'voice-clip',
    });
    expect(transaction.commands).toEqual([
      expect.objectContaining({
        type: 'timeline.insertClip',
        payload: expect.objectContaining({
          trackId: 'audio-b',
          clip: expect.objectContaining({
            id: 'voice-clip',
            startUs: 3_000_000,
            durationUs: 2_000_000,
          }),
        }),
      }),
    ]);
  });

  it('creates a track and inserts the clip in one transaction when needed', () => {
    const transaction = buildSpeechVoicePlacement({
      composition: { ...composition(), tracks: [] },
      asset: audio,
      playheadUs: 0,
      clipId: 'voice-clip',
    });
    expect(transaction.commands.map(({ type }) => type)).toEqual([
      'timeline.addTrack',
      'timeline.insertClip',
    ]);
    expect(transaction.commands.filter(({ type }) => type === 'timeline.insertClip')).toHaveLength(
      1,
    );
  });

  it('skips locked compatible tracks and creates a free audio track', () => {
    const transaction = buildSpeechVoicePlacement({
      composition: composition(),
      asset: audio,
      playheadUs: 0,
      lockedTrackIds: new Set(['audio-b']),
      clipId: 'voice-clip',
    });
    expect(transaction.commands).toHaveLength(2);
    expect(transaction.commands[0]).toMatchObject({
      type: 'timeline.addTrack',
      payload: { track: { family: 'audio' } },
    });
    expect(transaction.commands[1]).toMatchObject({
      type: 'timeline.insertClip',
      payload: { trackId: 'A1' },
    });
  });

  it('rejects missing or invalid duration before creating a timeline command', () => {
    expect(() =>
      buildSpeechVoicePlacement({
        composition: composition(),
        asset: { ...audio, descriptor: {} },
        playheadUs: 0,
        clipId: 'voice-clip',
      }),
    ).toThrow(/validated positive duration/);
  });
});

function composition(): Composition {
  return {
    id: 'root',
    name: 'Root',
    width: 1920,
    height: 1080,
    frameRate: { num: 30, den: 1 },
    durationUs: 10_000_000,
    tracks: [
      {
        id: 'audio-a',
        kind: 'video',
        family: 'audio',
        name: 'Audio 1',
        order: 0,
        enabled: true,
        clips: [
          {
            id: 'overlap',
            kind: 'video',
            assetId: 'old',
            startUs: 0,
            durationUs: 8_000_000,
            sourceInUs: 0,
          },
        ],
      },
      {
        id: 'audio-b',
        kind: 'video',
        family: 'audio',
        name: 'Audio 2',
        order: 1,
        enabled: true,
        clips: [],
      },
    ],
  };
}
