import { sha256OfBlob } from './blob-sha256.js';
import type { RelinkCache } from './media-relink.js';

/**
 * The sample media the app ships (T-R01). Each file is the original of one sample asset id, so a sample
 * project shows its media without a Relink: the file is copied into this profile's original cache on first open.
 */
export const SAMPLE_MEDIA: readonly {
  readonly assetId: string;
  readonly fileName: string;
  readonly mimeType: string;
}[] = Object.freeze([
  { assetId: 'asset-intro', fileName: 'asset-intro.mp4', mimeType: 'video/mp4' },
  { assetId: 'asset-product', fileName: 'asset-product.mp4', mimeType: 'video/mp4' },
  { assetId: 'asset-outro', fileName: 'asset-outro.mp4', mimeType: 'video/mp4' },
  { assetId: 'product-still', fileName: 'product-still.png', mimeType: 'image/png' },
  { assetId: 'showcase-audio-asset', fileName: 'showcase-audio-asset.m4a', mimeType: 'audio/mp4' },
]);

/** Where the app serves the sample files. */
export const SAMPLE_MEDIA_BASE_URL = '/media/reference';

export interface SampleMediaOptions {
  readonly cache: RelinkCache;
  /** Fetches one sample file. Injected so the copy is tested without a server. */
  readonly fetchFile: (url: string) => Promise<Blob>;
  readonly baseUrl?: string;
}

/**
 * Copies the sample files that the given project assets use into the local original cache, unless the cache
 * already holds them. Only the cache is written: the project record is never changed, and a file not used by
 * the project is not copied. Returns the asset ids that were copied.
 */
export async function registerSampleMedia(
  projectAssetIds: Iterable<string>,
  options: SampleMediaOptions,
): Promise<readonly string[]> {
  const wanted = new Set(projectAssetIds);
  const baseUrl = options.baseUrl ?? SAMPLE_MEDIA_BASE_URL;
  const copied: string[] = [];
  for (const sample of SAMPLE_MEDIA) {
    if (!wanted.has(sample.assetId)) continue;
    if ((await options.cache.get(sample.assetId)) !== undefined) continue;
    const file = await options.fetchFile(`${baseUrl}/${encodeURIComponent(sample.fileName)}`);
    const sha256 = await sha256OfBlob(file);
    // The check above came before the fetch: a relink made meanwhile wins, so the copy is not written over it.
    if ((await options.cache.get(sample.assetId)) !== undefined) continue;
    await options.cache.put(
      { assetId: sample.assetId, sha256, bytes: file.size, mimeType: sample.mimeType },
      file,
    );
    copied.push(sample.assetId);
  }
  return copied;
}

/** The browser's fetch of one sample file, as a Blob. */
export async function fetchSampleBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`sample media ${url} could not be loaded (HTTP ${response.status})`);
  return response.blob();
}
