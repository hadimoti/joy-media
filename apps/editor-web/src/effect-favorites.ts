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
  removeItem(key: string): void;
}

export const EFFECT_FAVORITES_KEY = 'joy-media.effect-favorites.v1';

/** The unversioned key an early build wrote, if there was one. */
const LEGACY_EFFECT_FAVORITES_KEY = 'joy-media.effect-favorites';

/** Every storage call is guarded: the page must work when storage is unavailable. */
function readKey(storage: FavoritesStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

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

/**
 * The saved favourites for the library. This only reads: the legacy list is
 * merged in on every read, and it is retired by the first write (see
 * {@link writeEffectFavorites}), never here.
 */
export function readEffectFavorites(
  storage: FavoritesStorage | undefined,
  knownIds: readonly string[] = [],
): Set<string> {
  if (storage === undefined) return new Set();
  const stored = [
    ...parseIds(readKey(storage, LEGACY_EFFECT_FAVORITES_KEY)),
    ...parseIds(readKey(storage, EFFECT_FAVORITES_KEY)),
  ];
  return new Set(migrateEffectFavorites(stored, knownIds));
}

/**
 * Write the favourites back, so the other panel and the next session see them.
 * The versioned key is written first; only then is the legacy key deleted. This
 * is the one-time migration: after it, a removed favourite cannot come back from
 * the legacy list. A failed write keeps the legacy key, so nothing is lost.
 */
export function writeEffectFavorites(
  storage: FavoritesStorage | undefined,
  favorites: ReadonlySet<string>,
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(EFFECT_FAVORITES_KEY, JSON.stringify([...favorites]));
  } catch {
    return;
  }
  try {
    storage.removeItem(LEGACY_EFFECT_FAVORITES_KEY);
  } catch {
    // The versioned list is already saved; the legacy key stays and the next write retries.
  }
}

/**
 * Add or remove one favourite and save the result. This is a user action, so it
 * is where the legacy list is merged in before the change: the write then keeps
 * every legacy favourite and retires the legacy key.
 */
export function toggleEffectFavorite(
  storage: FavoritesStorage | undefined,
  favorites: ReadonlySet<string>,
  effectId: string,
): Set<string> {
  const legacy =
    storage === undefined ? [] : parseIds(readKey(storage, LEGACY_EFFECT_FAVORITES_KEY));
  const next = new Set([...favorites, ...legacy]);
  if (next.has(effectId)) next.delete(effectId);
  else next.add(effectId);
  writeEffectFavorites(storage, next);
  return next;
}
