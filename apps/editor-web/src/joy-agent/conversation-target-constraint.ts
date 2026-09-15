import type { JoyCodePlanOperationV1 } from '@joy-media/agent-tools';
import type { JoyAgentConversationEntityReference } from './conversation-entity-references.js';

export const JOY_AGENT_CONVERSATION_TARGET_MISMATCH =
  'JOY_AGENT_CONVERSATION_TARGET_MISMATCH' as const;

export interface JoyAgentConversationTargetConstraintFailure {
  readonly ok: false;
  readonly code: typeof JOY_AGENT_CONVERSATION_TARGET_MISMATCH;
  readonly operationId: string;
}

export type JoyAgentConversationTargetConstraint =
  { readonly ok: true } | JoyAgentConversationTargetConstraintFailure;

/**
 * A pronoun-style follow-up has one host-resolved entity. Model context is
 * advisory, so bind the resulting proposal at the host boundary as well. Each
 * current operation must directly name that entity; no generic/global action
 * can piggyback on a request such as “make that title smaller”.
 */
export function constrainJoyAgentConversationTarget(
  reference: JoyAgentConversationEntityReference,
  operations: readonly JoyCodePlanOperationV1[],
): JoyAgentConversationTargetConstraint {
  for (const operation of operations) {
    const targets = directTargetsForOperation(operation);
    if (!targets.includes(reference.entityId))
      return Object.freeze({
        ok: false as const,
        code: JOY_AGENT_CONVERSATION_TARGET_MISMATCH,
        operationId: operation.id,
      });
  }
  return Object.freeze({ ok: true as const });
}

function directTargetsForOperation(operation: JoyCodePlanOperationV1): readonly string[] {
  switch (operation.kind) {
    case 'timeline.trimClip':
    case 'timeline.splitClip':
    case 'timeline.moveClip':
    case 'timeline.removeClip':
      return [operation.clipId];
    case 'timeline.insertExistingAsset':
      return [operation.assetId];
    case 'text.setContent':
    case 'text.setTemplate':
      return [operation.objectId];
    case 'motion.setKeyframe':
    case 'motion.removeKeyframe':
      return operation.binding.ownerId === undefined ? [] : [operation.binding.ownerId];
    case 'caption.setSegmentText':
    case 'caption.setSegmentTiming':
    case 'caption.setTemplate':
      return [operation.captionClipId];
    case 'transition.addAtJunction':
      return [operation.outgoingClipId, operation.incomingClipId];
    case 'transition.remove':
      return [operation.transitionId];
    // Existing title/object target constraints must not be broadened by a
    // global caption setting or by creating a different text object.
    case 'caption.setBurnIn':
    case 'text.insertTemplate':
      return [];
  }
}
