import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { agentIdempotencyStorageKey } from '../agent-idempotency-store.js';
import { DEFAULT_AGENT_POLICY } from '../agent-policy-settings.js';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { EditorSession } from '../editor-session.js';
import {
  compileJoyCodeCompoundDraft,
  type JoyCodeCompoundDraft,
} from '../joy-code-compound-compiler.js';
import { JoyCodeCompoundRunner } from '../joy-code-compound-runner.js';
import { PreparedChangeStore, type PreparedChangeAuthority } from './prepared-change-store.js';

function compileDraft(session: EditorSession): JoyCodeCompoundDraft {
  const result = compileJoyCodeCompoundDraft({
    planId: 'atomic-recovery-plan',
    baseRevision: session.projectRevisionId,
    timeline: session.timelineProject,
    visualProject: session.visualProject,
    registeredAssetIds: [],
    operations: [
      {
        id: 'title',
        dependsOn: [],
        kind: 'text.insertTemplate',
        templateId: 'clean-title',
        content: 'Must recover without this title',
        startUs: 0,
        durationUs: 1_000_000,
        placementPreset: 'center',
      },
    ],
  });
  if (!result.ok) throw new Error(`Fixture did not compile: ${result.error.code}`);
  return result;
}

function authorityFor(session: EditorSession): PreparedChangeAuthority {
  return {
    projectId: session.timelineProject.id,
    hostRunId: 'atomic-recovery-host-run',
    sessionIdentity: session,
    sessionEpoch: 1,
    revision: session.projectRevisionId,
    policy: DEFAULT_AGENT_POLICY,
  };
}

describe('agent compound atomic recovery', () => {
  it('requires reopen recovery when the receipt/commit-marker failure cannot roll back immediately', () => {
    const values = new Map<string, string>();
    let writes = 0;
    let rejectFromWrite = Number.POSITIVE_INFINITY;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        if (writes >= rejectFromWrite)
          throw new DOMException('Storage unavailable', 'QuotaExceededError');
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key),
    };
    const initialTimeline = buildReferenceSpikeProject();
    const session = new EditorSession(storage, initialTimeline, INITIAL_EDITOR_PROJECT);
    const initialRevision = session.projectRevisionId;
    const initialClipCount =
      session.timelineProject.compositions[session.timelineProject.rootCompositionId]!.tracks[0]!
        .clips.length;
    const draft = compileDraft(session);
    const authority = authorityFor(session);
    const preparedChanges = new PreparedChangeStore();
    const view = preparedChanges.prepare(draft, authority);
    const approval = preparedChanges.approve(view.changeSetId, authority);

    // Journal, timeline, document, and raw receipt writes succeed. The
    // commit-marker write then fails, and the threshold also rejects each
    // immediate rollback write. Only a fresh session may resolve the journal.
    rejectFromWrite = writes + 5;
    expect(() =>
      new JoyCodeCompoundRunner().apply(session, preparedChanges, approval, authority),
    ).toThrow('requires reload recovery');

    expect(session.projectRevisionId).toBe(initialRevision);
    expect(session.historyCursorSequence).toBe(0);
    expect(
      session.visualProject.visualObjects['text-clean-title-atomic-recovery-plan-0'],
    ).toBeUndefined();
    expect(
      session.timelineProject.compositions[session.timelineProject.rootCompositionId]!.tracks[0]!
        .clips,
    ).toHaveLength(initialClipCount);
    expect(session.agentIdempotency.getExecutionReceipt(view.executionId)).toBeUndefined();
    expect(values.get(agentIdempotencyStorageKey(session.timelineProject.id))).toContain(
      view.executionId,
    );

    expect(() =>
      new JoyCodeCompoundRunner().apply(session, preparedChanges, approval, authority),
    ).toThrow(expect.objectContaining({ code: 'PERSISTENCE_RECOVERY_REQUIRED' }));

    rejectFromWrite = Number.POSITIVE_INFINITY;
    const reopened = new EditorSession(storage, initialTimeline, INITIAL_EDITOR_PROJECT);
    expect(reopened.projectRevisionId).toBe(initialRevision);
    expect(reopened.historyCursorSequence).toBe(0);
    expect(
      reopened.visualProject.visualObjects['text-clean-title-atomic-recovery-plan-0'],
    ).toBeUndefined();
    expect(
      reopened.timelineProject.compositions[reopened.timelineProject.rootCompositionId]!.tracks[0]!
        .clips,
    ).toHaveLength(initialClipCount);
    expect(reopened.agentIdempotency.getExecutionReceipt(view.executionId)).toBeUndefined();
    expect(values.get(agentIdempotencyStorageKey(reopened.timelineProject.id))).toBeUndefined();
    expect(
      [...values.keys()].some((key) => key.startsWith('joy-media.editor-compound-write.v1:')),
    ).toBe(false);
  });
});
