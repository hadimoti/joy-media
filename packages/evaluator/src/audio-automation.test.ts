import { describe, expect, it } from 'vitest';
import {
  audioBusPropertyBinding,
  audioClipPropertyBinding,
  canonicalBindingKey,
  type NormalizedPropertyAnimationsV2,
  type ProjectAudioV1,
} from '@joy-media/project-schema';
import { buildAudioAutomationBlock, evaluateProjectAudioAtTime } from './audio-automation.js';

const audio: ProjectAudioV1 = {
  clips: {
    intro: { gain: 1, pan: 0, mute: false, solo: false },
  },
  buses: [{ id: 'master', name: 'Master', gain: 1, pan: 0, mute: false, solo: false, inputs: [] }],
  effects: [],
};

function scalar(from: number, to: number) {
  return {
    kind: 'scalar' as const,
    curve: {
      keyframes: [
        { timeUs: 0, value: from, interpolation: 'linear' as const },
        { timeUs: 1_000_000, value: to, interpolation: 'linear' as const },
      ],
    },
  };
}

const animations: NormalizedPropertyAnimationsV2 = {
  [canonicalBindingKey(audioClipPropertyBinding('intro', 'gain'))]: {
    binding: audioClipPropertyBinding('intro', 'gain'),
    value: scalar(1, 0.25),
  },
  [canonicalBindingKey(audioBusPropertyBinding('master', 'pan'))]: {
    binding: audioBusPropertyBinding('master', 'pan'),
    value: scalar(0, 2),
  },
  [canonicalBindingKey(audioClipPropertyBinding('intro', 'mute'))]: {
    binding: audioClipPropertyBinding('intro', 'mute'),
    value: {
      kind: 'boolean',
      keys: [
        { timeUs: 0, value: false },
        { timeUs: 500_000, value: true },
      ],
    },
  },
};

describe('audio automation evaluator', () => {
  it('samples only declared clip and bus controls while preserving static topology', () => {
    const evaluated = evaluateProjectAudioAtTime(audio, animations, {
      compositionTimeUs: 500_000,
      audioTimelineTimeUs: 500_000,
    });
    expect(evaluated.clips.intro).toMatchObject({ gain: 0.625, pan: 0, mute: true, solo: false });
    expect(evaluated.buses[0]).toMatchObject({ gain: 1, pan: 1, mute: false, inputs: [] });
  });

  it('creates continuous block ramps and keeps discrete mute at the block start', () => {
    const block = buildAudioAutomationBlock(
      audio,
      animations,
      { compositionTimeUs: 0 },
      { startUs: 400_000, endUs: 600_000 },
    );
    expect(block.clips.intro).toEqual({
      gain: { start: 0.7, end: 0.55, smoothingUs: 5_000 },
      pan: { start: 0, end: 0, smoothingUs: 5_000 },
      mute: false,
    });
    expect(block.buses.master).toEqual({
      gain: { start: 1, end: 1, smoothingUs: 5_000 },
      pan: { start: 0.8, end: 1, smoothingUs: 5_000 },
      mute: false,
    });
  });
});
