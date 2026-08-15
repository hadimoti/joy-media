import type { BrowserAsset, BrowserDerivative } from './control-plane-client.js';
import type { AuthorizedDerivativeResolver } from './asset-resolver.js';
import type { OpfsOriginalAssetCache } from './opfs-original-asset-cache.js';
import { preferredDerivative } from './asset-library-state.js';

export type AssetThumbSource = 'derivative' | 'opfs' | 'cloud' | 'none';

export interface AssetThumbResult {
  readonly url?: string;
  readonly mimeType?: string;
  readonly source: AssetThumbSource;
  readonly revoke: () => void;
  /** True when OPFS has original bytes (used for Backup to cloud affordance). */
  readonly hasOpfsOriginal: boolean;
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
 * Resolve a card preview URL:
 * preferredDerivative -> OPFS original -> authorized cloud original -> none.
 * A non-cloud-backed catalog record has no authorized remote original yet;
 * never probe the shared-library endpoint for it. Besides avoiding a needless
 * 409, this keeps other in-progress owner imports quiet in every open tab.
 */
export async function resolveAssetThumb(options: {
  readonly asset: BrowserAsset;
  readonly derivatives: readonly BrowserDerivative[];
  readonly projectId: string;
  readonly resolver: AuthorizedDerivativeResolver;
  readonly originalCache: OpfsOriginalAssetCache;
  readonly fetchCloudOriginal: (assetId: string) => Promise<Blob>;
}): Promise<AssetThumbResult> {
  const { asset, derivatives, projectId, resolver, originalCache, fetchCloudOriginal } = options;
  let hasOpfsOriginal = false;

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
          hasOpfsOriginal,
        };
      }
    } catch {
      /* fall through */
    }
  }

  try {
    const local = await originalCache.get(asset.id);
    if (local !== undefined) {
      hasOpfsOriginal = true;
      const url = URL.createObjectURL(local);
      return {
        url,
        mimeType: previewMimeType(asset, local),
        source: 'opfs',
        revoke: () => URL.revokeObjectURL(url),
        hasOpfsOriginal,
      };
    }
  } catch {
    /* fall through */
  }

  if (!asset.cloudBacked) return { source: 'none', revoke: () => undefined, hasOpfsOriginal };

  try {
    const cloud = await fetchCloudOriginal(asset.id);
    const url = URL.createObjectURL(cloud);
    return {
      url,
      mimeType: previewMimeType(asset, cloud),
      source: 'cloud',
      revoke: () => URL.revokeObjectURL(url),
      hasOpfsOriginal,
    };
  } catch {
    /* fall through */
  }

  return { source: 'none', revoke: () => undefined, hasOpfsOriginal };
}
