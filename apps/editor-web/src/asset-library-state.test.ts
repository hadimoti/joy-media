import { describe, expect, it } from 'vitest';
import {
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
      createdAt: 10,
    },
    derivatives: [],
  },
];

describe('asset library state', () => {
  it('combines category, search, availability, and sort without changing catalog records', () => {
    expect(filterAssetLibrary(items, 'video', 'launch', 'available-cloud', 'recent')).toEqual([
      items[0],
    ]);
    expect(filterAssetLibrary(items, 'all', '', 'none', 'name')).toEqual([items[1]]);
  });

  it('prefers verified cloud playback over a newer local cache record', () => {
    expect(preferredDerivative(items[0]!.derivatives)?.id).toBe('cloud-1');
  });
});
