import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { resolveAssetThumb, type AssetThumbResult } from './asset-card-preview.js';
import type { BrowserAsset, BrowserDerivative } from './control-plane-client.js';
import type { AuthorizedDerivativeResolver } from './asset-resolver.js';
import type { OpfsOriginalAssetCache } from './opfs-original-asset-cache.js';

const previewSource = readFileSync(new URL('./asset-card-preview.ts', import.meta.url), 'utf8');

/**
 * Regression guard for JOY-002: asset preview buttons were `disabled` for any
 * asset without a formal derivative, and `openPreview` required a derivative —
 * so locally imported / OPFS-only images could never be previewed.
 * `resolveAssetThumb` must fall back from derivatives to the OPFS original,
 * then the desktop library file, and return `none` when no source is available.
 */
const IMAGE: BrowserAsset = {
  id: 'img-1',
  projectId: 'prj-1',
  kind: 'image',
  displayName: '24 7 Badge',
  sha256: 'a'.repeat(64),
  bytes: 1000,
  descriptor: { mimeType: 'image/png' },
  createdAt: 1_700_000_000_000,
  cloudBacked: false,
};

const VIDEO: BrowserAsset = {
  id: 'vid-1',
  projectId: 'prj-1',
  kind: 'video',
  displayName: 'clip.mp4',
  sha256: 'c'.repeat(64),
  bytes: 2000,
  descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000 },
  createdAt: 1_700_000_000_000,
  cloudBacked: false,
};

const DERIVATIVE: BrowserDerivative = {
  id: 'dv-1',
  projectId: 'prj-1',
  assetId: 'img-1',
  kind: 'thumbnail',
  profile: 'thumbnail',
  sha256: 'b'.repeat(64),
  bytes: 500,
  descriptor: { mimeType: 'image/png' },
  availability: 'available-local',
  verifiedAt: 1_700_000_000_000,
};

function fakeResolver(outcome: unknown): AuthorizedDerivativeResolver {
  return { resolve: vi.fn().mockResolvedValue(outcome) } as unknown as AuthorizedDerivativeResolver;
}

function fakeOriginal(blob: Blob | undefined): OpfsOriginalAssetCache {
  return { get: vi.fn().mockResolvedValue(blob) } as unknown as OpfsOriginalAssetCache;
}

describe('resolveAssetThumb fallback chain', () => {
  it('keeps card previews on local sources', () => {
    expect(previewSource).not.toContain('fetchCloudOriginal');
    expect(previewSource).not.toContain('cloudBacked');
    expect(previewSource).not.toContain("source: 'cloud'");
  });

  it('uses the derivative before the library URL when it resolves available-local', async () => {
    const resolver = fakeResolver({
      state: 'available-local',
      url: 'blob:dv',
      revoke: () => undefined,
    });
    const result: AssetThumbResult = await resolveAssetThumb({
      asset: { ...IMAGE, relativePath: 'images/library.png' },
      derivatives: [DERIVATIVE],
      projectId: 'prj-1',
      resolver,
      originalCache: fakeOriginal(undefined),
      libraryUrl: (relativePath) => `joy-asset://library/${relativePath}`,
    });
    expect(result.source).toBe('derivative');
    expect(result.url).toBe('blob:dv');
    expect(result.mimeType).toBe('image/png');
  });

  it('uses the OPFS original before the library URL when there is no derivative', async () => {
    const original = new Blob([], { type: 'image/png' });
    const result = await resolveAssetThumb({
      asset: { ...IMAGE, relativePath: 'images/library.png' },
      derivatives: [],
      projectId: 'prj-1',
      resolver: fakeResolver({ state: 'unavailable' }),
      originalCache: fakeOriginal(original),
      libraryUrl: (relativePath) => `joy-asset://library/${relativePath}`,
    });
    expect(result.source).toBe('opfs');
  });

  it('returns none when no library URL callback is available', async () => {
    const result = await resolveAssetThumb({
      asset: { ...IMAGE, relativePath: 'images/cover.png' },
      derivatives: [],
      projectId: 'prj-1',
      resolver: fakeResolver({ state: 'unavailable' }),
      originalCache: fakeOriginal(undefined),
    });
    expect(result.source).toBe('none');
    expect(result.url).toBeUndefined();
  });

  it('uses the desktop library URL for an image after local caches miss', async () => {
    const asset = { ...IMAGE, relativePath: 'images/cover.png' };
    const libraryUrl = vi.fn((relativePath: string) => `joy-asset://library/${relativePath}`);
    const result = await resolveAssetThumb({
      asset,
      derivatives: [],
      projectId: 'prj-1',
      resolver: fakeResolver({ state: 'unavailable' }),
      originalCache: fakeOriginal(undefined),
      libraryUrl,
    });

    expect(result).toMatchObject({
      source: 'library',
      url: 'joy-asset://library/images/cover.png',
      mimeType: 'image/png',
    });
    expect(libraryUrl).toHaveBeenCalledWith('images/cover.png');
    expect(() => result.revoke()).not.toThrow();
  });

  it('uses the descriptor MIME type for a library video', async () => {
    const asset = {
      ...VIDEO,
      relativePath: 'video/clip',
    };
    const result = await resolveAssetThumb({
      asset,
      derivatives: [],
      projectId: 'prj-1',
      resolver: fakeResolver({ state: 'unavailable' }),
      originalCache: fakeOriginal(undefined),
      libraryUrl: (relativePath) => `joy-asset://library/${relativePath}`,
    });

    expect(result).toMatchObject({
      source: 'library',
      url: 'joy-asset://library/video/clip',
      mimeType: 'video/mp4',
    });
  });

  it('uses the kind fallback MIME type for an image with an octet-stream descriptor', async () => {
    const result = await resolveAssetThumb({
      asset: {
        ...IMAGE,
        relativePath: 'images/cover',
        descriptor: { mimeType: 'application/octet-stream' },
      },
      derivatives: [],
      projectId: 'prj-1',
      resolver: fakeResolver({ state: 'unavailable' }),
      originalCache: fakeOriginal(undefined),
      libraryUrl: (relativePath) => `joy-asset://library/${relativePath}`,
    });

    expect(result.mimeType).toBe('image/unknown');
  });

  it('keeps audio on its icon even when a library URL callback is available', async () => {
    const asset = { ...IMAGE, kind: 'audio' as const, relativePath: 'audio/song.wav' };
    const result = await resolveAssetThumb({
      asset,
      derivatives: [],
      projectId: 'prj-1',
      resolver: fakeResolver({ state: 'unavailable' }),
      originalCache: fakeOriginal(undefined),
      libraryUrl: (relativePath) => `joy-asset://library/${relativePath}`,
    });

    expect(result.source).toBe('none');
    expect(result.url).toBeUndefined();
  });

  it('does not use the library URL for an empty relative path', async () => {
    const libraryUrl = vi.fn((relativePath: string) => `joy-asset://library/${relativePath}`);
    const result = await resolveAssetThumb({
      asset: { ...IMAGE, relativePath: '' },
      derivatives: [],
      projectId: 'prj-1',
      resolver: fakeResolver({ state: 'unavailable' }),
      originalCache: fakeOriginal(undefined),
      libraryUrl,
    });

    expect(result.source).toBe('none');
    expect(libraryUrl).not.toHaveBeenCalled();
  });

  it('falls back to OPFS original when the derivative resolver throws', async () => {
    const original = new Blob([]);
    const resolver = fakeResolver(new Error('authority revoked'));
    const result = await resolveAssetThumb({
      asset: IMAGE,
      derivatives: [DERIVATIVE],
      projectId: 'prj-1',
      resolver,
      originalCache: fakeOriginal(original),
    });
    expect(result.source).toBe('opfs');
  });
});
