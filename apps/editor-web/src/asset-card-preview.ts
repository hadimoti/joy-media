import type { BrowserAsset, BrowserDerivative } from './control-plane-client.js';
import type { AuthorizedDerivativeResolver, PlayableAssetDescriptor } from './asset-resolver.js';
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

export function playableAssetDescriptorFromBrowserAsset(
  asset:
    | {
        readonly id: string;
        readonly kind: 'video' | 'audio' | 'image' | 'other';
        readonly sha256?: unknown;
        readonly bytes?: unknown;
        readonly descriptor?: { readonly mimeType?: unknown };
      }
    | undefined,
): PlayableAssetDescriptor | undefined {
  if (asset === undefined || asset.kind === 'other') return undefined;
  const mimeType = asset.descriptor?.mimeType;
  if (
    typeof asset.sha256 !== 'string' ||
    typeof asset.bytes !== 'number' ||
    typeof mimeType !== 'string'
  )
    return undefined;
  return {
    assetId: asset.id,
    kind: asset.kind,
    sha256: asset.sha256,
    byteLength: asset.bytes,
    mimeType,
  };
}

/**
 * Resolve a card preview URL:
 * preferredDerivative → OPFS original → shared cloud original (images) → none.
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
        mimeType: local.type || asset.descriptor.mimeType,
        source: 'opfs',
        revoke: () => URL.revokeObjectURL(url),
        hasOpfsOriginal,
      };
    }
  } catch {
    /* fall through */
  }

  if (asset.kind === 'image') {
    try {
      const cloud = await fetchCloudOriginal(asset.id);
      const url = URL.createObjectURL(cloud);
      return {
        url,
        mimeType: cloud.type || asset.descriptor.mimeType,
        source: 'cloud',
        revoke: () => URL.revokeObjectURL(url),
        hasOpfsOriginal,
      };
    } catch {
      /* fall through */
    }
  }

  return { source: 'none', revoke: () => undefined, hasOpfsOriginal };
}
