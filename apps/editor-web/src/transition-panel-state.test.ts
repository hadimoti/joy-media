import { describe, expect, it } from 'vitest';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import {
  readTransitionFavorites,
  toggleTransitionFavorite,
  transitionAtJunction,
  TRANSITION_FAVORITES_KEY,
} from './transition-panel-state.js';

function memoryStore(): BrowserKeyValueStore {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('transition panel state', () => {
  it('persists favorite ids and tolerates malformed storage', () => {
    const storage = memoryStore();
    const favorites = toggleTransitionFavorite(storage, new Set(), 'dissolve');
    expect([...readTransitionFavorites(storage)]).toEqual(['dissolve']);
    expect([...toggleTransitionFavorite(storage, favorites, 'dissolve')]).toEqual([]);
    storage.setItem(TRANSITION_FAVORITES_KEY, '{broken');
    expect([...readTransitionFavorites(storage)]).toEqual([]);
  });

  it('finds the transition attached to the selected junction', () => {
    const transition = {
      id: 'transition-1',
      trackId: 'video-1',
      leftClipId: 'left',
      rightClipId: 'right',
      type: 'dissolve',
      durationUs: 500_000,
    };
    expect(transitionAtJunction([transition], transition)).toBe(transition);
    expect(
      transitionAtJunction([transition], { ...transition, rightClipId: 'other' }),
    ).toBeUndefined();
  });
});
