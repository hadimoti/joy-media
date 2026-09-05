import type { EditorSession } from './editor-session.js';
import type { JoyCodeCompoundDraft } from './joy-code-compound-compiler.js';
import {
  assertModelApplyPolicy,
  DEFAULT_AGENT_POLICY,
  type AgentPolicyPreferences,
} from './agent-policy-settings.js';
import { ExecutionReceiptConflictError } from './agent-idempotency-store.js';
import type { ExecutionReceipt } from './execution-receipt.js';

export interface JoyCodeCompoundApproval {
  readonly planId: string;
  readonly proposalHash: string;
  readonly baseRevision: string;
  readonly approvedAt: string;
}

export type JoyCodeCompoundApplyResult =
  | {
      readonly applied: true;
      readonly replayed: false;
      readonly revisionId: string;
      readonly receipt: ExecutionReceipt;
    }
  | {
      readonly applied: false;
      readonly replayed: true;
      readonly revisionId: string;
      readonly receipt: ExecutionReceipt;
    };

export class JoyCodeCompoundRunner {
  apply(
    session: EditorSession,
    draft: JoyCodeCompoundDraft,
    approval: JoyCodeCompoundApproval,
    policy: AgentPolicyPreferences = DEFAULT_AGENT_POLICY,
  ): JoyCodeCompoundApplyResult {
    assertModelApplyPolicy(policy);
    if (
      approval.planId !== draft.planId ||
      approval.proposalHash !== draft.proposalHash ||
      approval.baseRevision !== draft.baseRevision
    )
      throw new Error(
        'JOY_CODE_APPROVAL_MISMATCH: approval is not bound to this plan, proposal, and base revision',
      );
    const conflict = session.agentIdempotency.getExecutionReceiptConflict(draft.planId);
    if (conflict !== undefined)
      throw new Error(
        `JOY_CODE_EXECUTION_CONFLICT: execution ${draft.planId} has ${conflict.length} durable receipt candidates`,
      );
    const existing = session.agentIdempotency.getExecutionReceipt(draft.planId);
    if (existing !== undefined) {
      if (existing.operationDigest !== draft.operationDigest)
        throw new Error(
          `JOY_CODE_EXECUTION_CONFLICT: execution ${draft.planId} is bound to a different operation digest`,
        );
      return {
        applied: false,
        replayed: true,
        revisionId: existing.resultRevision,
        receipt: existing,
      };
    }
    if (session.projectRevisionId !== draft.baseRevision)
      throw new Error(
        `JOY_CODE_STALE_REVISION: expected ${draft.baseRevision}, got ${session.projectRevisionId}`,
      );
    const document = draft.document === session.visualProject ? undefined : draft.document;
    let receipt: ExecutionReceipt;
    try {
      receipt = session.commitAgentCompound(
        `Joy Code plan ${draft.planId}`,
        {
          ...(draft.timeline === undefined ? {} : { timeline: draft.timeline }),
          ...(document === undefined ? {} : { document }),
        },
        {
          executionId: draft.planId,
          operationDigest: draft.operationDigest,
          baseRevision: draft.baseRevision,
          changedEntityIds: draft.groups.flatMap((group) => group.affectedIds),
        },
      );
    } catch (error) {
      if (error instanceof ExecutionReceiptConflictError)
        throw new Error(
          `JOY_CODE_EXECUTION_CONFLICT: execution ${error.executionId} has conflicting durable receipt authority`,
        );
      throw error;
    }
    return {
      applied: true,
      replayed: false,
      revisionId: receipt.resultRevision,
      receipt,
    };
  }
}
