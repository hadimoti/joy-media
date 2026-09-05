import type { EditorSession } from './editor-session.js';
import type { JoyCodeCompoundDraft } from './joy-code-compound-compiler.js';
import {
  assertModelApplyPolicy,
  DEFAULT_AGENT_POLICY,
  type AgentPolicyPreferences,
} from './agent-policy-settings.js';

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
      readonly receiptPersisted: boolean;
    }
  | {
      readonly applied: false;
      readonly replayed: true;
      readonly revisionId: string;
      readonly receiptPersisted: boolean;
    };

export class JoyCodeCompoundRunner {
  readonly #applied = new Set<string>();
  readonly #volatileReceipts = new Set<string>();

  apply(
    session: EditorSession,
    draft: JoyCodeCompoundDraft,
    approval: JoyCodeCompoundApproval,
    policy: AgentPolicyPreferences = DEFAULT_AGENT_POLICY,
  ): JoyCodeCompoundApplyResult {
    assertModelApplyPolicy(policy);
    const replayKey = `${draft.planId}:${draft.proposalHash}`;
    if (
      approval.planId !== draft.planId ||
      approval.proposalHash !== draft.proposalHash ||
      approval.baseRevision !== draft.baseRevision
    )
      throw new Error(
        'JOY_CODE_APPROVAL_MISMATCH: approval is not bound to this plan, proposal, and base revision',
      );
    if (this.#applied.has(replayKey) || session.agentIdempotency.hasExecuted(replayKey))
      return {
        applied: false,
        replayed: true,
        revisionId: readReceiptRevision(session, replayKey) ?? draft.baseRevision,
        receiptPersisted:
          readReceiptPersistence(session, replayKey) && !this.#volatileReceipts.has(replayKey),
      };
    if (session.projectRevisionId !== draft.baseRevision)
      throw new Error(
        `JOY_CODE_STALE_REVISION: expected ${draft.baseRevision}, got ${session.projectRevisionId}`,
      );
    const document = draft.document === session.visualProject ? undefined : draft.document;
    session.dispatchCompound(`Joy Code plan ${draft.planId}`, {
      ...(draft.timeline === undefined ? {} : { timeline: draft.timeline }),
      ...(document === undefined ? {} : { document }),
    });
    this.#applied.add(replayKey);
    let receiptPersisted = true;
    try {
      session.agentIdempotency.recordExecution(replayKey, draft.planId, '__transaction__', {
        success: true,
        data: { revisionId: session.projectRevisionId },
      });
    } catch {
      // The document commit already succeeded. Keep this run replay-safe in
      // memory and surface the persistence warning instead of reporting a
      // false apply failure after the editor has changed.
      receiptPersisted = false;
      this.#volatileReceipts.add(replayKey);
      // Preserve the uncertainty on the store record as well. A new runner
      // sharing this session must not turn a receipt-write warning into a
      // falsely confident replay result.
      try {
        session.agentIdempotency.recordExecution(replayKey, draft.planId, '__transaction__', {
          success: true,
          data: { revisionId: session.projectRevisionId, receiptPersisted: false },
        });
      } catch {
        // The backing store is unavailable; the in-memory runner guard above
        // still prevents a retry in this runner instance.
      }
    }
    return {
      applied: true,
      replayed: false,
      revisionId: session.projectRevisionId,
      receiptPersisted,
    };
  }
}

function readReceiptPersistence(session: EditorSession, replayKey: string): boolean {
  const data = session.agentIdempotency.getRecord(replayKey)?.result?.data;
  if (data !== null && typeof data === 'object' && !Array.isArray(data))
    return !('receiptPersisted' in data) || data.receiptPersisted !== false;
  return true;
}

function readReceiptRevision(session: EditorSession, replayKey: string): string | undefined {
  const data = session.agentIdempotency.getRecord(replayKey)?.result?.data;
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const revisionId = 'revisionId' in data ? data.revisionId : undefined;
    return typeof revisionId === 'string' ? revisionId : undefined;
  }
  return undefined;
}
