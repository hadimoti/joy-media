/** @joy-media/collaboration-core — immutable libraries and asynchronous proxy review (P09.2). */

export type TeamLibraryAssetKind = 'brand' | 'asset';
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

/**
 * Team-only state is outside the creative document. All inputs and outputs are
 * cloned, so a library/review/version record cannot mutate a source project.
 */
export class TeamCollaborationStore {
  readonly #assets = new Map<string, TeamLibraryAsset>();
  readonly #versions = new Map<string, ProjectVersion>();
  readonly #branches = new Map<string, ProjectBranch>();
  readonly #reviews = new Map<string, ProxyReview>();

  publishAsset(asset: TeamLibraryAsset): TeamLibraryAsset | undefined {
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

  createVersion(version: ProjectVersion): ProjectVersion | undefined {
    if (this.#versions.has(version.id)) return undefined;
    if (version.parentId !== undefined && !this.#versions.has(version.parentId)) return undefined;
    const stored = clone(version);
    this.#versions.set(version.id, stored);
    return clone(stored);
  }

  createBranch(branch: ProjectBranch): ProjectBranch | undefined {
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

  addReview(review: Omit<ProxyReview, 'status' | 'decisionBy'>): ProxyReview | undefined {
    if (
      this.#reviews.has(review.id) ||
      !this.#versions.has(review.projectVersionId) ||
      !Number.isSafeInteger(review.timeUs) ||
      review.timeUs < 0
    ) {
      return undefined;
    }
    const stored: ProxyReview = { ...clone(review), status: 'open' };
    this.#reviews.set(stored.id, stored);
    return clone(stored);
  }

  decideReview(
    reviewId: string,
    decisionBy: string,
    status: 'approved' | 'changes-requested',
  ): ProxyReview | undefined {
    const current = this.#reviews.get(reviewId);
    if (current?.status !== 'open') return undefined;
    const next: ProxyReview = { ...current, status, decisionBy };
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
