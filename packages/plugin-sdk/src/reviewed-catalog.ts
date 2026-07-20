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
export type CatalogPermission =
  'publisher.register' | 'release.submit' | 'release.review' | 'release.revoke';
export interface CatalogAuthorization {
  allows(actorId: string, permission: CatalogPermission, publisherId: string): boolean;
}
export class StaticCatalogAuthorization implements CatalogAuthorization {
  constructor(private readonly grants: Readonly<Record<string, readonly CatalogPermission[]>>) {}
  allows(actorId: string, permission: CatalogPermission): boolean {
    return this.grants[actorId]?.includes(permission) === true;
  }
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
export interface CatalogAuditRecord {
  readonly actorId: string;
  readonly action: CatalogPermission;
  readonly publisherId: string;
  readonly pluginId?: string;
  readonly version?: string;
  readonly allowed: boolean;
}
export interface ReviewedCatalogSnapshot {
  readonly publishers: readonly CatalogPublisher[];
  readonly releases: readonly ReviewedRelease[];
  readonly audit: readonly CatalogAuditRecord[];
}

export class ReviewedCatalog {
  readonly #publishers = new Map<string, CatalogPublisher>();
  readonly #releases = new Map<string, ReviewedRelease>();
  readonly #audit: CatalogAuditRecord[] = [];
  constructor(
    private readonly trust: PluginTrustStore,
    private readonly authorization: CatalogAuthorization,
    snapshot?: ReviewedCatalogSnapshot,
  ) {
    for (const publisher of snapshot?.publishers ?? [])
      this.#publishers.set(publisher.id, clone(publisher));
    for (const release of snapshot?.releases ?? [])
      this.#releases.set(releaseKey(release), clone(release));
    this.#audit.push(...(snapshot?.audit ?? []).map(clone));
  }
  registerPublisher(actorId: string, publisher: CatalogPublisher): boolean {
    if (!this.authorize(actorId, 'publisher.register', publisher.id)) return false;
    if (this.#publishers.has(publisher.id)) return false;
    this.#publishers.set(publisher.id, publisher);
    return true;
  }
  submit(
    actorId: string,
    publisherId: string,
    pluginPackage: PluginPackageV1,
  ): ReviewedRelease | undefined {
    if (!this.authorize(actorId, 'release.submit', publisherId)) return undefined;
    const publisher = this.#publishers.get(publisherId);
    if (publisher?.verified !== true) return undefined;
    if (!publisher.signingKeyIds.includes(pluginPackage.signature.keyId)) return undefined;
    const verified = verifyPluginPackage(pluginPackage, this.trust);
    if (!verified.verified || verified.manifest === undefined) return undefined;
    const key = releaseKey({
      publisherId,
      pluginId: verified.manifest.id,
      version: verified.manifest.version,
    });
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
    actorId: string,
    publisherId: string,
    pluginId: string,
    version: string,
    approved: boolean,
    reason?: string,
  ): ReviewedRelease | undefined {
    if (!this.authorize(actorId, 'release.review', publisherId, pluginId, version))
      return undefined;
    const key = releaseKey({ publisherId, pluginId, version });
    const prior = this.#releases.get(key);
    if (prior?.state !== 'pending') return undefined;
    const next: ReviewedRelease = {
      ...prior,
      state: approved ? 'approved' : 'rejected',
      reviewerId: actorId,
      ...(reason === undefined ? {} : { reason }),
    };
    this.#releases.set(key, next);
    return next;
  }
  revoke(
    actorId: string,
    publisherId: string,
    pluginId: string,
    version: string,
    reason: string,
    quarantine = false,
  ): ReviewedRelease | undefined {
    if (!this.authorize(actorId, 'release.revoke', publisherId, pluginId, version))
      return undefined;
    const key = releaseKey({ publisherId, pluginId, version });
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
  audit(): readonly CatalogAuditRecord[] {
    return this.#audit.map(clone);
  }
  snapshot(): ReviewedCatalogSnapshot {
    return {
      publishers: [...this.#publishers.values()].map(clone),
      releases: [...this.#releases.values()].map(clone),
      audit: this.audit(),
    };
  }
  private authorize(
    actorId: string,
    action: CatalogPermission,
    publisherId: string,
    pluginId?: string,
    version?: string,
  ): boolean {
    const allowed = this.authorization.allows(actorId, action, publisherId);
    this.#audit.push({
      actorId,
      action,
      publisherId,
      ...(pluginId === undefined ? {} : { pluginId }),
      ...(version === undefined ? {} : { version }),
      allowed,
    });
    return allowed;
  }
}

function releaseKey(value: Pick<ReviewedRelease, 'publisherId' | 'pluginId' | 'version'>): string {
  return `${value.publisherId}:${value.pluginId}@${value.version}`;
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
