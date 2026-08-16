/**
 * Browser-local durable audio graph for the mixer panel (Phase 3).
 * Mirrors `@joy-media/commands` AudioState and syncs into JoyProjectV1.audio.
 */

import type { AudioState } from '@joy-media/commands';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { JoyProjectV1, JsonValue } from '@joy-media/project-schema';

const KEY = (projectId: string) => `joy-media.audio-graph.v1.${projectId}`;

export const EMPTY_AUDIO_STATE: AudioState = {
  clips: {},
  buses: [{ id: 'master', name: 'Master', gain: 1, pan: 0, mute: false, solo: false, inputs: [] }],
  effects: [],
};

export function loadAudioState(projectId: string): AudioState {
  return loadAudioStateFrom(window.localStorage, projectId);
}

export function loadAudioStateFrom(storage: BrowserKeyValueStore, projectId: string): AudioState {
  try {
    const raw = storage.getItem(KEY(projectId));
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

/** Reads the canonical creative-document audio graph, migrating the legacy
 * project-local storage key only when older projects have no embedded graph. */
export function loadAudioStateFromProject(
  storage: BrowserKeyValueStore,
  projectId: string,
  project: Pick<JoyProjectV1, 'audio'>,
): AudioState {
  const audio = project.audio;
  if (audio !== undefined && typeof audio === 'object') {
    return {
      clips: audio.clips,
      buses: audio.buses.length > 0 ? audio.buses : EMPTY_AUDIO_STATE.buses,
      effects: audio.effects.map((effect) => ({
        id: effect.id,
        targetId: effect.targetId,
        effect: effect.effect as unknown as AudioState['effects'][number]['effect'],
      })),
    };
  }
  return loadAudioStateFrom(storage, projectId);
}

export function saveAudioState(projectId: string, state: AudioState): void {
  saveAudioStateTo(window.localStorage, projectId, state);
}

export function saveAudioStateTo(
  storage: BrowserKeyValueStore,
  projectId: string,
  state: AudioState,
): void {
  storage.setItem(KEY(projectId), JSON.stringify(state));
}

export function removeAudioState(storage: BrowserKeyValueStore, projectId: string): void {
  storage.removeItem?.(KEY(projectId));
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

/** Removes clip-owned mixer rows and effects as part of an atomic timeline delete. */
export function removeClipAudio(state: AudioState, clipIds: readonly string[]): AudioState {
  if (clipIds.length === 0) return state;
  const removed = new Set(clipIds);
  const clips = Object.fromEntries(
    Object.entries(state.clips).filter(([clipId]) => !removed.has(clipId)),
  );
  const effects = state.effects.filter((effect) => !removed.has(effect.targetId));
  if (
    Object.keys(clips).length === Object.keys(state.clips).length &&
    effects.length === state.effects.length
  )
    return state;
  return { ...state, clips, effects };
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
        effect: effect.effect as unknown as JsonValue,
      })),
    },
    updatedAt: new Date().toISOString(),
  };
}
