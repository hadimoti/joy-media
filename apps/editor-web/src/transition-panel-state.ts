import type { TransitionV1 } from '@joy-media/project-schema';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';

export const TRANSITION_FAVORITES_KEY = 'joy-media.transition-favorites.v1';

export interface TransitionJunction {
  readonly trackId: string;
  readonly leftClipId: string;
  readonly rightClipId: string;
}

export function readTransitionFavorites(storage: BrowserKeyValueStore): Set<string> {
  const raw = storage.getItem(TRANSITION_FAVORITES_KEY);
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

export function toggleTransitionFavorite(
  storage: BrowserKeyValueStore,
  favorites: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(favorites);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  storage.setItem(TRANSITION_FAVORITES_KEY, JSON.stringify([...next].sort()));
  return next;
}

export function transitionAtJunction(
  transitions: readonly TransitionV1[],
  junction: TransitionJunction | null,
): TransitionV1 | undefined {
  if (junction === null) return undefined;
  return transitions.find(
    (transition) =>
      transition.trackId === junction.trackId &&
      transition.leftClipId === junction.leftClipId &&
      transition.rightClipId === junction.rightClipId,
  );
}
