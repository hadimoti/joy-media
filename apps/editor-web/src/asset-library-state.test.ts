import { describe, expect, it } from 'vitest';
import {
  assetCollectionId,
  assetCollectionsForCategory,
  filterAssetLibrary,
  preferredDerivative,
  ASSET_RENDER_MAX,
  ASSET_RENDER_PAGE_SIZE,
  assetLibraryPageCount,
  nextAssetRenderLimit,
  renderAssetLibraryItems,
  type AssetLibraryItem,
} from './asset-library-state.js';

const items: readonly AssetLibraryItem[] = [
  {
    asset: {
      id: 'video-1',
      projectId: 'project-1',
      kind: 'video',
      displayName: 'Launch cut',
      sha256: 'a'.repeat(64),
      bytes: 200,
      descriptor: { mimeType: 'video/mp4' },
      tags: ['category-clips'],
      createdAt: 20,
    },
    derivatives: [
      {
        id: 'local-1',
        projectId: 'project-1',
        assetId: 'video-1',
        kind: 'proxy',
        profile: 'mp4-720',
        sha256: 'b'.repeat(64),
        bytes: 100,
        descriptor: { mimeType: 'video/mp4' },
        availability: 'available-local',
        verifiedAt: 11,
      },
      {
        id: 'cloud-1',
        projectId: 'project-1',
        assetId: 'video-1',
        kind: 'proxy',
        profile: 'mp4-720',
        sha256: 'c'.repeat(64),
        bytes: 100,
        descriptor: { mimeType: 'video/mp4' },
        availability: 'available-cloud',
        verifiedAt: 10,
      },
    ],
  },
  {
    asset: {
      id: 'image-1',
      projectId: 'project-1',
      kind: 'image',
      displayName: 'Lower third',
      sha256: 'd'.repeat(64),
      bytes: 50,
      descriptor: { mimeType: 'image/png' },
      tags: ['category-logo', 'logo'],
      createdAt: 10,
    },
    derivatives: [],
  },
  {
    asset: {
      id: 'image-2',
      projectId: 'project-1',
      kind: 'image',
      displayName: 'Imported alpha element',
      sha256: 'e'.repeat(64),
      bytes: 40,
      descriptor: { mimeType: 'image/png' },
      tags: ['joy-media-library', 'category-unknown', 'transparent'],
      createdAt: 9,
    },
    derivatives: [],
  },
];

describe('asset library state', () => {
  it('combines media type, collection, search, availability, and sort without changing catalog records', () => {
    expect(
      filterAssetLibrary(items, 'video', 'category:clips', 'launch', 'available-cloud', 'recent'),
    ).toEqual([items[0]]);
    expect(filterAssetLibrary(items, 'image', 'category:logo', '', 'none', 'name')).toEqual([
      items[1],
    ]);
  });

  it('provides a browse collection plus semantic collections for current and future media', () => {
    expect(assetCollectionId(items[1]!.asset)).toBe('category:logo');
    expect(assetCollectionId(items[2]!.asset)).toBe('category:review');
    expect(assetCollectionsForCategory(items, 'image')).toEqual([
      { id: 'browse', label: 'Browse', count: 2 },
      { id: 'category:review', label: 'Needs review', count: 1 },
      { id: 'category:logo', label: 'Brand marks', count: 1 },
    ]);
    expect(assetCollectionsForCategory(items, 'video')).toEqual([
      { id: 'browse', label: 'Browse', count: 1 },
      { id: 'category:clips', label: 'Clips', count: 1 },
    ]);
  });

  it('prefers verified cloud playback over a newer local cache record', () => {
    expect(preferredDerivative(items[0]!.derivatives)?.id).toBe('cloud-1');
  });

  it('keeps the panel card window bounded while paging through 501 matching assets', () => {
    const largeLibrary = Array.from({ length: 501 }, (_, index) => ({
      ...items[1]!,
      asset: { ...items[1]!.asset, id: `image-${index + 1}`, displayName: `Asset ${index + 1}` },
    }));
    const initial = renderAssetLibraryItems(largeLibrary, ASSET_RENDER_PAGE_SIZE);
    expect(initial).toHaveLength(120);

    const afterLoadMoreLimit = nextAssetRenderLimit(initial.length, largeLibrary.length);
    expect(renderAssetLibraryItems(largeLibrary, afterLoadMoreLimit)).toHaveLength(240);
    expect(afterLoadMoreLimit).toBeLessThanOrEqual(ASSET_RENDER_MAX);

    const afterRepeatedLoads = nextAssetRenderLimit(
      nextAssetRenderLimit(afterLoadMoreLimit, largeLibrary.length),
      largeLibrary.length,
    );
    expect(renderAssetLibraryItems(largeLibrary, afterRepeatedLoads)).toHaveLength(250);
    expect(afterRepeatedLoads).toBeLessThanOrEqual(ASSET_RENDER_MAX);
    expect(assetLibraryPageCount(501)).toBe(3);
    expect(renderAssetLibraryItems(largeLibrary, ASSET_RENDER_MAX, 1)[0]).toBe(largeLibrary[250]);
    expect(renderAssetLibraryItems(largeLibrary, ASSET_RENDER_MAX, 2)).toHaveLength(1);
    expect(renderAssetLibraryItems(largeLibrary, ASSET_RENDER_MAX, 2)[0]).toBe(largeLibrary[500]);
    for (const page of [0, 1, 2]) {
      expect(
        renderAssetLibraryItems(largeLibrary, ASSET_RENDER_MAX, page).length,
      ).toBeLessThanOrEqual(250);
    }
  });
});
