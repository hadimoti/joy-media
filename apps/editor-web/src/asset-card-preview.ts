import type { BrowserAsset, BrowserDerivative } from './control-plane-client.js';
import type { AuthorizedDerivativeResolver } from './asset-resolver.js';
import type { OpfsOriginalAssetCache } from './opfs-original-asset-cache.js';
import { preferredDerivative } from './asset-library-state.js';
import { revokeDetachedObjectUrl } from './media-object-url.js';

export type AssetThumbSource = 'derivative' | 'opfs' | 'none';

export interface AssetThumbResult {
  readonly url?: string;
  readonly mimeType?: string;
  readonly source: AssetThumbSource;
  readonly revoke: () => void;
}

/**
 * Storage gateways can return an otherwise valid original as
 * `application/octet-stream`. Preserve a verified media descriptor in that
 * case so cards render the correct element (not a checkerboard fallback).
 */
function previewMimeType(asset: BrowserAsset, blob: Blob): string {
  const blobType = blob.type.trim().toLowerCase();
  const expectedPrefix = `${asset.kind}/`;
  return blobType.startsWith(expectedPrefix) ? blobType : asset.descriptor.mimeType;
}

/**
 * Resolve a card preview URL from local data:
 * preferredDerivative -> OPFS original -> none.
 */
export async function resolveAssetThumb(options: {
  readonly asset: BrowserAsset;
  readonly derivatives: readonly BrowserDerivative[];
  readonly projectId: string;
  readonly resolver: AuthorizedDerivativeResolver;
  readonly originalCache: OpfsOriginalAssetCache;
}): Promise<AssetThumbResult> {
  const { asset, derivatives, projectId, resolver, originalCache } = options;

  const derivative = preferredDerivative(derivatives);
  if (derivative !== undefined) {
    try {
      const outcome = await resolver.resolve({
        projectId: asset.projectId || projectId,
        assetId: asset.id,
        derivative: {
          derivativeId: derivative.id,
          sha256: derivative.sha256,
          byteLength: derivative.bytes,
          mimeType: derivative.descriptor.mimeType,
        },
      });
      if (outcome.state === 'available-local') {
        return {
          url: outcome.url,
          mimeType: derivative.descriptor.mimeType,
          source: 'derivative',
          revoke: outcome.revoke,
        };
      }
    } catch {
      /* fall through */
    }
  }

  try {
    const local = await originalCache.get(asset.id);
    if (local !== undefined) {
      const url = URL.createObjectURL(local);
      return {
        url,
        mimeType: previewMimeType(asset, local),
        source: 'opfs',
        revoke: () => revokeDetachedObjectUrl(url),
      };
    }
  } catch {
    /* fall through */
  }

  return { source: 'none', revoke: () => undefined };
}
