import { describe, expect, it } from 'vitest';
import {
  assetCollectionId,
  assetCollectionsForCategory,
  filterAssetLibrary,
  preferredDerivative,
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
      cloudBacked: true,
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
      cloudBacked: false,
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
      cloudBacked: true,
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
});
