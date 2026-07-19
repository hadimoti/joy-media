/** @joy-media/media-core — local-first asset identity and opaque locations (WP-00.6). */
export const PACKAGE_NAME = '@joy-media/media-core' as const;

export type { AssetAvailability, MediaDescriptor, ProbeInput, ProxyProfile } from './pipeline.js';
export { derivativeCacheKey, normalizeProbe, relinkExactHash } from './pipeline.js';

export type {
  AssetKind,
  DerivativeKind,
  AssetLocation,
  AssetDerivative,
  AssetRecord,
  LocalFileSelection,
  LocalDerivativeRequest,
  LocalDerivativeOutput,
  LocalDerivativeExecutor,
} from './assets.js';
export { AssetBridgeError, LocalAssetBridge } from './assets.js';
