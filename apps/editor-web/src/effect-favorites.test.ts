import { describe, expect, it } from 'vitest';
import {
  EFFECT_FAVORITES_KEY,
  migrateEffectFavorites,
  readEffectFavorites,
  toggleEffectFavorite,
  writeEffectFavorites,
} from './effect-favorites.js';

function memoryStore(): {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
  readonly map: Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const KNOWN = ['halftone', 'sepia', 'gaussian-blur', 'twist'];

describe('library favourites (T-V06)', () => {
  it('saves a favourite and reads it back', () => {
    const storage = memoryStore();
    const favorites = toggleEffectFavorite(storage, new Set(), 'halftone');
    expect([...favorites]).toEqual(['halftone']);
    expect(storage.map.get(EFFECT_FAVORITES_KEY)).toBe('["halftone"]');
    expect([...readEffectFavorites(storage, KNOWN)]).toEqual(['halftone']);
  });

  it('keeps a favourite for an item that moved panels, because the id did not change', () => {
    const storage = memoryStore();
    // Halftone used to live in Filters; it is an Effect now.
    writeEffectFavorites(storage, new Set(['halftone']));
    expect([...readEffectFavorites(storage, KNOWN)]).toEqual(['halftone']);
  });

  it('drops a favourite whose item no longer exists', () => {
    const storage = memoryStore();
    writeEffectFavorites(storage, new Set(['halftone', 'an-effect-that-was-removed']));
    expect([...readEffectFavorites(storage, KNOWN)]).toEqual(['halftone']);
  });

  it('merges an unversioned list written by an earlier build', () => {
    const storage = memoryStore();
    storage.setItem('joy-media.effect-favorites', '["sepia"]');
    storage.setItem(EFFECT_FAVORITES_KEY, '["halftone"]');
    expect([...readEffectFavorites(storage, KNOWN)].sort()).toEqual(['halftone', 'sepia']);
  });

  it('tolerates malformed storage', () => {
    const storage = memoryStore();
    storage.setItem(EFFECT_FAVORITES_KEY, '{broken');
    expect([...readEffectFavorites(storage, KNOWN)]).toEqual([]);
  });

  it('has no favourites without a store', () => {
    expect([...readEffectFavorites(undefined, KNOWN)]).toEqual([]);
    expect([...toggleEffectFavorite(undefined, new Set(), 'halftone')]).toEqual(['halftone']);
  });

  it('keeps one copy of an id that is saved twice', () => {
    expect(migrateEffectFavorites(['halftone', 'halftone'], KNOWN)).toEqual(['halftone']);
  });
});
