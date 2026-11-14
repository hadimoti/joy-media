import type { BrowserKeyValueStore } from '@joy-media/project-persistence';

export const TEMPLATE_FAVORITES_KEY = 'joy-media.template-favorites.v1';

export function readTemplateFavorites(storage: BrowserKeyValueStore): Set<string> {
  const raw = storage.getItem(TEMPLATE_FAVORITES_KEY);
  if (raw === null) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

export function toggleTemplateFavorite(
  storage: BrowserKeyValueStore,
  favorites: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(favorites);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  storage.setItem(TEMPLATE_FAVORITES_KEY, JSON.stringify([...next].sort()));
  return next;
}
