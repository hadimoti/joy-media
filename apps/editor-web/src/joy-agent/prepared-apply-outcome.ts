import type { EditorSession } from '../editor-session.js';
import type { ExecutionReceipt } from '../execution-receipt.js';
import type { JoyCodeCompoundApplyResult } from '../joy-code-compound-runner.js';
import type {
  PreparedChangeApprovalHandle,
  PreparedChangeAuthority,
  PreparedChangeStore,
  PreparedChangeView,
} from './prepared-change-store.js';

/** The narrow runner surface the UI needs to finalize one approved preview. */
export interface JoyCodeCompoundApplier {
  apply(
    session: EditorSession,
    preparedChanges: PreparedChangeStore,
    approval: PreparedChangeApprovalHandle,
    authority: PreparedChangeAuthority,
  ): JoyCodeCompoundApplyResult;
}

/**
 * A terminal response can be lost after a compound journal has committed.
 * The receipt is the durable authority in that case, not the transport error.
 */
export interface PreparedJoyCodeApplyOutcome {
  readonly result: JoyCodeCompoundApplyResult;
  /** True only when an exact, durable receipt recovered an interrupted response. */
  readonly recoveredFromReceipt: boolean;
}

/**
 * Applies one approved prepared change, treating an exact durable receipt as
 * success if the caller loses the post-commit response or is cancelled.
 *
 * This intentionally recovers neither a stale/mismatched receipt nor an
 * ambiguous execution ID. Those remain hard errors so a UI error never hides
 * a different edit.
 */
export function applyPreparedJoyCodeChange({
  session,
  preparedChanges,
  prepared,
  authority,
  runner,
}: {
  readonly session: EditorSession;
  readonly preparedChanges: PreparedChangeStore;
  readonly prepared: PreparedChangeView;
  readonly authority: PreparedChangeAuthority;
  readonly runner: JoyCodeCompoundApplier;
}): PreparedJoyCodeApplyOutcome {
  try {
    const approval = preparedChanges.approve(prepared.changeSetId, authority);
    const result = runner.apply(session, preparedChanges, approval, authority);
    assertDurableResult(session, prepared, result);
    return { result, recoveredFromReceipt: false };
  } catch (error) {
    const receipt = getDurableReceiptForPreparedChange(session, prepared);
    if (receipt === undefined) throw error;
    return {
      result: {
        applied: false,
        replayed: true,
        revisionId: receipt.resultRevision,
        receipt,
      },
      recoveredFromReceipt: true,
    };
  }
}

/** Returns only the exact receipt bound to this prepared change and live project. */
export function getDurableReceiptForPreparedChange(
  session: Pick<EditorSession, 'timelineProject' | 'agentIdempotency'>,
  prepared: Pick<
    PreparedChangeView,
    'executionId' | 'operationDigest' | 'projectId' | 'baseRevision'
  >,
): ExecutionReceipt | undefined {
  if (session.agentIdempotency.getExecutionReceiptConflict(prepared.executionId) !== undefined)
    return undefined;
  const receipt = session.agentIdempotency.getExecutionReceipt(prepared.executionId);
  if (
    receipt === undefined ||
    receipt.executionId !== prepared.executionId ||
    receipt.operationDigest !== prepared.operationDigest ||
    receipt.projectId !== prepared.projectId ||
    receipt.projectId !== session.timelineProject.id ||
    receipt.baseRevision !== prepared.baseRevision
  )
    return undefined;
  return receipt;
}

function assertDurableResult(
  session: EditorSession,
  prepared: PreparedChangeView,
  result: JoyCodeCompoundApplyResult,
): void {
  const receipt = getDurableReceiptForPreparedChange(session, prepared);
  if (
    receipt === undefined ||
    result.receipt.executionId !== receipt.executionId ||
    result.receipt.operationDigest !== receipt.operationDigest ||
    result.receipt.resultRevision !== receipt.resultRevision
  )
    throw new Error(
      'JOY_CODE_VERIFICATION_FAILED: durable execution receipt could not be read back',
    );
  if (!result.replayed && session.projectRevisionId !== receipt.resultRevision)
    throw new Error('JOY_CODE_VERIFICATION_FAILED: committed revision could not be read back');
}
