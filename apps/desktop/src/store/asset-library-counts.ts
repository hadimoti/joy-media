/**
 * How many items the asset library holds, by kind (T-P08).
 *
 * The dialog shows Video, Images, Audio and Total, and the four numbers must
 * add up: the total is always the sum of the kinds, with anything that is not
 * video, an image or audio counted as "other". So the counts are built in one
 * place, and the total is never a separate number that can drift.
 */

export interface AssetLibraryCounts {
  /** Every item in the library. */
  readonly total: number;
  readonly video: number;
  readonly image: number;
  readonly audio: number;
  /** Items of a kind we do not name on the dialog. */
  readonly other: number;
}

export const EMPTY_ASSET_LIBRARY_COUNTS: AssetLibraryCounts = {
  total: 0,
  video: 0,
  image: 0,
  audio: 0,
  other: 0,
};

function kindOf(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const kind = (entry as Record<string, unknown>).kind;
  return typeof kind === 'string' ? kind : undefined;
}

/**
 * Counts the catalog entries by their kind. Anything that is not video, an
 * image or audio is counted as "other", so the four numbers add up to the
 * total by construction.
 */
export function countLibraryAssets(assets: readonly unknown[]): AssetLibraryCounts {
  let video = 0;
  let image = 0;
  let audio = 0;
  for (const entry of assets) {
    const kind = kindOf(entry);
    if (kind === 'video') video += 1;
    else if (kind === 'image') image += 1;
    else if (kind === 'audio') audio += 1;
  }
  const total = assets.length;
  return { total, video, image, audio, other: total - video - image - audio };
}

/**
 * Counts from a stored `counts` block, for a catalog that carries a total but
 * no asset list. The kinds the block does not name land in "other", so the
 * numbers still add up.
 */
export function countsFromStoredCounts(stored: unknown): AssetLibraryCounts {
  const block = (
    typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}
  ) as Record<string, unknown>;
  const number = (key: string): number => {
    const value = Number(block[key]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  };
  const total = number('total');
  const video = number('video');
  const image = number('image');
  const audio = number('audio');
  return { total, video, image, audio, other: Math.max(0, total - video - image - audio) };
}

/** Do the counts add up to the total? The dialog relies on it. */
export function countsAddUp(counts: AssetLibraryCounts): boolean {
  return counts.video + counts.image + counts.audio + counts.other === counts.total;
}
