import type {
  AudioBus,
  AudioClipConfig,
  AudioEffect,
  AudioEffectInstance,
} from '@joy-media/audio-core';

export interface AudioState {
  readonly clips: Readonly<Record<string, AudioClipConfig>>;
  readonly buses: readonly AudioBus[];
  readonly effects: readonly AudioEffectInstance[];
}

export type AudioCommand =
  | {
      readonly type: 'audioClip.setGain';
      readonly payload: { readonly clipId: string; readonly gain: number };
    }
  | {
      readonly type: 'audioClip.setPan';
      readonly payload: { readonly clipId: string; readonly pan: number };
    }
  | {
      readonly type: 'audioClip.setMute';
      readonly payload: { readonly clipId: string; readonly mute: boolean };
    }
  | {
      readonly type: 'audioClip.setSolo';
      readonly payload: { readonly clipId: string; readonly solo: boolean };
    }
  | {
      readonly type: 'audioClip.setFade';
      readonly payload: {
        readonly clipId: string;
        readonly fadeInUs?: number;
        readonly fadeOutUs?: number;
      };
    }
  | {
      readonly type: 'audioBus.create';
      readonly payload: {
        readonly id: string;
        readonly name: string;
        readonly gain?: number;
        readonly pan?: number;
        readonly mute?: boolean;
        readonly solo?: boolean;
        readonly inputs?: readonly string[];
      };
    }
  | {
      readonly type: 'audioBus.remove';
      readonly payload: { readonly busId: string };
    }
  | {
      readonly type: 'audioBus.setGain';
      readonly payload: { readonly busId: string; readonly gain: number };
    }
  | {
      readonly type: 'audioEffect.add';
      readonly payload: {
        readonly id: string;
        readonly targetId: string;
        readonly effect: AudioEffect;
      };
    }
  | {
      readonly type: 'audioEffect.remove';
      readonly payload: { readonly effectId: string };
    }
  | {
      readonly type: 'audioEffect.setParams';
      readonly payload: { readonly effectId: string; readonly params: AudioEffect };
    };

export class AudioCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AudioCommandError';
    this.code = code;
  }
}

export interface AudioApplyResult {
  readonly state: AudioState;
  readonly inverse: AudioCommand;
}

export function applyAudioCommand(state: AudioState, command: AudioCommand): AudioApplyResult {
  switch (command.type) {
    case 'audioClip.setGain':
      return applyClipSetGain(state, command.payload);
    case 'audioClip.setPan':
      return applyClipSetPan(state, command.payload);
    case 'audioClip.setMute':
      return applyClipSetMute(state, command.payload);
    case 'audioClip.setSolo':
      return applyClipSetSolo(state, command.payload);
    case 'audioClip.setFade':
      return applyClipSetFade(state, command.payload);
    case 'audioBus.create':
      return applyBusCreate(state, command.payload);
    case 'audioBus.remove':
      return applyBusRemove(state, command.payload);
    case 'audioBus.setGain':
      return applyBusSetGain(state, command.payload);
    case 'audioEffect.add':
      return applyEffectAdd(state, command.payload);
    case 'audioEffect.remove':
      return applyEffectRemove(state, command.payload);
    case 'audioEffect.setParams':
      return applyEffectSetParams(state, command.payload);
    default: {
      const exhaustive: never = command;
      throw new AudioCommandError(
        'AUDIO_COMMAND_UNKNOWN_TYPE',
        `unknown audio command ${String(exhaustive)}`,
      );
    }
  }
}

function applyClipSetGain(
  state: AudioState,
  payload: { readonly clipId: string; readonly gain: number },
): AudioApplyResult {
  const clip = state.clips[payload.clipId];
  if (!clip) {
    throw new AudioCommandError('AUDIO_COMMAND_UNKNOWN_TARGET', `unknown clip "${payload.clipId}"`);
  }

  const newClips = { ...state.clips, [payload.clipId]: { ...clip, gain: payload.gain } };
  const newState: AudioState = { ...state, clips: newClips };

  return {
    state: newState,
    inverse: {
      type: 'audioClip.setGain',
      payload: { clipId: payload.clipId, gain: clip.gain },
    },
  };
}

function applyClipSetPan(
  state: AudioState,
  payload: { readonly clipId: string; readonly pan: number },
): AudioApplyResult {
  const clip = state.clips[payload.clipId];
  if (!clip) {
    throw new AudioCommandError('AUDIO_COMMAND_UNKNOWN_TARGET', `unknown clip "${payload.clipId}"`);
  }

  const newClips = { ...state.clips, [payload.clipId]: { ...clip, pan: payload.pan } };
  const newState: AudioState = { ...state, clips: newClips };

  return {
    state: newState,
    inverse: {
      type: 'audioClip.setPan',
      payload: { clipId: payload.clipId, pan: clip.pan },
    },
  };
}

function applyClipSetMute(
  state: AudioState,
  payload: { readonly clipId: string; readonly mute: boolean },
): AudioApplyResult {
  const clip = state.clips[payload.clipId];
  if (!clip) {
    throw new AudioCommandError('AUDIO_COMMAND_UNKNOWN_TARGET', `unknown clip "${payload.clipId}"`);
  }

  const newClips = { ...state.clips, [payload.clipId]: { ...clip, mute: payload.mute } };
  const newState: AudioState = { ...state, clips: newClips };

  return {
    state: newState,
    inverse: {
      type: 'audioClip.setMute',
      payload: { clipId: payload.clipId, mute: clip.mute },
    },
  };
}

function applyClipSetSolo(
  state: AudioState,
  payload: { readonly clipId: string; readonly solo: boolean },
): AudioApplyResult {
  const clip = state.clips[payload.clipId];
  if (!clip) {
    throw new AudioCommandError('AUDIO_COMMAND_UNKNOWN_TARGET', `unknown clip "${payload.clipId}"`);
  }

  const newClips = { ...state.clips, [payload.clipId]: { ...clip, solo: payload.solo } };
  const newState: AudioState = { ...state, clips: newClips };

  return {
    state: newState,
    inverse: {
      type: 'audioClip.setSolo',
      payload: { clipId: payload.clipId, solo: clip.solo },
    },
  };
}

function applyClipSetFade(
  state: AudioState,
  payload: {
    readonly clipId: string;
    readonly fadeInUs?: number;
    readonly fadeOutUs?: number;
  },
): AudioApplyResult {
  const clip = state.clips[payload.clipId];
  if (!clip) {
    throw new AudioCommandError('AUDIO_COMMAND_UNKNOWN_TARGET', `unknown clip "${payload.clipId}"`);
  }

  const newConfig: AudioClipConfig = {
    ...clip,
    ...(payload.fadeInUs !== undefined ? { fadeInUs: payload.fadeInUs } : {}),
    ...(payload.fadeOutUs !== undefined ? { fadeOutUs: payload.fadeOutUs } : {}),
  };

  const newClips = { ...state.clips, [payload.clipId]: newConfig };
  const newState: AudioState = { ...state, clips: newClips };

  return {
    state: newState,
    inverse: {
      type: 'audioClip.setFade',
      payload: {
        clipId: payload.clipId,
        ...(clip.fadeInUs !== undefined ? { fadeInUs: clip.fadeInUs } : {}),
        ...(clip.fadeOutUs !== undefined ? { fadeOutUs: clip.fadeOutUs } : {}),
      },
    },
  };
}

function applyBusCreate(
  state: AudioState,
  payload: {
    readonly id: string;
    readonly name: string;
    readonly gain?: number;
    readonly pan?: number;
    readonly mute?: boolean;
    readonly solo?: boolean;
    readonly inputs?: readonly string[];
  },
): AudioApplyResult {
  if (state.buses.some((b) => b.id === payload.id)) {
    throw new AudioCommandError(
      'AUDIO_COMMAND_DUPLICATE_ID',
      `bus id "${payload.id}" already exists`,
    );
  }

  const newBus: AudioBus = {
    id: payload.id,
    name: payload.name,
    gain: payload.gain ?? 1.0,
    pan: payload.pan ?? 0,
    mute: payload.mute ?? false,
    solo: payload.solo ?? false,
    inputs: payload.inputs ?? [],
  };

  const newBuses = [...state.buses, newBus];
  const newState: AudioState = { ...state, buses: newBuses };

  return {
    state: newState,
    inverse: {
      type: 'audioBus.remove',
      payload: { busId: payload.id },
    },
  };
}

function applyBusRemove(state: AudioState, payload: { readonly busId: string }): AudioApplyResult {
  const busIndex = state.buses.findIndex((b) => b.id === payload.busId);
  if (busIndex === -1) {
    throw new AudioCommandError('AUDIO_COMMAND_UNKNOWN_TARGET', `unknown bus "${payload.busId}"`);
  }

  const bus = state.buses[busIndex]!;
  const newBuses = [...state.buses.slice(0, busIndex), ...state.buses.slice(busIndex + 1)];
  const newState: AudioState = { ...state, buses: newBuses };

  return {
    state: newState,
    inverse: {
      type: 'audioBus.create',
      payload: {
        id: bus.id,
        name: bus.name,
        gain: bus.gain,
        pan: bus.pan,
        mute: bus.mute,
        solo: bus.solo,
        inputs: bus.inputs,
      },
    },
  };
}

function applyBusSetGain(
  state: AudioState,
  payload: { readonly busId: string; readonly gain: number },
): AudioApplyResult {
  const busIndex = state.buses.findIndex((b) => b.id === payload.busId);
  if (busIndex === -1) {
    throw new AudioCommandError('AUDIO_COMMAND_UNKNOWN_TARGET', `unknown bus "${payload.busId}"`);
  }

  const bus = state.buses[busIndex]!;
  const newBuses = [
    ...state.buses.slice(0, busIndex),
    { ...bus, gain: payload.gain },
    ...state.buses.slice(busIndex + 1),
  ];
  const newState: AudioState = { ...state, buses: newBuses };

  return {
    state: newState,
    inverse: {
      type: 'audioBus.setGain',
      payload: { busId: payload.busId, gain: bus.gain },
    },
  };
}

function applyEffectAdd(
  state: AudioState,
  payload: {
    readonly id: string;
    readonly targetId: string;
    readonly effect: AudioEffect;
  },
): AudioApplyResult {
  if (state.effects.some((e) => e.id === payload.id)) {
    throw new AudioCommandError(
      'AUDIO_COMMAND_DUPLICATE_ID',
      `effect id "${payload.id}" already exists`,
    );
  }

  const newEffect: AudioEffectInstance = {
    id: payload.id,
    targetId: payload.targetId,
    effect: payload.effect,
  };

  const newEffects = [...state.effects, newEffect];
  const newState: AudioState = { ...state, effects: newEffects };

  return {
    state: newState,
    inverse: {
      type: 'audioEffect.remove',
      payload: { effectId: payload.id },
    },
  };
}

function applyEffectRemove(
  state: AudioState,
  payload: { readonly effectId: string },
): AudioApplyResult {
  const effectIndex = state.effects.findIndex((e) => e.id === payload.effectId);
  if (effectIndex === -1) {
    throw new AudioCommandError(
      'AUDIO_COMMAND_UNKNOWN_TARGET',
      `unknown effect "${payload.effectId}"`,
    );
  }

  const effect = state.effects[effectIndex]!;
  const newEffects = [
    ...state.effects.slice(0, effectIndex),
    ...state.effects.slice(effectIndex + 1),
  ];
  const newState: AudioState = { ...state, effects: newEffects };

  return {
    state: newState,
    inverse: {
      type: 'audioEffect.add',
      payload: {
        id: effect.id,
        targetId: effect.targetId,
        effect: effect.effect,
      },
    },
  };
}

function applyEffectSetParams(
  state: AudioState,
  payload: { readonly effectId: string; readonly params: AudioEffect },
): AudioApplyResult {
  const effectIndex = state.effects.findIndex((e) => e.id === payload.effectId);
  if (effectIndex === -1) {
    throw new AudioCommandError(
      'AUDIO_COMMAND_UNKNOWN_TARGET',
      `unknown effect "${payload.effectId}"`,
    );
  }

  const effect = state.effects[effectIndex]!;
  const newEffect: AudioEffectInstance = {
    id: effect.id,
    targetId: effect.targetId,
    effect: payload.params,
  };

  const newEffects = [
    ...state.effects.slice(0, effectIndex),
    newEffect,
    ...state.effects.slice(effectIndex + 1),
  ];
  const newState: AudioState = { ...state, effects: newEffects };

  return {
    state: newState,
    inverse: {
      type: 'audioEffect.setParams',
      payload: { effectId: payload.effectId, params: effect.effect },
    },
  };
}
