/** Immutable, fast-forward-only collaboration history (ADR-0012, P09.3). */

export interface CollaborationRevision {
  readonly id: string;
  readonly projectId: string;
  readonly parentId?: string;
  readonly actorId: string;
  readonly snapshot: unknown;
}
export type RevisionHistoryPermission =
  'revision.root.create' | 'revision.propose' | 'revision.accept' | 'revision.reject';
export interface RevisionHistoryAuthorization {
  allows(actorId: string, permission: RevisionHistoryPermission, projectId: string): boolean;
}
export class StaticRevisionHistoryAuthorization implements RevisionHistoryAuthorization {
  constructor(
    private readonly grants: Readonly<Record<string, readonly RevisionHistoryPermission[]>>,
  ) {}
  allows(actorId: string, permission: RevisionHistoryPermission): boolean {
    return this.grants[actorId]?.includes(permission) === true;
  }
}

export interface RevisionProposal extends CollaborationRevision {
  readonly baseRevisionId?: string;
  readonly status: 'pending' | 'accepted' | 'conflicted' | 'rejected';
}
export interface RevisionHistoryAuditRecord {
  readonly actorId: string;
  readonly action: RevisionHistoryPermission;
  readonly projectId: string;
  readonly proposalId?: string;
  readonly allowed: boolean;
}
export interface RevisionHistorySnapshot {
  readonly heads: Readonly<Record<string, string>>;
  readonly revisions: readonly CollaborationRevision[];
  readonly proposals: readonly RevisionProposal[];
  readonly audit: readonly RevisionHistoryAuditRecord[];
}

/**
 * Projects are fast-forward-only. A stale proposal stays inspectable but can
 * never overwrite the current head; callers compare it and submit a rebase.
 */
export class RevisionHistory {
  readonly #heads = new Map<string, string>();
  readonly #revisions = new Map<string, CollaborationRevision>();
  readonly #proposals = new Map<string, RevisionProposal>();
  readonly #audit: RevisionHistoryAuditRecord[] = [];
  constructor(
    private readonly authorization: RevisionHistoryAuthorization,
    snapshot?: RevisionHistorySnapshot,
  ) {
    for (const revision of snapshot?.revisions ?? [])
      this.#revisions.set(revision.id, clone(revision));
    for (const proposal of snapshot?.proposals ?? [])
      this.#proposals.set(proposal.id, clone(proposal));
    for (const [projectId, revisionId] of Object.entries(snapshot?.heads ?? {}))
      this.#heads.set(projectId, revisionId);
    this.#audit.push(...(snapshot?.audit ?? []).map(clone));
  }

  createRoot(revision: Omit<CollaborationRevision, 'parentId'>): CollaborationRevision | undefined {
    if (!this.authorize(revision.actorId, 'revision.root.create', revision.projectId))
      return undefined;
    if (this.#heads.has(revision.projectId) || this.#revisions.has(revision.id)) return undefined;
    const stored = clone(revision);
    this.#revisions.set(stored.id, stored);
    this.#heads.set(stored.projectId, stored.id);
    return clone(stored);
  }

  propose(
    proposal: Omit<RevisionProposal, 'status' | 'parentId'> & { readonly baseRevisionId?: string },
  ): RevisionProposal | undefined {
    if (!this.authorize(proposal.actorId, 'revision.propose', proposal.projectId, proposal.id))
      return undefined;
    if (this.#proposals.has(proposal.id) || this.#revisions.has(proposal.id)) return undefined;
    if (this.#heads.get(proposal.projectId) !== proposal.baseRevisionId) return undefined;
    const stored: RevisionProposal = { ...clone(proposal), status: 'pending' };
    this.#proposals.set(stored.id, stored);
    return clone(stored);
  }

  accept(actorId: string, proposalId: string): RevisionProposal | undefined {
    const proposal = this.#proposals.get(proposalId);
    if (
      proposal === undefined ||
      !this.authorize(actorId, 'revision.accept', proposal.projectId, proposalId)
    )
      return undefined;
    if (proposal.status !== 'pending') return undefined;
    if (this.#heads.get(proposal.projectId) !== proposal.baseRevisionId) {
      const conflicted: RevisionProposal = { ...proposal, status: 'conflicted' };
      this.#proposals.set(proposalId, conflicted);
      return clone(conflicted);
    }
    const accepted: RevisionProposal = { ...proposal, status: 'accepted' };
    const revision: CollaborationRevision = {
      id: proposal.id,
      projectId: proposal.projectId,
      actorId: proposal.actorId,
      snapshot: clone(proposal.snapshot),
      ...(proposal.baseRevisionId === undefined ? {} : { parentId: proposal.baseRevisionId }),
    };
    this.#proposals.set(proposalId, accepted);
    this.#revisions.set(revision.id, revision);
    this.#heads.set(revision.projectId, revision.id);
    return clone(accepted);
  }

  reject(actorId: string, proposalId: string): RevisionProposal | undefined {
    const proposal = this.#proposals.get(proposalId);
    if (
      proposal === undefined ||
      !this.authorize(actorId, 'revision.reject', proposal.projectId, proposalId)
    )
      return undefined;
    if (proposal.status !== 'pending') return undefined;
    const rejected: RevisionProposal = { ...proposal, status: 'rejected' };
    this.#proposals.set(proposalId, rejected);
    return clone(rejected);
  }

  head(projectId: string): CollaborationRevision | undefined {
    const id = this.#heads.get(projectId);
    return id === undefined ? undefined : clone(this.#revisions.get(id)!);
  }

  revision(id: string): CollaborationRevision | undefined {
    const revision = this.#revisions.get(id);
    return revision === undefined ? undefined : clone(revision);
  }
  audit(): readonly RevisionHistoryAuditRecord[] {
    return this.#audit.map(clone);
  }
  snapshot(): RevisionHistorySnapshot {
    return {
      heads: Object.fromEntries(this.#heads.entries()),
      revisions: [...this.#revisions.values()].map(clone),
      proposals: [...this.#proposals.values()].map(clone),
      audit: this.audit(),
    };
  }
  private authorize(
    actorId: string,
    action: RevisionHistoryPermission,
    projectId: string,
    proposalId?: string,
  ): boolean {
    const allowed = this.authorization.allows(actorId, action, projectId);
    this.#audit.push({
      actorId,
      action,
      projectId,
      ...(proposalId === undefined ? {} : { proposalId }),
      allowed,
    });
    return allowed;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
