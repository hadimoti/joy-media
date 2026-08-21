import type {
  DerivativeCacheResult,
  LocalDerivativeCache,
  PlayableDerivativeDescriptor,
} from './opfs-asset-cache.js';
import type {
  OpfsOriginalAssetCache,
  OriginalAssetDescriptor,
  OriginalAssetCacheResult,
} from './opfs-original-asset-cache.js';

export interface AuthorizedDerivativeRequest {
  readonly projectId: string;
  readonly assetId: string;
  readonly derivative: PlayableDerivativeDescriptor;
}

export interface AuthorizedOriginalRequest {
  readonly projectId: string;
  readonly assetId: string;
}

export interface AuthorizedOriginalTransport {
  fetch(request: AuthorizedOriginalRequest): Promise<Blob>;
}

export interface PlayableAssetDescriptor {
  readonly assetId: string;
  readonly kind: 'video' | 'audio' | 'image';
  readonly sha256: string;
  readonly byteLength: number;
  readonly mimeType: string;
}

export interface PlayableAssetDerivativeRequest extends PlayableDerivativeDescriptor {
  readonly kind: 'thumbnail' | 'proxy';
  readonly availability: 'pending' | 'available-local' | 'available-cloud' | 'evicted' | 'invalid';
}

export interface PlayableAssetRequest {
  readonly projectId: string;
  readonly asset: PlayableAssetDescriptor;
  readonly derivative?: PlayableAssetDerivativeRequest;
}

export type PlayableAssetResolution =
  | {
      readonly state: 'ready';
      readonly source: 'opfs-original' | 'authorized-private' | 'derivative' | 'fixture';
      readonly url: string;
      readonly mimeType: string;
      readonly release: () => void;
    }
  | { readonly state: 'pending' }
  | { readonly state: 'unavailable' }
  | { readonly state: 'revoked' };

/**
 * A private-store adapter returns bytes through an owner-authorized request.
 * Deliberately no URL is exposed here: public, arbitrary, or cross-origin URLs
 * cannot become an editor media source by accident.
 */
export interface AuthorizedDerivativeTransport {
  fetch(request: AuthorizedDerivativeRequest): Promise<Blob>;
}

export type AuthorizedDerivativeResolution =
  DerivativeCacheResult | { readonly state: 'unavailable' } | { readonly state: 'revoked' };

/** OPFS-first resolver. Remote bytes are integrity-checked before caching or playback. */
export class AuthorizedDerivativeResolver {
  constructor(
    private readonly cache: LocalDerivativeCache,
    private readonly transport: AuthorizedDerivativeTransport,
  ) {}

  async resolve(request: AuthorizedDerivativeRequest): Promise<AuthorizedDerivativeResolution> {
    validateRequest(request);
    const local = await this.cache.resolve(request.derivative);
    if (
      local.state === 'available-local' ||
      local.state === 'invalid' ||
      local.state === 'unsupported'
    )
      return local;
    try {
      const data = await this.transport.fetch(request);
      await this.cache.put(request.derivative, data);
    } catch (error) {
      if (isRevoked(error)) return { state: 'revoked' };
      return { state: 'unavailable' };
    }
    return this.cache.resolve(request.derivative);
  }

  removeLocal(derivativeId: string): Promise<void> {
    return this.cache.remove(derivativeId);
  }
}

/** Resolves playback-ready media without exposing worker paths or private URLs. */
export class PlayableAssetResolver {
  constructor(
    private readonly originalCache: OpfsOriginalAssetCache,
    private readonly derivatives: Pick<AuthorizedDerivativeResolver, 'resolve'>,
    private readonly originals?: AuthorizedOriginalTransport,
  ) {}

  async resolve(request: PlayableAssetRequest): Promise<PlayableAssetResolution> {
    validatePlayableRequest(request);
    const localOriginal = await this.originalCache.resolve(originalDescriptor(request.asset));
    if (localOriginal.state === 'available-local') {
      return readyFromOriginal(localOriginal, request.asset.mimeType, 'opfs-original');
    }

    const proxyPending =
      request.derivative?.kind === 'proxy' && request.derivative.availability === 'pending';

    if (
      request.derivative !== undefined &&
      request.derivative.availability !== 'pending' &&
      request.derivative.availability !== 'invalid'
    ) {
      const derivative = await this.derivatives.resolve({
        projectId: request.projectId,
        assetId: request.asset.assetId,
        derivative: request.derivative,
      });
      if (derivative.state === 'available-local') {
        return {
          state: 'ready',
          source: 'derivative',
          url: derivative.url,
          mimeType: request.derivative.mimeType,
          release: derivative.revoke,
        };
      }
      if (derivative.state === 'revoked') return derivative;
    }

    if (this.originals !== undefined) {
      try {
        const data = await this.originals.fetch({
          projectId: request.projectId,
          assetId: request.asset.assetId,
        });
        await this.originalCache.put(originalDescriptor(request.asset), data);
      } catch (error) {
        if (isRevoked(error)) return { state: 'revoked' };
        return proxyPending ? { state: 'pending' } : { state: 'unavailable' };
      }
      const verifiedOriginal = await this.originalCache.resolve(originalDescriptor(request.asset));
      if (verifiedOriginal.state === 'available-local') {
        return readyFromOriginal(verifiedOriginal, request.asset.mimeType, 'authorized-private');
      }
    }

    if (proxyPending) return { state: 'pending' };
    return { state: 'unavailable' };
  }
}

function validateRequest(request: AuthorizedDerivativeRequest): void {
  if (!isOpaqueId(request.projectId) || !isOpaqueId(request.assetId))
    throw new TypeError('project and asset ids must be opaque');
}

function validatePlayableRequest(request: PlayableAssetRequest): void {
  if (!isOpaqueId(request.projectId) || !isOpaqueId(request.asset.assetId))
    throw new TypeError('project and asset ids must be opaque');
  if (!/^[a-f0-9]{64}$/.test(request.asset.sha256))
    throw new TypeError('asset sha256 must be valid');
  if (!Number.isSafeInteger(request.asset.byteLength) || request.asset.byteLength < 0)
    throw new TypeError('asset byte length must be valid');
  if (!/^[a-z]+\/[a-z0-9.+-]+$/i.test(request.asset.mimeType))
    throw new TypeError('asset mime type must be valid');
}

function isOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isRevoked(error: unknown): boolean {
  return error instanceof DerivativeAuthorityRevokedError;
}

function originalDescriptor(asset: PlayableAssetDescriptor): OriginalAssetDescriptor {
  return {
    assetId: asset.assetId,
    sha256: asset.sha256,
    bytes: asset.byteLength,
    mimeType: asset.mimeType,
  };
}

function readyFromOriginal(
  result: Extract<OriginalAssetCacheResult, { readonly state: 'available-local' }>,
  mimeType: string,
  source: 'opfs-original' | 'authorized-private',
): PlayableAssetResolution {
  return {
    state: 'ready',
    source,
    url: result.url,
    mimeType,
    release: result.revoke,
  };
}

/** Provider adapters use this only for a verified owner/revocation denial. */
export class DerivativeAuthorityRevokedError extends Error {
  constructor() {
    super('derivative authority was revoked');
    this.name = 'DerivativeAuthorityRevokedError';
  }
}
