/** Immutable, fast-forward-only collaboration history (ADR-0012, P09.3). */

export interface CollaborationRevision {
  readonly id: string;
  readonly projectId: string;
  readonly parentId?: string;
  readonly actorId: string;
  readonly snapshot: unknown;
}

export interface RevisionProposal extends CollaborationRevision {
  readonly baseRevisionId?: string;
  readonly status: 'pending' | 'accepted' | 'conflicted' | 'rejected';
}

/**
 * Projects are fast-forward-only. A stale proposal stays inspectable but can
 * never overwrite the current head; callers compare it and submit a rebase.
 */
export class RevisionHistory {
  readonly #heads = new Map<string, string>();
  readonly #revisions = new Map<string, CollaborationRevision>();
  readonly #proposals = new Map<string, RevisionProposal>();

  createRoot(revision: Omit<CollaborationRevision, 'parentId'>): CollaborationRevision | undefined {
    if (this.#heads.has(revision.projectId) || this.#revisions.has(revision.id)) return undefined;
    const stored = clone(revision);
    this.#revisions.set(stored.id, stored);
    this.#heads.set(stored.projectId, stored.id);
    return clone(stored);
  }

  propose(
    proposal: Omit<RevisionProposal, 'status' | 'parentId'> & { readonly baseRevisionId?: string },
  ): RevisionProposal | undefined {
    if (this.#proposals.has(proposal.id) || this.#revisions.has(proposal.id)) return undefined;
    if (this.#heads.get(proposal.projectId) !== proposal.baseRevisionId) return undefined;
    const stored: RevisionProposal = { ...clone(proposal), status: 'pending' };
    this.#proposals.set(stored.id, stored);
    return clone(stored);
  }

  accept(proposalId: string): RevisionProposal | undefined {
    const proposal = this.#proposals.get(proposalId);
    if (proposal?.status !== 'pending') return undefined;
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

  reject(proposalId: string): RevisionProposal | undefined {
    const proposal = this.#proposals.get(proposalId);
    if (proposal?.status !== 'pending') return undefined;
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
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
