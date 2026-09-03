import { describe, expect, it } from 'vitest';
import {
  MemoryStockVideoRepository,
  StockVideoService,
  type StockVideoCatalogRecord,
} from './stock-video.js';
import type { StockVideoProvider } from './stock-video-providers.js';

const candidate: StockVideoCatalogRecord = {
  catalogId: 'stock-pexels-1-hd',
  provider: 'pexels',
  providerAssetId: '1',
  category: 'nature',
  title: 'Fixture nature clip',
  creator: 'Fixture creator',
  sourcePageUrl: 'https://www.pexels.com/video/1/',
  termsUrl: 'https://www.pexels.com/license/',
  renditionId: 'hd',
  mediaUrl: 'https://videos.pexels.com/video-files/1/1.mp4',
  posterUrl: 'https://images.pexels.com/video/1.jpg',
  mimeType: 'video/mp4',
  width: 1280,
  height: 720,
  durationSeconds: 10,
  orientation: 'landscape',
  retrievedAt: 1,
};

function fixtureProvider(calls: { count: number }): StockVideoProvider {
  return {
    id: 'pexels',
    search: async () => {
      calls.count += 1;
      return [candidate];
    },
    fetchPoster: async () => new Response(new Uint8Array([1]), { status: 200 }),
    fetchPreview: async () => new Response(new Uint8Array([1]), { status: 200 }),
  };
}

describe('stock-video import and reliability contract', () => {
  it('isolates import identity by owner, provider, asset, and rendition', async () => {
    const repository = new MemoryStockVideoRepository();
    await repository.createImport({
      importId: 'import-one',
      ownerId: 'owner-one',
      projectId: 'project-one',
      catalogId: candidate.catalogId,
      provider: candidate.provider,
      providerAssetId: candidate.providerAssetId,
      renditionId: candidate.renditionId,
      state: 'claimed',
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(repository.findImport('owner-two', 'pexels', '1', 'hd')).resolves.toBeUndefined();
    await expect(repository.findImport('owner-one', 'pexels', '1', 'hd')).resolves.toMatchObject({
      importId: 'import-one',
    });
  });

  it('coalesces identical concurrent cache misses into one provider search', async () => {
    const repository = new MemoryStockVideoRepository();
    const calls = { count: 0 };
    const service = new StockVideoService({
      repository,
      providers: [fixtureProvider(calls)],
      controlPlane: {} as never,
      privateObjectStore: {} as never,
      now: () => 100,
    });

    const [first, second] = await Promise.all([
      service.search({ category: 'nature', query: '  trees  ' }),
      service.search({ category: 'nature', query: 'trees' }),
    ]);
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(calls.count).toBe(1);
  });

  it('projects catalog metadata without upstream media URLs or local storage paths', async () => {
    const repository = new MemoryStockVideoRepository();
    await repository.saveCatalog([candidate]);
    const service = new StockVideoService({
      repository,
      providers: [],
      controlPlane: {} as never,
      privateObjectStore: {} as never,
      now: () => 100,
    });

    const projected = await service.browserCatalog(candidate.catalogId);
    const serialized = JSON.stringify(projected);
    expect(serialized).toContain(candidate.sourcePageUrl);
    expect(serialized).toContain(candidate.termsUrl);
    expect(serialized).not.toContain('videos.pexels.com');
    expect(serialized).not.toContain('images.pexels.com');
    expect(serialized).not.toContain('object-store');
    expect(serialized).not.toContain('staging');
  });

  it('does not mutate an import before rejecting an unauthorized status read', async () => {
    const repository = new MemoryStockVideoRepository();
    await repository.createImport({
      importId: 'import-owner',
      ownerId: 'owner-one',
      projectId: 'project-one',
      catalogId: candidate.catalogId,
      provider: candidate.provider,
      providerAssetId: candidate.providerAssetId,
      renditionId: candidate.renditionId,
      state: 'claimed',
      createdAt: 1,
      updatedAt: 1,
    } as never);
    let updates = 0;
    const originalUpdate = repository.updateImport.bind(repository);
    repository.updateImport = async (importId, patch) => {
      updates += 1;
      return originalUpdate(importId, patch);
    };
    const service = new StockVideoService({
      repository,
      providers: [],
      controlPlane: {} as never,
      privateObjectStore: {} as never,
      now: () => 100,
    });

    await expect(
      service.importStatus({ id: 'owner-two' }, 'project-one', 'import-owner'),
    ).rejects.toThrow();
    expect(updates).toBe(0);
  });
});
