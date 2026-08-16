import { describe, expect, it } from 'vitest';
import { removeClipAudio } from './audio-session.js';

describe('removeClipAudio', () => {
  it('removes mixer rows and effects owned by every deleted clip', () => {
    const next = removeClipAudio(
      {
        clips: {
          a: { gain: 1, pan: 0, mute: false, solo: false },
          b: { gain: 1, pan: 0, mute: false, solo: false },
        },
        buses: [],
        effects: [
          {
            id: 'fx-a',
            targetId: 'a',
            effect: {
              kind: 'compressor',
              threshold: -24,
              ratio: 4,
              attackUs: 10_000,
              releaseUs: 100_000,
              knee: 6,
            },
          },
          {
            id: 'fx-b',
            targetId: 'b',
            effect: {
              kind: 'compressor',
              threshold: -24,
              ratio: 4,
              attackUs: 10_000,
              releaseUs: 100_000,
              knee: 6,
            },
          },
        ],
      },
      ['a', 'missing'],
    );
    expect(next.clips).toEqual({ b: { gain: 1, pan: 0, mute: false, solo: false } });
    expect(next.effects.map((effect) => effect.id)).toEqual(['fx-b']);
  });
});
