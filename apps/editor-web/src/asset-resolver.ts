import type {
  DerivativeCacheResult,
  LocalDerivativeCache,
  PlayableDerivativeDescriptor,
} from './opfs-asset-cache.js';

export interface AuthorizedDerivativeRequest {
  readonly projectId: string;
  readonly assetId: string;
  readonly derivative: PlayableDerivativeDescriptor;
}

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

function validateRequest(request: AuthorizedDerivativeRequest): void {
  if (!isOpaqueId(request.projectId) || !isOpaqueId(request.assetId))
    throw new TypeError('project and asset ids must be opaque');
}

function isOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isRevoked(error: unknown): boolean {
  return error instanceof DerivativeAuthorityRevokedError;
}

/** Provider adapters use this only for a verified owner/revocation denial. */
export class DerivativeAuthorityRevokedError extends Error {
  constructor() {
    super('derivative authority was revoked');
    this.name = 'DerivativeAuthorityRevokedError';
  }
}
