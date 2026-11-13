import { useSyncExternalStore } from 'react';
import type { LibraryPanelId } from './library-homes.js';

/**
 * The search shared by the Filters and the Effects panels (T-V06).
 *
 * The two panels are two views of one library, so one search box serves both:
 * what the owner types in Filters is what Effects looks for, and the other way
 * round. That is what makes the "Also in Effects" / "Also in Filters" links
 * work — the panel they open already holds the query.
 *
 * When one panel points at an item in the other, the id travels with it, so
 * the card that answers the pointer can be marked. The pointer also names the
 * panel it opens and carries a token that changes on every click, so that panel
 * can leave its Favorites view even when the owner follows the same link twice.
 */
export interface LibrarySearchState {
  /** What the owner typed. */
  readonly query: string;
  /** The item the other panel pointed at, so its card can be marked. */
  readonly linkedId?: string;
  /** The panel the pointer opens; only that panel switches to its normal view. */
  readonly linkedPanel?: LibraryPanelId;
  /** Changes on every pointer, so a repeated click is still a new pointer. */
  readonly linkToken?: number;
}

export interface LibrarySearchStore {
  readonly get: () => LibrarySearchState;
  readonly set: (state: LibrarySearchState) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createLibrarySearchStore(): LibrarySearchStore {
  let current: LibrarySearchState = { query: '' };
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(state) {
      if (
        state.query === current.query &&
        state.linkedId === current.linkedId &&
        state.linkedPanel === current.linkedPanel &&
        state.linkToken === current.linkToken
      )
        return;
      current = state;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The editor's one library search, shared by the Filters and the Effects panels. */
export const librarySearch: LibrarySearchStore = createLibrarySearchStore();

/** The live search state (both panels redraw when it changes). */
export function useLibrarySearch(store: LibrarySearchStore = librarySearch): LibrarySearchState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** What the owner typed. A new query drops the pointer to an item. */
export function setLibraryQuery(query: string, store: LibrarySearchStore = librarySearch): void {
  store.set({ query });
}

/**
 * Point the other panel at an item, keeping the query that found it. `toPanel`
 * is the panel the link opens; it leaves its Favorites view so the item is listed.
 */
export function pointLibraryAt(
  effectId: string,
  toPanel: LibraryPanelId,
  store: LibrarySearchStore = librarySearch,
): void {
  const previous = store.get().linkToken ?? 0;
  store.set({
    query: store.get().query,
    linkedId: effectId,
    linkedPanel: toPanel,
    linkToken: previous + 1,
  });
}
