import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { EditorSession } from './editor-session.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { compileJoyCodeCompoundDraft } from './joy-code-compound-compiler.js';
import { JoyCodeCompoundRunner } from './joy-code-compound-runner.js';
import { DEFAULT_AGENT_POLICY } from './agent-policy-settings.js';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('Joy Code compound runner', () => {
  it('requires exact approval, dispatches once, and one undo restores both buses', () => {
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
    expect(() =>
      runner.apply(
        session,
        draft,
        {
          planId: draft.planId,
          proposalHash: draft.proposalHash,
          baseRevision: draft.baseRevision,
          approvedAt: '2026-08-20T00:00:00.000Z',
        },
        { ...DEFAULT_AGENT_POLICY, allowedCapabilities: [] },
      ),
    ).toThrow('denies');
    expect(session.historyEntries).toHaveLength(historyBefore);
    const applied = runner.apply(session, draft, {
      planId: draft.planId,
      proposalHash: draft.proposalHash,
      baseRevision: draft.baseRevision,
      approvedAt: '2026-08-20T00:00:00.000Z',
    });
    expect(applied).toMatchObject({ applied: true, replayed: false });
    const appliedRevision = applied.revisionId;
    expect(applied.receipt).toMatchObject({
      executionId: draft.planId,
      operationDigest: draft.operationDigest,
      baseRevision: draft.baseRevision,
      resultRevision: appliedRevision,
      undoEntryId: `history-${session.historyCursorSequence}`,
    });
    expect(() =>
      runner.apply(session, draft, {
        planId: draft.planId,
        proposalHash: draft.proposalHash,
        baseRevision: draft.baseRevision,
        approvedAt: '2026-08-20T00:00:00.000Z',
      }),
    ).not.toThrow();
    expect(session.historyEntries).toHaveLength(historyBefore + 1);
    expect(session.visualProject.pluginData['joy.captions.burnIn']).toBe(true);
    expect(
      runner.apply(session, draft, {
        planId: draft.planId,
        proposalHash: draft.proposalHash,
        baseRevision: draft.baseRevision,
        approvedAt: '2026-08-20T00:00:00.000Z',
      }),
    ).toMatchObject({ replayed: true, revisionId: appliedRevision });
    session.undo();
    const revisionAfterUndo = session.projectRevisionId;
    expect(
      runner.apply(session, draft, {
        planId: draft.planId,
        proposalHash: draft.proposalHash,
        baseRevision: draft.baseRevision,
        approvedAt: '2026-08-20T00:00:00.000Z',
      }),
    ).toMatchObject({ replayed: true, revisionId: appliedRevision });
    expect(session.projectRevisionId).toBe(revisionAfterUndo);
    expect(JSON.stringify(session.timelineProject)).toBe(beforeTimeline);
    expect(JSON.stringify(session.visualProject)).toBe(beforeDocument);
  });

  it('persists the replay receipt so a fresh runner cannot commit the same plan twice', () => {
    const durableStorage = storage();
    const session = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const historyBefore = session.historyEntries.length;
    const draft = compileJoyCodeCompoundDraft({
      planId: 'runner-reload',
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
          content: 'Reload-safe title',
          startUs: 0,
          durationUs: 1_000_000,
          placementPreset: 'center',
        },
      ],
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const approval = {
      planId: draft.planId,
      proposalHash: draft.proposalHash,
      baseRevision: draft.baseRevision,
      approvedAt: '2026-09-05T00:00:00.000Z',
    };
    expect(new JoyCodeCompoundRunner().apply(session, draft, approval).applied).toBe(true);
    expect(new JoyCodeCompoundRunner().apply(session, draft, approval)).toMatchObject({
      replayed: true,
    });
    const reopenedSession = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    expect(new JoyCodeCompoundRunner().apply(reopenedSession, draft, approval)).toMatchObject({
      replayed: true,
      receipt: {
        executionId: draft.planId,
        operationDigest: draft.operationDigest,
      },
    });
    expect(session.historyEntries).toHaveLength(historyBefore + 1);
  });

  it('does not commit a change when its durable receipt cannot be written', () => {
    const baseStorage = storage();
    let failReceiptWrite = false;
    const session = new EditorSession(
      {
        getItem: baseStorage.getItem,
        setItem: (key, value) => {
          if (failReceiptWrite && key.includes('agent-idempotency')) throw new Error('quota');
          baseStorage.setItem(key, value);
        },
      },
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const draft = compileJoyCodeCompoundDraft({
      planId: 'runner-receipt-failure',
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
          content: 'Receipt warning',
          startUs: 0,
          durationUs: 1_000_000,
          placementPreset: 'center',
        },
      ],
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const historyBefore = session.historyEntries.length;
    const revisionBefore = session.projectRevisionId;
    failReceiptWrite = true;
    expect(() =>
      new JoyCodeCompoundRunner().apply(session, draft, {
        planId: draft.planId,
        proposalHash: draft.proposalHash,
        baseRevision: draft.baseRevision,
        approvedAt: '2026-09-05T00:00:00.000Z',
      }),
    ).toThrow('quota');
    expect(
      session.visualProject.visualObjects['text-clean-title-runner-receipt-failure-0'],
    ).toBeUndefined();
    expect(session.historyEntries).toHaveLength(historyBefore);
    expect(session.projectRevisionId).toBe(revisionBefore);
    expect(session.agentIdempotency.getExecutionReceipt(draft.planId)).toBeUndefined();
    failReceiptWrite = false;
    const reopened = new EditorSession(
      baseStorage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    expect(
      reopened.visualProject.visualObjects['text-clean-title-runner-receipt-failure-0'],
    ).toBeUndefined();
    expect(reopened.agentIdempotency.getExecutionReceipt(draft.planId)).toBeUndefined();
  });

  it('rejects the same execution ID when a different operation digest is proposed', () => {
    const session = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const first = compileJoyCodeCompoundDraft({
      planId: 'runner-conflict',
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
          content: 'First authority',
          startUs: 0,
          durationUs: 1_000_000,
          placementPreset: 'center',
        },
      ],
    });
    const conflicting = compileJoyCodeCompoundDraft({
      planId: 'runner-conflict',
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
          content: 'Different authority',
          startUs: 0,
          durationUs: 1_000_000,
          placementPreset: 'center',
        },
      ],
    });
    expect(first.ok).toBe(true);
    expect(conflicting.ok).toBe(true);
    if (!first.ok || !conflicting.ok) return;
    const runner = new JoyCodeCompoundRunner();
    const approval = (draft: typeof first) => ({
      planId: draft.planId,
      proposalHash: draft.proposalHash,
      baseRevision: draft.baseRevision,
      approvedAt: '2026-09-05T00:00:00.000Z',
    });
    runner.apply(session, first, approval(first));
    const committedRevision = session.projectRevisionId;

    expect(() => runner.apply(session, conflicting, approval(conflicting))).toThrow(
      'JOY_CODE_EXECUTION_CONFLICT',
    );
    expect(session.projectRevisionId).toBe(committedRevision);
    expect(session.agentIdempotency.getExecutionReceipt(first.planId)?.operationDigest).toBe(
      first.operationDigest,
    );
  });
});
