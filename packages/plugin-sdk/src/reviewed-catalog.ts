/** Reviewed catalog foundation: verified publishers, immutable releases, revocation (§25.6, P09.1). */
import { verifyPluginPackage } from './security.js';
import type { PluginPackageV1, PluginTrustStore } from './security.js';

export interface CatalogPublisher {
  readonly id: string;
  readonly displayName: string;
  readonly verified: boolean;
  /** Trusted package-signing keys owned by this publisher. */
  readonly signingKeyIds: readonly string[];
}
export type CatalogReleaseState = 'pending' | 'approved' | 'rejected' | 'revoked' | 'quarantined';
export interface ReviewedRelease {
  readonly publisherId: string;
  readonly pluginId: string;
  readonly version: string;
  readonly packageSha256: string;
  readonly compatibility: string;
  readonly permissions: readonly string[];
  readonly state: CatalogReleaseState;
  readonly reviewerId?: string;
  readonly reason?: string;
}

export class ReviewedCatalog {
  readonly #publishers = new Map<string, CatalogPublisher>();
  readonly #releases = new Map<string, ReviewedRelease>();
  constructor(private readonly trust: PluginTrustStore) {}
  registerPublisher(publisher: CatalogPublisher): void {
    this.#publishers.set(publisher.id, publisher);
  }
  submit(publisherId: string, pluginPackage: PluginPackageV1): ReviewedRelease | undefined {
    const publisher = this.#publishers.get(publisherId);
    if (publisher?.verified !== true) return undefined;
    if (!publisher.signingKeyIds.includes(pluginPackage.signature.keyId)) return undefined;
    const verified = verifyPluginPackage(pluginPackage, this.trust);
    if (!verified.verified || verified.manifest === undefined) return undefined;
    const key = `${publisherId}:${verified.manifest.id}@${verified.manifest.version}`;
    if (this.#releases.has(key)) return undefined;
    const release: ReviewedRelease = {
      publisherId,
      pluginId: verified.manifest.id,
      version: verified.manifest.version,
      packageSha256: verified.packageSha256,
      compatibility: verified.manifest.joyApi,
      permissions: verified.manifest.permissions,
      state: 'pending',
    };
    this.#releases.set(key, release);
    return release;
  }
  review(
    publisherId: string,
    pluginId: string,
    version: string,
    reviewerId: string,
    approved: boolean,
    reason?: string,
  ): ReviewedRelease | undefined {
    const key = `${publisherId}:${pluginId}@${version}`;
    const prior = this.#releases.get(key);
    if (prior?.state !== 'pending') return undefined;
    const next: ReviewedRelease = {
      ...prior,
      state: approved ? 'approved' : 'rejected',
      reviewerId,
      ...(reason === undefined ? {} : { reason }),
    };
    this.#releases.set(key, next);
    return next;
  }
  revoke(
    publisherId: string,
    pluginId: string,
    version: string,
    reason: string,
    quarantine = false,
  ): ReviewedRelease | undefined {
    const key = `${publisherId}:${pluginId}@${version}`;
    const prior = this.#releases.get(key);
    if (prior === undefined) return undefined;
    const next: ReviewedRelease = {
      ...prior,
      state: quarantine ? 'quarantined' : 'revoked',
      reason,
    };
    this.#releases.set(key, next);
    return next;
  }
  list(visibleOnly = false): readonly ReviewedRelease[] {
    const releases = [...this.#releases.values()];
    return visibleOnly ? releases.filter((release) => release.state === 'approved') : releases;
  }
}
