import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_FAVORITES_KEY,
  readTemplateFavorites,
  toggleTemplateFavorite,
} from './template-favorites.js';

function createStore(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(TEMPLATE_FAVORITES_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

describe('template favourites', () => {
  it('persists and reads the same favourite ids', () => {
    const storage = createStore();
    const next = toggleTemplateFavorite(storage, new Set(), 'joy.title');

    expect([...next]).toEqual(['joy.title']);
    expect(storage.values.get(TEMPLATE_FAVORITES_KEY)).toBe('["joy.title"]');
    expect([...readTemplateFavorites(storage)]).toEqual(['joy.title']);
  });

  it('tolerates malformed stored data', () => {
    expect(readTemplateFavorites(createStore('{')).size).toBe(0);
  });
});
