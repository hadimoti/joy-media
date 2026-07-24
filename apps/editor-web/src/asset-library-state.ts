import type { BrowserAsset, BrowserDerivative } from './control-plane-client.js';

export type AssetCategory = 'all' | BrowserAsset['kind'];
export type AssetAvailability = 'all' | BrowserDerivative['availability'] | 'none';
export type AssetSort = 'recent' | 'name' | 'size' | 'tags';
export type AssetViewMode = 'large' | 'medium' | 'list';

export interface AssetLibraryItem {
  readonly asset: BrowserAsset;
  readonly derivatives: readonly BrowserDerivative[];
}

export function filterAssetLibrary(
  items: readonly AssetLibraryItem[],
  category: AssetCategory,
  query: string,
  availability: AssetAvailability,
  sort: AssetSort,
): readonly AssetLibraryItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return [...items]
    .filter(({ asset }) => category === 'all' || asset.kind === category)
    .filter(({ asset }) => {
      if (normalizedQuery.length === 0) return true;
      const tags = (asset.tags ?? []).join(' ');
      return `${asset.displayName} ${asset.descriptor.mimeType} ${tags}`
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
        const leftName = left.asset.sortName ?? left.asset.displayName;
        const rightName = right.asset.sortName ?? right.asset.displayName;
        return leftName.localeCompare(rightName);
      }
      if (sort === 'size') return right.asset.bytes - left.asset.bytes;
      if (sort === 'tags') {
        const leftTags = (left.asset.tags ?? []).join(',');
        const rightTags = (right.asset.tags ?? []).join(',');
        const byTags = leftTags.localeCompare(rightTags);
        if (byTags !== 0) return byTags;
        return left.asset.displayName.localeCompare(right.asset.displayName);
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
