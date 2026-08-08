/**
 * Specialist agents: scoped analysis that proposes, and cannot apply.
 *
 * §8.2 of the unified data plan rules out the obvious shape — an agent per node,
 * each with its own session and its own write access. The failure mode it names
 * is specialists racing to mutate the project, and the fix it prescribes is one
 * orchestrator, scoped invocations, least privilege, and a single transaction
 * authority.
 *
 * That is enforced here by type, not by convention: a `SpecialistContext` has
 * no dispatch, no commit, and no registry — there is nothing on it a specialist
 * could call to change the project even if it tried. A specialist returns a
 * proposal; only `commitCombinedChangeSet` writes, and it is the one function
 * in this module that takes a commit callback.
 *
 * Analysis runs concurrently because it is read-only. Writing is serialized and
 * revision-checked, which is exactly the asymmetry §8.2 asks for.
 */

import type { JoyProjectV1, SpikeProject, CreativeCapability } from '@joy-media/project-schema';
import type { CostEstimate } from './types.js';
import type { AuditTrail } from './audit.js';
import type { AgentActor, AgentCommandEnvelope, ProjectRevisionId } from './envelope.js';
import { createEnvelope, checkBaseRevision } from './envelope.js';

/** The slice of the project a specialist may look at. */
export interface SpecialistScope {
  readonly compositionId: string;
  /** Empty means the whole composition. */
  readonly clipIds: readonly string[];
  readonly startUs?: number;
  readonly durationUs?: number;
}

/**
 * Everything a specialist gets. Deliberately read-only and deliberately
 * without a dispatcher: the absence is the mechanism.
 *
 * Project content reaching a specialist — scripts, captions, filenames — is
 * untrusted data (§14.1). Nothing here grants the authority to act on
 * instructions found inside it.
 */
export interface SpecialistContext {
  readonly timeline: SpikeProject;
  readonly creative: JoyProjectV1;
  readonly scope: SpecialistScope;
}

export type ProposalDomain = 'timeline' | 'parameters';

export interface ProposedEdit {
  /** Clip, object, or document id. Used to detect two specialists colliding. */
  readonly targetId: string;
  readonly summary: string;
  readonly domain: ProposalDomain;
  /** Parameter change sets stay editable rather than being flattened (§5.1). */
  readonly parameters?: Readonly<Record<string, string | number | boolean>>;
}

export interface ChangeSetProposal {
  readonly roleId: string;
  readonly capability: string;
  readonly title: string;
  /** What the specialist observed. Evidence, never chain-of-thought (§8.4). */
  readonly findings: readonly string[];
  readonly edits: readonly ProposedEdit[];
  readonly estimatedCost: CostEstimate;
  readonly warnings: readonly string[];
}

export interface SpecialistDefinition {
  readonly roleId: string;
  /** Bound by capability, not vendor (§8.3). */
  readonly capability: string;
  readonly label: string;
  readonly requiredCapabilities: readonly CreativeCapability[];
  analyse(context: SpecialistContext): ChangeSetProposal | Promise<ChangeSetProposal>;
}

export interface SpecialistBudget {
  readonly maxSpecialists: number;
  readonly maxEditsPerSpecialist: number;
}

export const DEFAULT_SPECIALIST_BUDGET: SpecialistBudget = {
  maxSpecialists: 8,
  maxEditsPerSpecialist: 50,
};

export interface SpecialistRunOptions {
  /** Capabilities the run is permitted to use. Least privilege by default. */
  readonly allowedCapabilities: readonly CreativeCapability[];
  readonly budget?: SpecialistBudget;
  readonly audit?: AuditTrail;
  readonly planId?: string;
}

export interface DeniedSpecialist {
  readonly roleId: string;
  readonly reason: string;
}

export interface FailedSpecialist {
  readonly roleId: string;
  readonly error: string;
}

export interface SpecialistRunResult {
  readonly proposals: readonly ChangeSetProposal[];
  readonly denied: readonly DeniedSpecialist[];
  readonly failed: readonly FailedSpecialist[];
}

/**
 * Runs every permitted specialist concurrently.
 *
 * Permission is checked before anything runs, so a specialist that wants
 * authority the run does not have never sees the project at all — denying it
 * after the fact would already have handed it the content.
 */
export async function runSpecialists(
  specialists: readonly SpecialistDefinition[],
  context: SpecialistContext,
  options: SpecialistRunOptions,
): Promise<SpecialistRunResult> {
  const budget = options.budget ?? DEFAULT_SPECIALIST_BUDGET;
  const allowed = new Set(options.allowedCapabilities);
  const denied: DeniedSpecialist[] = [];
  const permitted: SpecialistDefinition[] = [];

  for (const specialist of specialists) {
    const missing = specialist.requiredCapabilities.filter(
      (capability) => !allowed.has(capability),
    );
    if (missing.length > 0) {
      denied.push({
        roleId: specialist.roleId,
        reason: `not permitted: ${missing.join(', ')}`,
      });
      continue;
    }
    if (permitted.length >= budget.maxSpecialists) {
      denied.push({
        roleId: specialist.roleId,
        reason: `budget allows at most ${budget.maxSpecialists} specialists per run`,
      });
      continue;
    }
    permitted.push(specialist);
  }

  const settled = await Promise.allSettled(
    // Each gets the same immutable context; none can observe another's result,
    // which is what keeps a parallel run from becoming an implicit pipeline.
    permitted.map(async (specialist) => ({
      specialist,
      proposal: await specialist.analyse(context),
    })),
  );

  const proposals: ChangeSetProposal[] = [];
  const failed: FailedSpecialist[] = [];

  settled.forEach((outcome, index) => {
    const specialist = permitted[index]!;
    if (outcome.status === 'rejected') {
      // One specialist failing must not lose the others' work.
      failed.push({
        roleId: specialist.roleId,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
      return;
    }
    const proposal = outcome.value.proposal;
    if (proposal.edits.length > budget.maxEditsPerSpecialist) {
      failed.push({
        roleId: specialist.roleId,
        error: `proposed ${proposal.edits.length} edits, over the budget of ${budget.maxEditsPerSpecialist}`,
      });
      return;
    }
    proposals.push(proposal);
    options.audit?.record({
      planId: options.planId ?? 'specialist-run',
      action: 'plan-created',
      userId: specialist.roleId,
      metadata: { title: proposal.title, editCount: proposal.edits.length },
    });
  });

  return { proposals, denied, failed };
}

export interface ProposalConflict {
  readonly targetId: string;
  readonly domain: ProposalDomain;
  readonly roleIds: readonly string[];
  readonly summaries: readonly string[];
}

export interface CombinedChangeSet {
  readonly proposals: readonly ChangeSetProposal[];
  readonly edits: readonly ProposedEdit[];
  /** Two specialists touching one target. Surfaced, never silently merged. */
  readonly conflicts: readonly ProposalConflict[];
  readonly ok: boolean;
}

/**
 * Merges proposals into one change set, refusing when two specialists disagree
 * about the same target.
 *
 * Last-write-wins would be the easy choice and the wrong one: the whole point
 * of specialists analysing in parallel is that the human sees a combined result
 * they can trust, and silently discarding one specialist's edit produces a
 * result nobody proposed.
 *
 * A conflict is a target *and a domain*. Where a clip sits in the timeline and
 * how loud it plays are different properties on different buses — two
 * specialists proposing one each cannot overwrite one another, and treating
 * that as a conflict would make every run with a pacing specialist unresolvable
 * on every clip the audio specialist also touched.
 */
export function combineProposals(proposals: readonly ChangeSetProposal[]): CombinedChangeSet {
  const byTarget = new Map<
    string,
    { targetId: string; domain: ProposalDomain; roles: Set<string>; summaries: string[] }
  >();
  for (const proposal of proposals) {
    for (const edit of proposal.edits) {
      const key = `${edit.domain}:${edit.targetId}`;
      const entry = byTarget.get(key) ?? {
        targetId: edit.targetId,
        domain: edit.domain,
        roles: new Set<string>(),
        summaries: [],
      };
      entry.roles.add(proposal.roleId);
      entry.summaries.push(`${proposal.roleId}: ${edit.summary}`);
      byTarget.set(key, entry);
    }
  }

  const conflicts: ProposalConflict[] = [];
  for (const entry of byTarget.values()) {
    if (entry.roles.size > 1) {
      conflicts.push({
        targetId: entry.targetId,
        domain: entry.domain,
        roleIds: [...entry.roles],
        summaries: entry.summaries,
      });
    }
  }

  return {
    proposals,
    edits: proposals.flatMap((proposal) => proposal.edits),
    conflicts,
    ok: conflicts.length === 0 && proposals.length > 0,
  };
}

export interface CombinedApprovalGrant {
  readonly approvedRoleIds: readonly string[];
  readonly approvedAt: string;
}

export interface CommitCombinedOptions<TTransaction> {
  readonly actor: AgentActor;
  readonly projectId: string;
  readonly baseRevision: ProjectRevisionId;
  readonly currentRevision: () => ProjectRevisionId;
  /** Created by the trusted UI only after the user approves this change set. */
  readonly approval: CombinedApprovalGrant;
  /** Turns the approved change set into exactly one transaction. */
  readonly build: (combined: CombinedChangeSet) => TTransaction;
  /** The single project transaction authority (§8.2). */
  readonly commit: (transaction: TTransaction) => {
    readonly success: boolean;
    readonly error?: string;
  };
  readonly audit?: AuditTrail;
  readonly planId?: string;
}

export interface CommitCombinedResult {
  readonly committed: boolean;
  readonly envelopes: readonly AgentCommandEnvelope[];
  readonly errors: readonly string[];
}

/**
 * Commits an approved combined change set as one transaction.
 *
 * The only writer in this module. It refuses a change set with conflicts, one
 * the user has not approved in full, and one built against a revision the
 * project has moved past — the last check happening immediately before the
 * write so the window is as small as a single-threaded client allows.
 */
export function commitCombinedChangeSet<TTransaction>(
  combined: CombinedChangeSet,
  options: CommitCombinedOptions<TTransaction>,
): CommitCombinedResult {
  const errors: string[] = [];
  if (!combined.ok) {
    errors.push(
      combined.conflicts.length > 0
        ? `change set has ${combined.conflicts.length} unresolved conflict(s)`
        : 'change set proposes nothing',
    );
  }

  // Approving "the review" must not silently include a specialist whose result
  // the user never saw, so every role that actually contributes an edit has to
  // be in the grant. A specialist that proposed nothing is excluded: requiring
  // approval for a result that changes nothing would block a legitimate apply.
  const approved = new Set(options.approval.approvedRoleIds);
  const unapproved = combined.proposals
    .filter((proposal) => proposal.edits.length > 0)
    .map((proposal) => proposal.roleId)
    .filter((roleId) => !approved.has(roleId));
  if (unapproved.length > 0) {
    errors.push(`not approved: ${unapproved.join(', ')}`);
  }

  if (errors.length > 0) {
    options.audit?.record({
      planId: options.planId ?? 'specialist-run',
      action: 'execution-failed',
      userId: options.actor.id,
      error: errors.join('; '),
    });
    return { committed: false, envelopes: [], errors };
  }

  checkBaseRevision(options.baseRevision, options.currentRevision());

  const transactionId = `tx-specialists-${Date.now()}`;
  const envelopes = combined.proposals.flatMap((proposal, proposalIndex) =>
    proposal.edits.map((edit, editIndex) =>
      createEnvelope({
        projectId: options.projectId,
        baseRevision: options.baseRevision,
        transactionId,
        idempotencyKey: `${proposal.roleId}:${edit.targetId}:${proposalIndex}:${editIndex}`,
        actor: { type: 'agent', id: proposal.roleId },
        type: `specialist.${proposal.capability}`,
        params: edit,
      }),
    ),
  );

  const result = options.commit(options.build(combined));
  options.audit?.record({
    planId: options.planId ?? 'specialist-run',
    action: result.success ? 'execution-completed' : 'execution-failed',
    userId: options.actor.id,
    ...(result.success ? {} : { error: result.error ?? 'commit failed' }),
    metadata: {
      transactionId,
      editCount: combined.edits.length,
      roleIds: combined.proposals.map((proposal) => proposal.roleId),
    },
  });

  return {
    committed: result.success,
    envelopes,
    errors: result.success ? [] : [result.error ?? 'commit failed'],
  };
}
