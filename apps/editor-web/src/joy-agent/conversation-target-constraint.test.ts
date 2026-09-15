import { describe, expect, it } from 'vitest';
import type { JoyCodePlanOperationV1 } from '@joy-media/agent-tools';
import {
  constrainJoyAgentConversationTarget,
  JOY_AGENT_CONVERSATION_TARGET_MISMATCH,
} from './conversation-target-constraint.js';
import type { JoyAgentConversationEntityReference } from './conversation-entity-references.js';

const reference: JoyAgentConversationEntityReference = {
  version: 1,
  projectId: 'timeline-project-1',
  executionId: 'execution-1',
  resultRevision: 'revision-1',
  entityId: 'created-title',
  entityKind: 'visual-text',
  label: 'Text layer',
};

function operation(value: JoyCodePlanOperationV1): JoyCodePlanOperationV1 {
  return value;
}

describe('JOY Agent conversation target constraint', () => {
  it('allows text and motion operations that directly name the resolved entity', () => {
    expect(
      constrainJoyAgentConversationTarget(reference, [
        operation({
          id: 'rewrite-title',
          dependsOn: [],
          kind: 'text.setContent',
          objectId: 'created-title',
          content: 'JOY',
        }),
        operation({
          id: 'shrink-title',
          dependsOn: [],
          kind: 'motion.setKeyframe',
          binding: {
            ownerKind: 'visual-object',
            ownerId: 'created-title',
            propertyId: 'scaleX',
            timeDomain: 'composition',
          },
          key: { kind: 'scalar', timeUs: 0, value: 0.8, interpolation: 'linear' },
        }),
      ]),
    ).toEqual({ ok: true });
  });

  it('rejects a valid operation that targets a different existing object', () => {
    expect(
      constrainJoyAgentConversationTarget(reference, [
        operation({
          id: 'wrong-title',
          dependsOn: [],
          kind: 'motion.setKeyframe',
          binding: {
            ownerKind: 'visual-object',
            ownerId: 'another-existing-title',
            propertyId: 'scaleX',
            timeDomain: 'composition',
          },
          key: { kind: 'scalar', timeUs: 0, value: 0.8, interpolation: 'linear' },
        }),
      ]),
    ).toEqual({
      ok: false,
      code: JOY_AGENT_CONVERSATION_TARGET_MISMATCH,
      operationId: 'wrong-title',
    });
  });

  it('rejects a global or create-only operation for an exact prior-entity request', () => {
    expect(
      constrainJoyAgentConversationTarget(reference, [
        operation({
          id: 'global-caption-change',
          dependsOn: [],
          kind: 'caption.setBurnIn',
          enabled: true,
        }),
      ]),
    ).toMatchObject({
      ok: false,
      code: JOY_AGENT_CONVERSATION_TARGET_MISMATCH,
    });
  });
});
