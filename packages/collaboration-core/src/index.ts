/** @joy-media/collaboration-core — immutable libraries and asynchronous proxy review (P09.2). */

export type {
  CollaborationRevision,
  RevisionHistoryAuditRecord,
  RevisionHistoryAuthorization,
  RevisionHistoryPermission,
  RevisionHistorySnapshot,
  RevisionProposal,
} from './revision-history.js';
export { RevisionHistory, StaticRevisionHistoryAuthorization } from './revision-history.js';

export type TeamLibraryAssetKind = 'brand' | 'asset';
export type TeamCollaborationPermission =
  'library.publish' | 'version.create' | 'branch.create' | 'review.create' | 'review.decide';
export interface TeamCollaborationAuthorization {
  allows(actorId: string, permission: TeamCollaborationPermission): boolean;
}
export class StaticTeamCollaborationAuthorization implements TeamCollaborationAuthorization {
  constructor(
    private readonly grants: Readonly<Record<string, readonly TeamCollaborationPermission[]>>,
  ) {}
  allows(actorId: string, permission: TeamCollaborationPermission): boolean {
    return this.grants[actorId]?.includes(permission) === true;
  }
}
export interface TeamLibraryAsset {
  readonly id: string;
  readonly version: string;
  readonly kind: TeamLibraryAssetKind;
  readonly displayName: string;
  readonly metadata: unknown;
}

export interface ProjectVersion {
  readonly id: string;
  readonly parentId?: string;
  readonly snapshot: unknown;
}

export interface ProjectBranch {
  readonly id: string;
  readonly baseVersionId: string;
  readonly snapshot: unknown;
}

export interface ProxyReview {
  readonly id: string;
  readonly projectVersionId: string;
  readonly proxyAssetId: string;
  readonly timeUs: number;
  readonly authorId: string;
  readonly comment: string;
  readonly status: 'open' | 'approved' | 'changes-requested';
  readonly decisionBy?: string;
}

export interface ProjectVersionComparison {
  readonly leftVersionId: string;
  readonly rightVersionId: string;
  readonly changedPaths: readonly string[];
  readonly equal: boolean;
}
export interface CollaborationAuditRecord {
  readonly actorId: string;
  readonly action: TeamCollaborationPermission;
  readonly targetId: string;
  readonly allowed: boolean;
}
export interface TeamCollaborationSnapshot {
  readonly assets: readonly TeamLibraryAsset[];
  readonly versions: readonly ProjectVersion[];
  readonly branches: readonly ProjectBranch[];
  readonly reviews: readonly ProxyReview[];
  readonly audit: readonly CollaborationAuditRecord[];
}

/**
 * Team-only state is outside the creative document. All inputs and outputs are
 * cloned, so a library/review/version record cannot mutate a source project.
 */
export class TeamCollaborationStore {
  readonly #assets = new Map<string, TeamLibraryAsset>();
  readonly #versions = new Map<string, ProjectVersion>();
  readonly #branches = new Map<string, ProjectBranch>();
  readonly #reviews = new Map<string, ProxyReview>();
  readonly #audit: CollaborationAuditRecord[] = [];

  constructor(
    private readonly authorization: TeamCollaborationAuthorization,
    snapshot?: TeamCollaborationSnapshot,
  ) {
    for (const asset of snapshot?.assets ?? [])
      this.#assets.set(assetKey(asset.id, asset.version), clone(asset));
    for (const version of snapshot?.versions ?? []) this.#versions.set(version.id, clone(version));
    for (const branch of snapshot?.branches ?? []) this.#branches.set(branch.id, clone(branch));
    for (const review of snapshot?.reviews ?? []) this.#reviews.set(review.id, clone(review));
    this.#audit.push(...(snapshot?.audit ?? []).map(clone));
  }

  publishAsset(actorId: string, asset: TeamLibraryAsset): TeamLibraryAsset | undefined {
    if (!this.authorize(actorId, 'library.publish', asset.id)) return undefined;
    const key = assetKey(asset.id, asset.version);
    if (this.#assets.has(key)) return undefined;
    const stored = clone(asset);
    this.#assets.set(key, stored);
    return clone(stored);
  }

  listAssets(kind?: TeamLibraryAssetKind): readonly TeamLibraryAsset[] {
    return [...this.#assets.values()]
      .filter((asset) => kind === undefined || asset.kind === kind)
      .map(clone);
  }

  createVersion(actorId: string, version: ProjectVersion): ProjectVersion | undefined {
    if (!this.authorize(actorId, 'version.create', version.id)) return undefined;
    if (this.#versions.has(version.id)) return undefined;
    if (version.parentId !== undefined && !this.#versions.has(version.parentId)) return undefined;
    const stored = clone(version);
    this.#versions.set(version.id, stored);
    return clone(stored);
  }

  createBranch(actorId: string, branch: ProjectBranch): ProjectBranch | undefined {
    if (!this.authorize(actorId, 'branch.create', branch.id)) return undefined;
    if (this.#branches.has(branch.id) || !this.#versions.has(branch.baseVersionId))
      return undefined;
    const stored = clone(branch);
    this.#branches.set(branch.id, stored);
    return clone(stored);
  }

  compareVersions(
    leftVersionId: string,
    rightVersionId: string,
  ): ProjectVersionComparison | undefined {
    const left = this.#versions.get(leftVersionId);
    const right = this.#versions.get(rightVersionId);
    if (left === undefined || right === undefined) return undefined;
    const changedPaths = diffPaths(left.snapshot, right.snapshot);
    return { leftVersionId, rightVersionId, changedPaths, equal: changedPaths.length === 0 };
  }

  addReview(
    actorId: string,
    review: Omit<ProxyReview, 'status' | 'decisionBy' | 'authorId'>,
  ): ProxyReview | undefined {
    if (!this.authorize(actorId, 'review.create', review.id)) return undefined;
    if (
      this.#reviews.has(review.id) ||
      !this.#versions.has(review.projectVersionId) ||
      !Number.isSafeInteger(review.timeUs) ||
      review.timeUs < 0
    ) {
      return undefined;
    }
    const stored: ProxyReview = { ...clone(review), authorId: actorId, status: 'open' };
    this.#reviews.set(stored.id, stored);
    return clone(stored);
  }

  decideReview(
    actorId: string,
    reviewId: string,
    status: 'approved' | 'changes-requested',
  ): ProxyReview | undefined {
    if (!this.authorize(actorId, 'review.decide', reviewId)) return undefined;
    const current = this.#reviews.get(reviewId);
    if (current?.status !== 'open') return undefined;
    const next: ProxyReview = { ...current, status, decisionBy: actorId };
    this.#reviews.set(reviewId, next);
    return clone(next);
  }

  listReviews(projectVersionId?: string): readonly ProxyReview[] {
    return [...this.#reviews.values()]
      .filter(
        (review) => projectVersionId === undefined || review.projectVersionId === projectVersionId,
      )
      .map(clone);
  }
  audit(): readonly CollaborationAuditRecord[] {
    return this.#audit.map(clone);
  }
  snapshot(): TeamCollaborationSnapshot {
    return {
      assets: [...this.#assets.values()].map(clone),
      versions: [...this.#versions.values()].map(clone),
      branches: [...this.#branches.values()].map(clone),
      reviews: [...this.#reviews.values()].map(clone),
      audit: this.audit(),
    };
  }
  private authorize(
    actorId: string,
    action: TeamCollaborationPermission,
    targetId: string,
  ): boolean {
    const allowed = this.authorization.allows(actorId, action);
    this.#audit.push({ actorId, action, targetId, allowed });
    return allowed;
  }
}

function assetKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function diffPaths(left: unknown, right: unknown, path = ''): string[] {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const paths: string[] = [];
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1)
      paths.push(...diffPaths(left[index], right[index], `${path}/${index}`));
    return paths;
  }
  if (isRecord(left) && isRecord(right)) {
    const paths: string[] = [];
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      paths.push(...diffPaths(left[key], right[key], `${path}/${escapePath(key)}`));
    }
    return paths;
  }
  return [path || '/'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapePath(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
