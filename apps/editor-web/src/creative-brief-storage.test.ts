import { describe, expect, it } from 'vitest';
import {
  creativeBriefStorageKey,
  loadCreativeBrief,
  removeCreativeBrief,
  saveCreativeBrief,
} from './creative-brief-storage.js';

const brief = {
  schemaVersion: 1,
  snapshotRevisionId: 'rev-1',
  projectId: 'project-1',
  request: 'Improve pacing',
} as never;

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('creative brief storage', () => {
  it('round-trips a generated brief by project', () => {
    const state = storage();
    saveCreativeBrief(state, 'project-1', brief);
    expect(loadCreativeBrief(state, 'project-1')).toEqual(brief);
  });

  it('ignores malformed or incomplete saved values', () => {
    const state = storage();
    state.setItem(creativeBriefStorageKey('project-1'), '{broken');
    expect(loadCreativeBrief(state, 'project-1')).toBeUndefined();
    state.setItem(creativeBriefStorageKey('project-1'), JSON.stringify({ schemaVersion: 1 }));
    expect(loadCreativeBrief(state, 'project-1')).toBeUndefined();
  });

  it('removes a saved brief when the user clears it', () => {
    const state = storage();
    saveCreativeBrief(state, 'project-1', brief);
    removeCreativeBrief(state, 'project-1');
    expect(loadCreativeBrief(state, 'project-1')).toBeUndefined();
  });
});
