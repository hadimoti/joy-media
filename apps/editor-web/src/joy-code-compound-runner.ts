import type { EditorSession } from './editor-session.js';
import { applyTransaction } from '@joy-media/commands';
import { canonicalJson } from '@joy-media/workflow-engine';
import { assertModelApplyPolicy } from './agent-policy-settings.js';
import { ExecutionReceiptConflictError } from './agent-idempotency-store.js';
import type { ExecutionReceipt } from './execution-receipt.js';
import {
  assertTimelineMoveProjectReadback,
  assertTimelineTrimProjectReadback,
} from './joy-agent/timeline-edit-readback.js';
import { assertTimelineSplitProjectReadback } from './joy-agent/timeline-split-readback.js';
import { assertCreatedTitleOpacityKeyframeProjectReadback } from './joy-agent/title-keyframe-readback.js';
import {
  assertAddedTransitionProjectReadback,
  assertRemovedTransitionProjectReadback,
} from './joy-agent/transition-add-readback.js';
import type {
  PreparedChangeStore,
  ApprovedPreparedChange,
  PreparedChangeApprovalHandle,
  PreparedChangeAuthority,
} from './joy-agent/prepared-change-store.js';

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
    preparedChanges: PreparedChangeStore,
    approval: PreparedChangeApprovalHandle,
    authority: PreparedChangeAuthority,
  ): JoyCodeCompoundApplyResult {
    // The store is the only place that can turn an opaque approval handle
    // back into a compiler payload. React state, a preview clone, and the
    // model's proposal are deliberately not executable authority.
    const view = preparedChanges.getApprovedView(approval, authority);
    if (authority.sessionIdentity !== session)
      throw new Error(
        'JOY_CODE_PREPARED_CHANGE_STALE_SESSION: authority belongs to a different editor session',
      );
    if (view.hostRunId !== authority.hostRunId)
      throw new Error(
        'JOY_CODE_PREPARED_CHANGE_STALE_RUN: authority belongs to a different host run',
      );
    if (view.projectId !== authority.projectId || view.projectId !== session.timelineProject.id)
      throw new Error(
        `JOY_CODE_PREPARED_CHANGE_STALE_SESSION: expected ${view.projectId}, got ${session.timelineProject.id}`,
      );

    const conflict = session.agentIdempotency.getExecutionReceiptConflict(view.executionId);
    if (conflict !== undefined)
      throw new Error(
        `JOY_CODE_EXECUTION_CONFLICT: execution ${view.executionId} has ${conflict.length} durable receipt candidates`,
      );
    const existing = session.agentIdempotency.getExecutionReceipt(view.executionId);
    if (existing !== undefined) {
      if (
        existing.operationDigest !== view.operationDigest ||
        existing.projectId !== view.projectId ||
        existing.baseRevision !== view.baseRevision
      )
        throw new Error(
          `JOY_CODE_EXECUTION_CONFLICT: execution ${view.executionId} is bound to different durable authority`,
        );
      // A receipt is already a completed, durable result. Replaying it is a
      // read-only answer, so it remains valid even after the edit advanced the
      // live revision (or after an undo). A new write below is still strictly
      // revision-bound.
      return {
        applied: false,
        replayed: true,
        revisionId: existing.resultRevision,
        receipt: existing,
      };
    }
    assertModelApplyPolicy(authority.policy);
    const prepared = preparedChanges.resolveApproved(approval, authority);
    assertPreparedPayload(prepared);
    if (prepared.view.bindingDigest !== view.bindingDigest)
      throw new Error('JOY_CODE_PREPARED_CHANGE_CORRUPT: approval resolved a different change set');
    const { draft } = prepared;
    if (session.projectRevisionId !== view.baseRevision)
      throw new Error(
        `JOY_CODE_STALE_REVISION: expected ${view.baseRevision}, got ${session.projectRevisionId}`,
      );
    const document = draft.documentChanged ? draft.document : undefined;
    // The Look Instances write (R2 / GAP 1b) rides the same compound. It is
    // bound into `operationDigest` and `bindingDigest`, so an approval covers it
    // exactly as it covers the keyframes.
    const lookInstances = draft.lookInstances;
    // Calculate expected state before the one-way commit. Re-applying a
    // transaction after commit could double-apply split/remove/insert actions.
    const timelineBefore = session.timelineProject;
    const documentBefore = session.visualProject;
    const expectedTimeline =
      draft.timeline === undefined
        ? undefined
        : applyTransaction(timelineBefore, draft.timeline).project;
    let receipt: ExecutionReceipt;
    try {
      receipt = session.commitAgentCompound(
        `Joy Code plan ${view.planId}`,
        {
          ...(draft.timeline === undefined ? {} : { timeline: draft.timeline }),
          ...(document === undefined ? {} : { document }),
          ...(lookInstances === undefined ? {} : { lookInstances }),
        },
        {
          executionId: view.executionId,
          operationDigest: view.operationDigest,
          baseRevision: view.baseRevision,
          changedEntityIds: view.groups.flatMap((group) => group.affectedIds),
        },
      );
    } catch (error) {
      if (error instanceof ExecutionReceiptConflictError)
        throw new Error(
          `JOY_CODE_EXECUTION_CONFLICT: execution ${error.executionId} has conflicting durable receipt authority`,
        );
      throw error;
    }
    assertCommittedPreparedPayload(
      session,
      receipt,
      view.executionId,
      document,
      expectedTimeline,
      lookInstances,
    );
    // First operation-specific F5 readback slice. This remains intentionally
    // narrow: a mixed transaction can alter a split half later in the same
    // compound edit, so it needs ordered per-operation observation rather than
    // a misleading final-state comparison.
    if (
      draft.timeline?.commands.length === 1 &&
      draft.timeline.commands[0]?.type === 'timeline.splitClip'
    )
      assertTimelineSplitProjectReadback(
        timelineBefore,
        session.timelineProject,
        draft.timeline.commands[0],
      );
    if (
      draft.timeline?.commands.length === 2 &&
      draft.timeline.commands[0]?.type === 'timeline.trimClipStart' &&
      draft.timeline.commands[1]?.type === 'timeline.trimClipEnd'
    )
      assertTimelineTrimProjectReadback(
        timelineBefore,
        session.timelineProject,
        draft.timeline.commands,
      );
    if (
      draft.timeline?.commands.length === 1 &&
      draft.timeline.commands[0]?.type === 'timeline.moveClip'
    )
      assertTimelineMoveProjectReadback(
        timelineBefore,
        session.timelineProject,
        draft.timeline.commands[0],
      );
    assertCreatedTitleOpacityKeyframeProjectReadback(documentBefore, session.visualProject, draft);
    assertAddedTransitionProjectReadback(documentBefore, session.visualProject, draft);
    assertRemovedTransitionProjectReadback(documentBefore, session.visualProject, draft);
    return {
      applied: true,
      replayed: false,
      revisionId: receipt.resultRevision,
      receipt,
    };
  }
}

function assertCommittedPreparedPayload(
  session: EditorSession,
  receipt: ExecutionReceipt,
  executionId: string,
  expectedDocument: ApprovedPreparedChange['draft']['document'] | undefined,
  expectedTimeline: ReturnType<typeof applyTransaction>['project'] | undefined,
  expectedLookInstances: ApprovedPreparedChange['draft']['lookInstances'] | undefined,
): void {
  if (session.projectRevisionId !== receipt.resultRevision)
    throw new Error('JOY_CODE_VERIFICATION_FAILED: committed revision could not be read back');
  if (
    session.agentIdempotency.getExecutionReceipt(executionId)?.operationDigest !==
    receipt.operationDigest
  )
    throw new Error(
      'JOY_CODE_VERIFICATION_FAILED: durable execution receipt could not be read back',
    );
  if (
    expectedDocument !== undefined &&
    canonicalJson(expectedDocument) !== canonicalJson(session.visualProject)
  )
    throw new Error('JOY_CODE_VERIFICATION_FAILED: document state differs from approved payload');
  if (
    expectedTimeline !== undefined &&
    canonicalJson(expectedTimeline) !== canonicalJson(session.timelineProject)
  )
    throw new Error('JOY_CODE_VERIFICATION_FAILED: timeline state differs from approved payload');
  if (
    expectedLookInstances !== undefined &&
    canonicalJson(expectedLookInstances) !== canonicalJson(session.lookInstances)
  )
    throw new Error(
      'JOY_CODE_VERIFICATION_FAILED: look instances state differs from approved payload',
    );
}

function assertPreparedPayload(prepared: ApprovedPreparedChange): void {
  const { view, draft } = prepared;
  if (
    draft.planId !== view.planId ||
    draft.baseRevision !== view.baseRevision ||
    draft.operationDigest !== view.operationDigest ||
    draft.proposalHash !== `joy-code-proposal-${view.operationDigest}` ||
    draft.requiresManualApproval !== true ||
    typeof draft.documentChanged !== 'boolean'
  )
    throw new Error(
      'JOY_CODE_PREPARED_CHANGE_CORRUPT: prepared payload no longer matches its binding',
    );
  if (
    view.externalEffects.length !== 0 ||
    view.consentScopes.length !== 1 ||
    view.consentScopes[0] !== 'local-project-write'
  )
    throw new Error('JOY_CODE_PREPARED_CHANGE_CORRUPT: local runner received unsupported effects');
}
