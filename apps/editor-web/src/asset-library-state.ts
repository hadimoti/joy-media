import type { BrowserAsset, BrowserDerivative } from './control-plane-client.js';

/** Primary library sections. There is deliberately no global "all assets" view. */
export type AssetCategory = BrowserAsset['kind'] | 'all';
export type AssetCollectionId = 'browse' | `category:${string}`;
export type AssetAvailability = 'all' | BrowserDerivative['availability'] | 'none';
export type AssetSort = 'recent' | 'name' | 'size' | 'tags';
export type AssetViewMode = 'large' | 'medium' | 'list';
export const ASSET_RENDER_PAGE_SIZE = 120;

export interface AssetLibraryItem {
  readonly asset: BrowserAsset;
  readonly derivatives: readonly BrowserDerivative[];
}

export function importedAssetRevealState(asset: BrowserAsset): {
  readonly assetSource: 'user';
  readonly category: AssetCategory;
  readonly collection: 'browse';
  readonly query: '';
  readonly availability: 'all';
  readonly sort: 'recent';
  readonly renderLimit: typeof ASSET_RENDER_PAGE_SIZE;
} {
  return {
    assetSource: 'user',
    category: asset.kind,
    collection: 'browse',
    query: '',
    availability: 'all',
    sort: 'recent',
    renderLimit: ASSET_RENDER_PAGE_SIZE,
  };
}

export function includeOwnedAsset(
  items: readonly AssetLibraryItem[],
  ownedAssetIds: ReadonlySet<string>,
  asset: BrowserAsset,
): {
  readonly items: readonly AssetLibraryItem[];
  readonly ownedAssetIds: ReadonlySet<string>;
} {
  const existing = items.findIndex((item) => item.asset.id === asset.id);
  const nextItems =
    existing === -1
      ? [...items, { asset, derivatives: [] }]
      : items.map((item, index) => (index === existing ? { ...item, asset } : item));
  return {
    items: nextItems,
    ownedAssetIds: new Set([...ownedAssetIds, asset.id]),
  };
}

export interface AssetLibraryCollection {
  readonly id: AssetCollectionId;
  readonly label: string;
  readonly count: number;
}

const CATEGORY_PREFIX = 'category-';

const COLLECTION_LABELS: Readonly<Record<string, string>> = {
  elements: 'Creative elements',
  review: 'Needs review',
  logo: 'Brand marks',
  arrow: 'Arrows',
  effects: 'Effects',
  icon: 'Icons',
  illustration: 'Illustrations',
  pattern: 'Patterns',
  photo: 'Photos',
  shape: 'Shapes',
  text: 'Text',
  transition: 'Transitions',
  ui: 'UI graphics',
  clips: 'Clips',
  tracks: 'Tracks',
};

const COLLECTION_ORDER = [
  'elements',
  'review',
  'logo',
  'arrow',
  'effects',
  'icon',
  'illustration',
  'pattern',
  'photo',
  'shape',
  'text',
  'transition',
  'ui',
  'clips',
  'tracks',
] as const;

/**
 * The importer writes category-* tags. Older or locally imported media still
 * receives a useful deterministic home, so every media item can be browsed.
 */
export function assetCollectionId(asset: BrowserAsset): AssetCollectionId {
  const tags = asset.tags ?? [];
  const taggedCategory = tags.find(
    (tag) => tag.startsWith(CATEGORY_PREFIX) && tag !== 'category-unknown',
  );
  if (taggedCategory !== undefined)
    return `category:${taggedCategory.slice(CATEGORY_PREFIX.length)}`;

  // Do not silently present incomplete import metadata as a creative element.
  if (tags.includes('category-unknown')) return 'category:review';
  if (tags.includes('logo')) return 'category:logo';
  if (tags.includes('arrow')) return 'category:arrow';
  if (asset.kind === 'video') return 'category:clips';
  if (asset.kind === 'audio') return 'category:tracks';
  return 'category:elements';
}

export function assetCollectionsForCategory(
  items: readonly AssetLibraryItem[],
  category: AssetCategory,
): readonly AssetLibraryCollection[] {
  const matching = items.filter(({ asset }) => category === 'all' || asset.kind === category);
  const counts = new Map<AssetCollectionId, number>();
  for (const { asset } of matching) {
    const id = assetCollectionId(asset);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const ordered = [...counts.entries()].sort(([left], [right]) => {
    const leftSlug = left.slice('category:'.length);
    const rightSlug = right.slice('category:'.length);
    const leftIndex = COLLECTION_ORDER.indexOf(leftSlug as (typeof COLLECTION_ORDER)[number]);
    const rightIndex = COLLECTION_ORDER.indexOf(rightSlug as (typeof COLLECTION_ORDER)[number]);
    if (leftIndex !== rightIndex) {
      return (
        (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
        (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
      );
    }
    return assetCollectionLabel(left).localeCompare(assetCollectionLabel(right));
  });

  return [
    { id: 'browse', label: 'Browse', count: matching.length },
    ...ordered.map(([id, count]) => ({ id, label: assetCollectionLabel(id), count })),
  ];
}

export function filterAssetLibrary(
  items: readonly AssetLibraryItem[],
  category: AssetCategory,
  collection: AssetCollectionId,
  query: string,
  availability: AssetAvailability,
  sort: AssetSort,
): readonly AssetLibraryItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return [...items]
    .filter(({ asset }) => category === 'all' || asset.kind === category)
    .filter(({ asset }) => collection === 'browse' || assetCollectionId(asset) === collection)
    .filter(({ asset }) => {
      if (normalizedQuery.length === 0) return true;
      const name = asset.displayName ?? asset.sortName ?? asset.id ?? '';
      const tags = (asset.tags ?? []).join(' ');
      return `${name} ${asset.descriptor.mimeType} ${tags}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    })
    .filter(({ derivatives }) => {
      if (availability === 'all') return true;
      if (availability === 'none') return derivatives.length === 0;
      return derivatives.some((derivative) => derivative.availability === availability);
    })
    .sort((left, right) => {
      if (sort === 'name') {
        const leftName = left.asset.sortName ?? left.asset.displayName ?? left.asset.id ?? '';
        const rightName = right.asset.sortName ?? right.asset.displayName ?? right.asset.id ?? '';
        return leftName.localeCompare(rightName);
      }
      if (sort === 'size') return right.asset.bytes - left.asset.bytes;
      if (sort === 'tags') {
        const leftTags = (left.asset.tags ?? []).join(',');
        const rightTags = (right.asset.tags ?? []).join(',');
        const byTags = leftTags.localeCompare(rightTags);
        if (byTags !== 0) return byTags;
        const leftDisplayName = left.asset.displayName ?? left.asset.sortName ?? left.asset.id ?? '';
        const rightDisplayName = right.asset.displayName ?? right.asset.sortName ?? right.asset.id ?? '';
        return leftDisplayName.localeCompare(rightDisplayName);
      }
      return right.asset.createdAt - left.asset.createdAt;
    });
}

/** Prefer a cloud-verified derivative, then the most recently verified local one. */
export function preferredDerivative(
  derivatives: readonly BrowserDerivative[],
): BrowserDerivative | undefined {
  return [...derivatives]
    .filter(
      (derivative) =>
        derivative.availability === 'available-cloud' ||
        derivative.availability === 'available-local',
    )
    .sort((left, right) => {
      const availability =
        Number(right.availability === 'available-cloud') -
        Number(left.availability === 'available-cloud');
      return availability === 0 ? right.verifiedAt - left.verifiedAt : availability;
    })[0];
}

export function assetCollectionLabel(id: AssetCollectionId): string {
  if (id === 'browse') return 'Browse';
  const slug = id.slice('category:'.length);
  return (
    COLLECTION_LABELS[slug] ??
    slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}
