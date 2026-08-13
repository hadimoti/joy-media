import { describe, expect, it } from 'vitest';
import type { AudioCommand, AudioState } from './audio-commands.js';
import { applyAudioCommand, AudioCommandError } from './audio-commands.js';
import type { AudioClipConfig } from '@joy-media/audio-core';
import { DEFAULT_CLIP_CONFIG } from '@joy-media/audio-core';

function createTestState(): AudioState {
  const clips: Record<string, AudioClipConfig> = {
    'clip-1': { ...DEFAULT_CLIP_CONFIG },
    'clip-2': { ...DEFAULT_CLIP_CONFIG, gain: 0.5, pan: -0.5 },
  };

  return {
    clips,
    buses: [
      {
        id: 'bus-1',
        name: 'Main',
        gain: 1.0,
        pan: 0,
        mute: false,
        solo: false,
        inputs: [],
      },
    ],
    effects: [],
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AudioCommandError);
    expect((error as AudioCommandError).code).toBe(code);
    return;
  }
  throw new Error(`expected AudioCommandError ${code}, but nothing was thrown`);
}

describe('audio commands', () => {
  describe('audioClip.setGain', () => {
    it('sets clip gain and inverts', () => {
      const state = createTestState();
      const command: AudioCommand = {
        type: 'audioClip.setGain',
        payload: { clipId: 'clip-1', gain: 0.75 },
      };

      const { state: newState, inverse } = applyAudioCommand(state, command);
      expect(newState.clips['clip-1']!.gain).toBe(0.75);
      expect(inverse.type).toBe('audioClip.setGain');
      expect((inverse.payload as { gain: number }).gain).toBe(1.0);

      const restored = applyAudioCommand(newState, inverse);
      expect(restored.state.clips['clip-1']!.gain).toBe(1.0);
    });

    it('rejects unknown clip', () => {
      const state = createTestState();
      expectCode(
        () =>
          applyAudioCommand(state, {
            type: 'audioClip.setGain',
            payload: { clipId: 'unknown', gain: 0.5 },
          }),
        'AUDIO_COMMAND_UNKNOWN_TARGET',
      );
    });
  });

  describe('audioClip.setPan', () => {
    it('sets clip pan and inverts', () => {
      const state = createTestState();
      const command: AudioCommand = {
        type: 'audioClip.setPan',
        payload: { clipId: 'clip-1', pan: 0.5 },
      };

      const { state: newState, inverse } = applyAudioCommand(state, command);
      expect(newState.clips['clip-1']!.pan).toBe(0.5);
      expect(inverse.type).toBe('audioClip.setPan');
      expect((inverse.payload as { pan: number }).pan).toBe(0);

      const restored = applyAudioCommand(newState, inverse);
      expect(restored.state.clips['clip-1']!.pan).toBe(0);
    });
  });

  describe('audioClip.setMute', () => {
    it('sets clip mute and inverts', () => {
      const state = createTestState();
      const command: AudioCommand = {
        type: 'audioClip.setMute',
        payload: { clipId: 'clip-1', mute: true },
      };

      const { state: newState, inverse } = applyAudioCommand(state, command);
      expect(newState.clips['clip-1']!.mute).toBe(true);
      expect(inverse.type).toBe('audioClip.setMute');
      expect((inverse.payload as { mute: boolean }).mute).toBe(false);

      const restored = applyAudioCommand(newState, inverse);
      expect(restored.state.clips['clip-1']!.mute).toBe(false);
    });
  });

  describe('audioClip.setSolo', () => {
    it('sets clip solo and inverts', () => {
      const state = createTestState();
      const command: AudioCommand = {
        type: 'audioClip.setSolo',
        payload: { clipId: 'clip-1', solo: true },
      };

      const { state: newState, inverse } = applyAudioCommand(state, command);
      expect(newState.clips['clip-1']!.solo).toBe(true);
      expect(inverse.type).toBe('audioClip.setSolo');
      expect((inverse.payload as { solo: boolean }).solo).toBe(false);

      const restored = applyAudioCommand(newState, inverse);
      expect(restored.state.clips['clip-1']!.solo).toBe(false);
    });
  });

  describe('audioClip.setFade', () => {
    it('sets fade in and inverts', () => {
      const state = createTestState();
      const command: AudioCommand = {
        type: 'audioClip.setFade',
        payload: { clipId: 'clip-1', fadeInUs: 500000 },
      };

      const { state: newState, inverse } = applyAudioCommand(state, command);
      expect(newState.clips['clip-1']!.fadeInUs).toBe(500000);
      expect(inverse.type).toBe('audioClip.setFade');
      expect((inverse.payload as { fadeInUs?: number }).fadeInUs).toBeUndefined();

      const restored = applyAudioCommand(newState, inverse);
      expect(restored.state.clips['clip-1']!.fadeInUs).toBeUndefined();
    });

    it('sets fade out and inverts', () => {
      const state = createTestState();
      const command: AudioCommand = {
        type: 'audioClip.setFade',
        payload: { clipId: 'clip-1', fadeOutUs: 1000000 },
      };

      const { state: newState, inverse } = applyAudioCommand(state, command);
      expect(newState.clips['clip-1']!.fadeOutUs).toBe(1000000);
      expect(inverse.type).toBe('audioClip.setFade');
      expect((inverse.payload as { fadeOutUs?: number }).fadeOutUs).toBeUndefined();

      const restored = applyAudioCommand(newState, inverse);
      expect(restored.state.clips['clip-1']!.fadeOutUs).toBeUndefined();
    });

    it('sets both fades and inverts', () => {
      const state = createTestState();
      const command: AudioCommand = {
        type: 'audioClip.setFade',
        payload: { clipId: 'clip-1', fadeInUs: 500000, fadeOutUs: 1000000 },
      };

      const { state: newState, inverse } = applyAudioCommand(state, command);
      expect(newState.clips['clip-1']!.fadeInUs).toBe(500000);
      expect(newState.clips['clip-1']!.fadeOutUs).toBe(1000000);

      const restored = applyAudioCommand(newState, inverse);
      expect(restored.state.clips['clip-1']!.fadeInUs).toBeUndefined();
      expect(restored.state.clips['clip-1']!.fadeOutUs).toBeUndefined();
    });
  });

  describe('audioBus.create', () => {
    it('creates a new bus and inverts', () => {
      const state = createTestState();
      const command: AudioCommand = {
        type: 'audioBus.create',
        payload: { id: 'bus-2', name: 'Submix', gain: 0.8 },
      };

      const { state: newState, inverse } = applyAudioCommand(state, command);
      expect(newState.buses.length).toBe(2);
      expect(newState.buses[1]!.id).toBe('bus-2');
      expect(newState.buses[1]!.name).toBe('Submix');
      expect(newState.buses[1]!.gain).toBe(0.8);

      expect(inverse.type).toBe('audioBus.remove');
      expect((inverse.payload as { busId: string }).busId).toBe('bus-2');

      const restored = applyAudioCommand(newState, inverse);
      expect(restored.state.buses.length).toBe(1);
    });

    it('rejects duplicate bus id', () => {
      const state = createTestState();
      expectCode(
        () =>
          applyAudioCommand(state, {
            type: 'audioBus.create',
            payload: { id: 'bus-1', name: 'Duplicate' },
          }),
        'AUDIO_COMMAND_DUPLICATE_ID',
      );
    });
  });

  describe('audioBus.remove', () => {
    it('removes a bus and inverts', () => {
      const state = createTestState();
      const command: AudioCommand = {
        type: 'audioBus.remove',
        payload: { busId: 'bus-1' },
      };

      const { state: newState, inverse } = applyAudioCommand(state, command);
      expect(newState.buses.length).toBe(0);

      expect(inverse.type).toBe('audioBus.create');
      expect((inverse.payload as { id: string }).id).toBe('bus-1');

      const restored = applyAudioCommand(newState, inverse);
      expect(restored.state.buses.length).toBe(1);
      expect(restored.state.buses[0]!.id).toBe('bus-1');
    });

    it('rejects unknown bus', () => {
      const state = createTestState();
      expectCode(
        () =>
          applyAudioCommand(state, {
            type: 'audioBus.remove',
            payload: { busId: 'unknown' },
          }),
        'AUDIO_COMMAND_UNKNOWN_TARGET',
      );
    });
  });

  describe('audioBus.setGain', () => {
    it('sets bus gain and inverts', () => {
      const state = createTestState();
      const command: AudioCommand = {
        type: 'audioBus.setGain',
        payload: { busId: 'bus-1', gain: 0.5 },
      };

      const { state: newState, inverse } = applyAudioCommand(state, command);
      expect(newState.buses[0]!.gain).toBe(0.5);
      expect(inverse.type).toBe('audioBus.setGain');
      expect((inverse.payload as { gain: number }).gain).toBe(1.0);

      const restored = applyAudioCommand(newState, inverse);
      expect(restored.state.buses[0]!.gain).toBe(1.0);
    });

    it('rejects unknown bus', () => {
      const state = createTestState();
      expectCode(
        () =>
          applyAudioCommand(state, {
            type: 'audioBus.setGain',
            payload: { busId: 'unknown', gain: 0.5 },
          }),
        'AUDIO_COMMAND_UNKNOWN_TARGET',
      );
    });
  });

  describe('audioBus.setPan and setMute', () => {
    it('updates both animatable bus controls and restores them', () => {
      const state = createTestState();
      const panned = applyAudioCommand(state, {
        type: 'audioBus.setPan',
        payload: { busId: 'bus-1', pan: 0.75 },
      });
      expect(panned.state.buses[0]!.pan).toBe(0.75);
      expect(applyAudioCommand(panned.state, panned.inverse).state.buses[0]!.pan).toBe(0);

      const muted = applyAudioCommand(state, {
        type: 'audioBus.setMute',
        payload: { busId: 'bus-1', mute: true },
      });
      expect(muted.state.buses[0]!.mute).toBe(true);
      expect(applyAudioCommand(muted.state, muted.inverse).state.buses[0]!.mute).toBe(false);
    });
  });

  describe('audioEffect.add', () => {
    it('adds an effect and inverts', () => {
      const state = createTestState();
      const command: AudioCommand = {
        type: 'audioEffect.add',
        payload: {
          id: 'fx-1',
          targetId: 'bus-1',
          effect: { kind: 'eq', bands: [] },
        },
      };

      const { state: newState, inverse } = applyAudioCommand(state, command);
      expect(newState.effects.length).toBe(1);
      expect(newState.effects[0]!.id).toBe('fx-1');
      expect(newState.effects[0]!.targetId).toBe('bus-1');

      expect(inverse.type).toBe('audioEffect.remove');
      expect((inverse.payload as { effectId: string }).effectId).toBe('fx-1');

      const restored = applyAudioCommand(newState, inverse);
      expect(restored.state.effects.length).toBe(0);
    });

    it('rejects duplicate effect id', () => {
      const state: AudioState = {
        ...createTestState(),
        effects: [
          {
            id: 'fx-1',
            targetId: 'bus-1',
            effect: { kind: 'eq', bands: [] },
          },
        ],
      };

      expectCode(
        () =>
          applyAudioCommand(state, {
            type: 'audioEffect.add',
            payload: {
              id: 'fx-1',
              targetId: 'bus-1',
              effect: { kind: 'eq', bands: [] },
            },
          }),
        'AUDIO_COMMAND_DUPLICATE_ID',
      );
    });
  });

  describe('audioEffect.remove', () => {
    it('removes an effect and inverts', () => {
      const state: AudioState = {
        ...createTestState(),
        effects: [
          {
            id: 'fx-1',
            targetId: 'bus-1',
            effect: { kind: 'eq', bands: [] },
          },
        ],
      };

      const command: AudioCommand = {
        type: 'audioEffect.remove',
        payload: { effectId: 'fx-1' },
      };

      const { state: newState, inverse } = applyAudioCommand(state, command);
      expect(newState.effects.length).toBe(0);

      expect(inverse.type).toBe('audioEffect.add');
      expect((inverse.payload as { id: string }).id).toBe('fx-1');

      const restored = applyAudioCommand(newState, inverse);
      expect(restored.state.effects.length).toBe(1);
    });

    it('rejects unknown effect', () => {
      const state = createTestState();
      expectCode(
        () =>
          applyAudioCommand(state, {
            type: 'audioEffect.remove',
            payload: { effectId: 'unknown' },
          }),
        'AUDIO_COMMAND_UNKNOWN_TARGET',
      );
    });
  });

  describe('audioEffect.setParams', () => {
    it('updates effect params and inverts', () => {
      const state: AudioState = {
        ...createTestState(),
        effects: [
          {
            id: 'fx-1',
            targetId: 'bus-1',
            effect: { kind: 'eq', bands: [] },
          },
        ],
      };

      const command: AudioCommand = {
        type: 'audioEffect.setParams',
        payload: {
          effectId: 'fx-1',
          params: {
            kind: 'eq',
            bands: [{ frequency: 1000, gain: 3, q: 1, type: 'peaking' }],
          },
        },
      };

      const { state: newState, inverse } = applyAudioCommand(state, command);
      expect(newState.effects[0]!.effect.kind).toBe('eq');
      if (newState.effects[0]!.effect.kind === 'eq') {
        expect(newState.effects[0]!.effect.bands.length).toBe(1);
      }

      expect(inverse.type).toBe('audioEffect.setParams');
      expect((inverse.payload as { params: { kind: string } }).params.kind).toBe('eq');

      const restored = applyAudioCommand(newState, inverse);
      if (restored.state.effects[0]!.effect.kind === 'eq') {
        expect(restored.state.effects[0]!.effect.bands.length).toBe(0);
      }
    });

    it('rejects unknown effect', () => {
      const state = createTestState();
      expectCode(
        () =>
          applyAudioCommand(state, {
            type: 'audioEffect.setParams',
            payload: {
              effectId: 'unknown',
              params: { kind: 'eq', bands: [] },
            },
          }),
        'AUDIO_COMMAND_UNKNOWN_TARGET',
      );
    });
  });
});
