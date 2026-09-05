import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { EditorSession } from './editor-session.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import {
  compileJoyCodeCompoundDraft,
  type JoyCodeCompoundDraft,
} from './joy-code-compound-compiler.js';
import { JoyCodeCompoundRunner } from './joy-code-compound-runner.js';
import { DEFAULT_AGENT_POLICY } from './agent-policy-settings.js';
import {
  PreparedChangeStore,
  type PreparedChangeApprovalHandle,
  type PreparedChangeAuthority,
} from './joy-agent/prepared-change-store.js';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function authorityFor(
  session: EditorSession,
  overrides: Partial<PreparedChangeAuthority> = {},
): PreparedChangeAuthority {
  return {
    projectId: session.timelineProject.id,
    hostRunId: `host-run-${session.timelineProject.id}`,
    sessionIdentity: session,
    sessionEpoch: 1,
    revision: session.projectRevisionId,
    policy: DEFAULT_AGENT_POLICY,
    ...overrides,
  };
}

function compileDraft(
  session: EditorSession,
  planId: string,
  content: string,
): JoyCodeCompoundDraft {
  const draft = compileJoyCodeCompoundDraft({
    planId,
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
        content,
        startUs: 0,
        durationUs: 1_000_000,
        placementPreset: 'center',
      },
    ],
  });
  if (!draft.ok) throw new Error(`Fixture did not compile: ${draft.error.code}`);
  return draft;
}

function prepareApproved(
  draft: JoyCodeCompoundDraft,
  authority: PreparedChangeAuthority,
  store = new PreparedChangeStore(),
) {
  const view = store.prepare(draft, authority);
  return {
    store,
    view,
    approval: store.approve(view.changeSetId, authority),
  };
}

function attemptMutation(callback: () => void): void {
  try {
    callback();
  } catch {
    // A frozen copy is the expected result for untrusted presentation data.
  }
}

describe('Joy Code compound runner', () => {
  it('requires opaque approval, dispatches once, and one undo restores both buses', () => {
    const session = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const historyBefore = session.historyEntries.length;
    const beforeTimeline = JSON.stringify(session.timelineProject);
    const beforeDocument = JSON.stringify(session.visualProject);
    const draft = compileJoyCodeCompoundDraft({
      planId: 'runner-1',
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
          content: 'Title',
          startUs: 2_000_000,
          durationUs: 2_000_000,
          placementPreset: 'center',
        },
        { id: 'caption', dependsOn: ['title'], kind: 'caption.setBurnIn', enabled: true },
      ],
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const runner = new JoyCodeCompoundRunner();

    const deniedAuthority = authorityFor(session, {
      policy: { ...DEFAULT_AGENT_POLICY, allowedCapabilities: [] },
    });
    const denied = prepareApproved(draft, deniedAuthority);
    expect(() => runner.apply(session, denied.store, denied.approval, deniedAuthority)).toThrow(
      'denies',
    );
    expect(session.historyEntries).toHaveLength(historyBefore);

    const authority = authorityFor(session);
    const prepared = prepareApproved(draft, authority);
    const applied = runner.apply(session, prepared.store, prepared.approval, authority);
    expect(applied).toMatchObject({ applied: true, replayed: false });
    const appliedRevision = applied.revisionId;
    expect(applied.receipt).toMatchObject({
      executionId: prepared.view.executionId,
      operationDigest: draft.operationDigest,
      baseRevision: draft.baseRevision,
      resultRevision: appliedRevision,
      undoEntryId: `history-${session.historyCursorSequence}`,
    });
    expect(
      runner.apply(session, prepared.store, prepared.approval, authorityFor(session)),
    ).toMatchObject({ replayed: true, revisionId: appliedRevision });
    expect(session.historyEntries).toHaveLength(historyBefore + 1);
    expect(session.visualProject.pluginData['joy.captions.burnIn']).toBe(true);
    session.undo();
    const revisionAfterUndo = session.projectRevisionId;
    expect(
      runner.apply(session, prepared.store, prepared.approval, authorityFor(session)),
    ).toMatchObject({ replayed: true, revisionId: appliedRevision });
    expect(session.projectRevisionId).toBe(revisionAfterUndo);
    expect(JSON.stringify(session.timelineProject)).toBe(beforeTimeline);
    expect(JSON.stringify(session.visualProject)).toBe(beforeDocument);
  });

  it('commits only the private prepared payload when source and preview objects are mutated', () => {
    const session = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const draft = compileDraft(session, 'runner-private-payload', 'Original private title');
    const authority = authorityFor(session);
    const prepared = prepareApproved(draft, authority);
    const titleId = 'text-clean-title-runner-private-payload-0';

    attemptMutation(() => {
      const mutable = draft as unknown as {
        document: { visualObjects: Record<string, { text?: string }> };
      };
      mutable.document.visualObjects[titleId]!.text = 'Forged source title';
    });
    const preview = prepared.store.getPreviewDraft(prepared.view.changeSetId);
    expect(preview).toBeDefined();
    if (preview === undefined) return;
    attemptMutation(() => {
      const mutable = preview as unknown as {
        document: { visualObjects: Record<string, { text?: string }> };
      };
      mutable.document.visualObjects[titleId]!.text = 'Forged preview title';
    });

    expect(
      new JoyCodeCompoundRunner().apply(session, prepared.store, prepared.approval, authority),
    ).toMatchObject({ applied: true });
    expect(session.visualProject.visualObjects[titleId]?.text).toBe('Original private title');
  });

  it('persists a replay receipt so a fresh prepared store cannot commit the same plan twice', () => {
    const durableStorage = storage();
    const session = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const historyBefore = session.historyEntries.length;
    const draft = compileDraft(session, 'runner-reload', 'Reload-safe title');
    const authority = authorityFor(session);
    const first = prepareApproved(draft, authority);
    expect(
      new JoyCodeCompoundRunner().apply(session, first.store, first.approval, authority).applied,
    ).toBe(true);

    const reopenedSession = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const replayPreparationAuthority = authorityFor(reopenedSession, {
      revision: draft.baseRevision,
    });
    const reopened = prepareApproved(draft, replayPreparationAuthority);
    expect(
      new JoyCodeCompoundRunner().apply(
        reopenedSession,
        reopened.store,
        reopened.approval,
        authorityFor(reopenedSession),
      ),
    ).toMatchObject({
      replayed: true,
      receipt: {
        executionId: first.view.executionId,
        operationDigest: draft.operationDigest,
      },
    });
    expect(session.historyEntries).toHaveLength(historyBefore + 1);
  });

  it('leaves its opaque approval retryable when durable receipt persistence fails', () => {
    const baseStorage = storage();
    let failReceiptWrite = false;
    const session = new EditorSession(
      {
        getItem: baseStorage.getItem,
        setItem: (key, value) => {
          if (failReceiptWrite && key.includes('agent-idempotency')) throw new Error('quota');
          baseStorage.setItem(key, value);
        },
        removeItem: baseStorage.removeItem,
      },
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const draft = compileDraft(session, 'runner-receipt-failure', 'Receipt warning');
    const authority = authorityFor(session);
    const prepared = prepareApproved(draft, authority);
    const historyBefore = session.historyEntries.length;
    const revisionBefore = session.projectRevisionId;
    failReceiptWrite = true;
    expect(() =>
      new JoyCodeCompoundRunner().apply(session, prepared.store, prepared.approval, authority),
    ).toThrow('quota');
    expect(
      session.visualProject.visualObjects['text-clean-title-runner-receipt-failure-0'],
    ).toBeUndefined();
    expect(session.historyEntries).toHaveLength(historyBefore);
    expect(session.projectRevisionId).toBe(revisionBefore);
    expect(session.agentIdempotency.getExecutionReceipt(prepared.view.executionId)).toBeUndefined();

    failReceiptWrite = false;
    expect(
      new JoyCodeCompoundRunner().apply(session, prepared.store, prepared.approval, authority),
    ).toMatchObject({ applied: true, replayed: false });
  });

  it('rejects a forged approval and invalidated policy, revision, or session authority', () => {
    const session = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const draft = compileDraft(session, 'runner-authority', 'Bound title');
    const authority = authorityFor(session);
    const prepared = prepareApproved(draft, authority);
    const runner = new JoyCodeCompoundRunner();
    const forged = { approvalId: 'approval-not-issued' } as PreparedChangeApprovalHandle;

    expect(() => runner.apply(session, prepared.store, forged, authority)).toThrow(
      'JOY_CODE_APPROVAL_HANDLE_INVALID',
    );
    expect(() =>
      runner.apply(session, prepared.store, prepared.approval, {
        ...authority,
        policy: { ...DEFAULT_AGENT_POLICY, maxCostPerRunUsd: 11 },
      }),
    ).toThrow('JOY_CODE_POLICY_CHANGED');
    expect(() =>
      runner.apply(session, prepared.store, prepared.approval, {
        ...authority,
        sessionEpoch: authority.sessionEpoch + 1,
      }),
    ).toThrow('JOY_CODE_PREPARED_CHANGE_STALE_SESSION');
    expect(() =>
      runner.apply(session, prepared.store, prepared.approval, {
        ...authority,
        revision: 'newer-prepared-revision',
      }),
    ).toThrow('JOY_CODE_STALE_REVISION');

    session.renameProjectTitle('Manual revision after approval');
    expect(() => runner.apply(session, prepared.store, prepared.approval, authority)).toThrow(
      'JOY_CODE_STALE_REVISION',
    );
    expect(session.historyEntries).toHaveLength(1);
  });

  it('does not let approval from one in-memory session commit through another session', () => {
    const durableStorage = storage();
    const ownerSession = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const draft = compileDraft(ownerSession, 'runner-session-identity', 'Session-owned title');
    const ownerAuthority = authorityFor(ownerSession);
    const prepared = prepareApproved(draft, ownerAuthority);
    const otherSession = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );

    expect(() =>
      new JoyCodeCompoundRunner().apply(
        otherSession,
        prepared.store,
        prepared.approval,
        ownerAuthority,
      ),
    ).toThrow('JOY_CODE_PREPARED_CHANGE_STALE_SESSION');
    expect(
      otherSession.visualProject.visualObjects['text-clean-title-runner-session-identity-0'],
    ).toBeUndefined();
  });

  it('rejects a prepared execution under a different host run before replay or commit', () => {
    const session = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const authority = authorityFor(session);
    const prepared = prepareApproved(
      compileDraft(session, 'runner-host-run', 'Run-bound title'),
      authority,
    );

    expect(() =>
      new JoyCodeCompoundRunner().apply(
        session,
        prepared.store,
        prepared.approval,
        authorityFor(session, { hostRunId: 'other-host-run' }),
      ),
    ).toThrow('JOY_CODE_PREPARED_CHANGE_STALE_RUN');
    expect(session.agentIdempotency.getExecutionReceipt(prepared.view.executionId)).toBeUndefined();
  });

  it('rejects the same host execution identity when a different operation digest is proposed', () => {
    const session = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const authority = authorityFor(session);
    const firstDraft = compileDraft(session, 'runner-conflict', 'First authority');
    const conflictingDraft = compileDraft(session, 'runner-conflict', 'Different authority');
    const first = prepareApproved(firstDraft, authority);
    const conflicting = prepareApproved(conflictingDraft, authority);
    const runner = new JoyCodeCompoundRunner();
    expect(first.view.executionId).toBe(conflicting.view.executionId);

    runner.apply(session, first.store, first.approval, authority);
    const committedRevision = session.projectRevisionId;
    expect(() => runner.apply(session, conflicting.store, conflicting.approval, authority)).toThrow(
      'JOY_CODE_EXECUTION_CONFLICT',
    );
    expect(session.projectRevisionId).toBe(committedRevision);
    expect(
      session.agentIdempotency.getExecutionReceipt(first.view.executionId)?.operationDigest,
    ).toBe(firstDraft.operationDigest);
  });
});
