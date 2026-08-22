import { describe, expect, it, vi } from 'vitest';
import { resolveAssetThumb, type AssetThumbResult } from './asset-card-preview.js';
import type { BrowserAsset, BrowserDerivative } from './control-plane-client.js';
import type { AuthorizedDerivativeResolver } from './asset-resolver.js';
import type { OpfsOriginalAssetCache } from './opfs-original-asset-cache.js';

/**
 * Regression guard for JOY-002: asset preview buttons were `disabled` for any
 * asset without a formal derivative, and `openPreview` required a derivative —
 * so cloud-only / OPFS-only images could never be previewed. `resolveAssetThumb`
 * must fall back across derivative -> OPFS original -> shared cloud original and
 * return `none` (not throw) when nothing is available.
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

const AUDIO: BrowserAsset = {
  id: 'audio-1',
  projectId: 'prj-1',
  kind: 'audio',
  displayName: 'Servo movement',
  sha256: 'c'.repeat(64),
  bytes: 2000,
  descriptor: { mimeType: 'audio/wav', durationUs: 1_250_000 },
  createdAt: 1_700_000_000_000,
};

function fakeResolver(outcome: unknown): AuthorizedDerivativeResolver {
  return { resolve: vi.fn().mockResolvedValue(outcome) } as unknown as AuthorizedDerivativeResolver;
}

function fakeOriginal(blob: Blob | undefined): OpfsOriginalAssetCache {
  return { get: vi.fn().mockResolvedValue(blob) } as unknown as OpfsOriginalAssetCache;
}

describe('resolveAssetThumb fallback chain', () => {
  it('uses the derivative when it resolves available-local', async () => {
    const resolver = fakeResolver({
      state: 'available-local',
      url: 'blob:dv',
      revoke: () => undefined,
    });
    const result: AssetThumbResult = await resolveAssetThumb({
      asset: IMAGE,
      derivatives: [DERIVATIVE],
      projectId: 'prj-1',
      resolver,
      originalCache: fakeOriginal(undefined),
      fetchCloudOriginal: vi.fn(),
    });
    expect(result.source).toBe('derivative');
    expect(result.url).toBe('blob:dv');
    expect(result.mimeType).toBe('image/png');
  });

  it('falls back to the OPFS original when there is no derivative', async () => {
    const original = new Blob([], { type: 'image/png' });
    const result = await resolveAssetThumb({
      asset: IMAGE,
      derivatives: [],
      projectId: 'prj-1',
      resolver: fakeResolver({ state: 'unavailable' }),
      originalCache: fakeOriginal(original),
      fetchCloudOriginal: vi.fn(),
    });
    expect(result.source).toBe('opfs');
    expect(result.hasOpfsOriginal).toBe(true);
  });

  it('falls back to the shared cloud original for images when nothing local exists', async () => {
    const result = await resolveAssetThumb({
      asset: IMAGE,
      derivatives: [],
      projectId: 'prj-1',
      resolver: fakeResolver({ state: 'unavailable' }),
      originalCache: fakeOriginal(undefined),
      fetchCloudOriginal: vi.fn().mockResolvedValue(new Blob([], { type: 'image/png' })),
    });
    expect(result.source).toBe('cloud');
  });

  it('falls back to the shared cloud original for audio previews', async () => {
    const result = await resolveAssetThumb({
      asset: AUDIO,
      derivatives: [],
      projectId: 'prj-1',
      resolver: fakeResolver({ state: 'unavailable' }),
      originalCache: fakeOriginal(undefined),
      fetchCloudOriginal: vi.fn().mockResolvedValue(new Blob([], { type: 'audio/wav' })),
    });
    expect(result.source).toBe('cloud');
    expect(result.mimeType).toBe('audio/wav');
  });

  it('does not enqueue cloud reads for grid cards', async () => {
    const fetchCloudOriginal = vi.fn().mockResolvedValue(new Blob([], { type: 'image/png' }));
    const result = await resolveAssetThumb({
      asset: IMAGE,
      derivatives: [],
      projectId: 'prj-1',
      resolver: fakeResolver({ state: 'unavailable' }),
      originalCache: fakeOriginal(undefined),
      fetchCloudOriginal,
      allowCloudFallback: false,
    });
    expect(result.source).toBe('none');
    expect(fetchCloudOriginal).not.toHaveBeenCalled();
  });

  it('returns none (no throw) when no source is available', async () => {
    const result = await resolveAssetThumb({
      asset: IMAGE,
      derivatives: [],
      projectId: 'prj-1',
      resolver: fakeResolver({ state: 'unavailable' }),
      originalCache: fakeOriginal(undefined),
      fetchCloudOriginal: vi.fn().mockRejectedValue(new Error('unreachable')),
    });
    expect(result.source).toBe('none');
    expect(result.url).toBeUndefined();
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
      fetchCloudOriginal: vi.fn(),
    });
    expect(result.source).toBe('opfs');
  });
});
