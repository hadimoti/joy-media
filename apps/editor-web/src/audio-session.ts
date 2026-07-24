/**
 * Browser-local durable audio graph for the mixer panel (Phase 3).
 * Mirrors `@joy-media/commands` AudioState and syncs into JoyProjectV1.audio.
 */

import type { AudioState } from '@joy-media/commands';
import type { JoyProjectV1 } from '@joy-media/project-schema';

const KEY = (projectId: string) => `joy-media.audio-graph.v1.${projectId}`;

export const EMPTY_AUDIO_STATE: AudioState = {
  clips: {},
  buses: [{ id: 'master', name: 'Master', gain: 1, pan: 0, mute: false, solo: false, inputs: [] }],
  effects: [],
};

export function loadAudioState(projectId: string): AudioState {
  try {
    const raw = window.localStorage.getItem(KEY(projectId));
    if (raw === null) return EMPTY_AUDIO_STATE;
    const parsed = JSON.parse(raw) as AudioState;
    if (parsed === null || typeof parsed !== 'object' || parsed.clips === undefined)
      return EMPTY_AUDIO_STATE;
    return {
      clips: parsed.clips ?? {},
      buses: parsed.buses?.length ? parsed.buses : EMPTY_AUDIO_STATE.buses,
      effects: parsed.effects ?? [],
    };
  } catch {
    return EMPTY_AUDIO_STATE;
  }
}

export function saveAudioState(projectId: string, state: AudioState): void {
  window.localStorage.setItem(KEY(projectId), JSON.stringify(state));
}

export function ensureClipAudio(state: AudioState, clipIds: readonly string[]): AudioState {
  let changed = false;
  const clips = { ...state.clips };
  for (const id of clipIds) {
    if (clips[id] !== undefined) continue;
    clips[id] = { gain: 1, pan: 0, mute: false, solo: false };
    changed = true;
  }
  return changed ? { ...state, clips } : state;
}

export function withProjectAudio(project: JoyProjectV1, state: AudioState): JoyProjectV1 {
  return {
    ...project,
    audio: {
      clips: state.clips,
      buses: state.buses,
      effects: state.effects.map((effect) => ({
        id: effect.id,
        targetId: effect.targetId,
        effect: effect.effect as unknown as import('@joy-media/project-schema').JsonValue,
      })),
    },
    updatedAt: new Date().toISOString(),
  };
}
