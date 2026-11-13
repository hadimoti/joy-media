import { describe, expect, it, vi } from 'vitest';
import { registerSampleMedia, SAMPLE_MEDIA, SAMPLE_MEDIA_BASE_URL } from './sample-media-cache.js';
import type { RelinkCache } from './media-relink.js';
import type { OriginalAssetDescriptor } from './opfs-original-asset-cache.js';

/**
 * T-R01: a sample project's media is copied into the original cache on first open. Fake cache and fake
 * fetch only; the project record is never touched.
 */

function memoryCache(seed: readonly string[] = []) {
  const files = new Map<string, Blob>(seed.map((id) => [id, new Blob(['cached'])]));
  const puts: { descriptor: OriginalAssetDescriptor; file: Blob }[] = [];
  const cache: RelinkCache = {
    get: async (assetId) => files.get(assetId),
    put: async (descriptor, file) => {
      puts.push({ descriptor, file });
      files.set(descriptor.assetId, file);
    },
  };
  return { cache, puts };
}

function fakeFetch() {
  const requested: string[] = [];
  const fetchFile = vi.fn(async (url: string) => {
    requested.push(url);
    return new Blob([`bytes of ${url}`]);
  });
  return { fetchFile, requested };
}

describe('sample media on first open (T-R01)', () => {
  it('copies the sample files a project uses, with the hash and size of each file', async () => {
    const { cache, puts } = memoryCache();
    const { fetchFile, requested } = fakeFetch();

    const copied = await registerSampleMedia(['asset-intro', 'product-still'], {
      cache,
      fetchFile,
    });

    expect(copied).toEqual(['asset-intro', 'product-still']);
    expect(requested).toEqual([
      `${SAMPLE_MEDIA_BASE_URL}/asset-intro.mp4`,
      `${SAMPLE_MEDIA_BASE_URL}/product-still.png`,
    ]);
    const intro = puts.find((put) => put.descriptor.assetId === 'asset-intro');
    expect(intro?.descriptor.bytes).toBe(intro?.file.size);
    expect(intro?.descriptor.mimeType).toBe('video/mp4');
    expect(intro?.descriptor.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not copy a file that the project does not use', async () => {
    const { cache, puts } = memoryCache();
    const { fetchFile } = fakeFetch();

    await registerSampleMedia(['asset-intro'], { cache, fetchFile });

    expect(puts.map((put) => put.descriptor.assetId)).toEqual(['asset-intro']);
  });

  it('skips a file the cache already holds, so a second open fetches nothing', async () => {
    const { cache, puts } = memoryCache(['asset-intro']);
    const { fetchFile } = fakeFetch();

    const copied = await registerSampleMedia(['asset-intro', 'asset-outro'], { cache, fetchFile });

    expect(copied).toEqual(['asset-outro']);
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(puts.map((put) => put.descriptor.assetId)).toEqual(['asset-outro']);
  });

  it('does not overwrite a relink that lands while the sample file is fetched (T-R01)', async () => {
    const { cache, puts } = memoryCache();
    const relinked = new Blob(['the original the user relinked']);
    const fetchFile = vi.fn(async () => {
      // The user relinks the intro while the copy's fetch is still running.
      await cache.put(
        {
          assetId: 'asset-intro',
          sha256: 'b'.repeat(64),
          bytes: relinked.size,
          mimeType: 'video/mp4',
        },
        relinked,
      );
      return new Blob(['sample bytes']);
    });

    const copied = await registerSampleMedia(['asset-intro'], { cache, fetchFile });

    expect(copied).toEqual([]);
    expect(await cache.get('asset-intro')).toBe(relinked);
    expect(puts.map((put) => put.file)).toEqual([relinked]);
  });

  it('a project with no sample assets copies nothing', async () => {
    const { cache, puts } = memoryCache();
    const { fetchFile } = fakeFetch();

    expect(await registerSampleMedia(['joy-user-clip-1'], { cache, fetchFile })).toEqual([]);
    expect(fetchFile).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
  });

  it('covers every sample asset the two sample projects reference', () => {
    expect(SAMPLE_MEDIA.map((sample) => sample.assetId).sort()).toEqual(
      [
        'asset-intro',
        'asset-outro',
        'asset-product',
        'product-still',
        'showcase-audio-asset',
      ].sort(),
    );
  });
});
