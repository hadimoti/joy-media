/**
 * Favourites for the library panels (T-V06).
 *
 * A favourite belongs to the item, not to the panel: when an item moves from
 * Filters to Effects its favourite moves with it, because the registry ids do
 * not change. The list is shared by both panels and kept in the writer-gated
 * browser storage, so it survives the panel being closed.
 */

/** The storage the favourites live in (browser localStorage, writer-gated). */
export interface FavoritesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const EFFECT_FAVORITES_KEY = 'joy-media.effect-favorites.v1';

/** The unversioned key an early build wrote, if there was one. */
const LEGACY_EFFECT_FAVORITES_KEY = 'joy-media.effect-favorites';

function parseIds(raw: string | null): readonly string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

/**
 * The saved favourites, with the ids that no longer exist in the registry
 * dropped. A favourite for an item that moved panels is kept: its id did not
 * change, so the favourite is still that item.
 */
export function migrateEffectFavorites(
  stored: readonly string[],
  knownIds: readonly string[],
): readonly string[] {
  const known = new Set(knownIds);
  const kept: string[] = [];
  for (const id of stored) if (known.has(id) && !kept.includes(id)) kept.push(id);
  return kept;
}

/** The saved favourites for the library. */
export function readEffectFavorites(
  storage: FavoritesStorage | undefined,
  knownIds: readonly string[] = [],
): Set<string> {
  if (storage === undefined) return new Set();
  const stored = [
    ...parseIds(storage.getItem(LEGACY_EFFECT_FAVORITES_KEY)),
    ...parseIds(storage.getItem(EFFECT_FAVORITES_KEY)),
  ];
  return new Set(migrateEffectFavorites(stored, knownIds));
}

/** Write the favourites back, so the other panel and the next session see them. */
export function writeEffectFavorites(
  storage: FavoritesStorage | undefined,
  favorites: ReadonlySet<string>,
): void {
  if (storage === undefined) return;
  storage.setItem(EFFECT_FAVORITES_KEY, JSON.stringify([...favorites]));
}

/** Add or remove one favourite and save the result. */
export function toggleEffectFavorite(
  storage: FavoritesStorage | undefined,
  favorites: ReadonlySet<string>,
  effectId: string,
): Set<string> {
  const next = new Set(favorites);
  if (next.has(effectId)) next.delete(effectId);
  else next.add(effectId);
  writeEffectFavorites(storage, next);
  return next;
}
