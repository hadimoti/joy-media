import { describe, expect, it } from 'vitest';
import { loadAudioState, removeClipAudio, saveAudioStateTo } from './audio-session.js';

describe('audio session persistence', () => {
  it('uses the caller-provided storage capability for legacy audio state', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem(key: string): string | null {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        values.set(key, value);
      },
    };
    const state = {
      clips: { clip_a: { gain: 0.7, pan: 0, mute: false, solo: false } },
      buses: [
        { id: 'master', name: 'Master', gain: 1, pan: 0, mute: false, solo: false, inputs: [] },
      ],
      effects: [],
    };

    saveAudioStateTo(storage, 'project_a', state);

    expect(loadAudioState(storage, 'project_a')).toEqual(state);
  });
});

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
