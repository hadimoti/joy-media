import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { DEFAULT_AGENT_POLICY } from '../agent-policy-settings.js';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { EditorSession } from '../editor-session.js';
import {
  compileJoyCodeCompoundDraft,
  type JoyCodeCompoundDraft,
} from '../joy-code-compound-compiler.js';
import { JoyCodeCompoundRunner } from '../joy-code-compound-runner.js';
import {
  PreparedChangeStore,
  type PreparedChangeApprovalHandle,
  type PreparedChangeAuthority,
} from './prepared-change-store.js';
import {
  applyPreparedJoyCodeChange,
  type JoyCodeCompoundApplier,
} from './prepared-apply-outcome.js';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function compileDraft(
  session: EditorSession,
  planId: string,
  content: string,
): JoyCodeCompoundDraft {
  const compiled = compileJoyCodeCompoundDraft({
    planId,
    baseRevision: session.projectRevisionId,
    timeline: session.timelineProject,
    visualProject: session.visualProject,
    registeredAssetIds: Object.keys(session.visualProject.assets),
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
  if (!compiled.ok) throw new Error(`Fixture failed to compile: ${compiled.error.code}`);
  return compiled;
}

function authorityFor(session: EditorSession): PreparedChangeAuthority {
  return {
    projectId: session.timelineProject.id,
    hostRunId: 'prepared-outcome-host-run',
    sessionIdentity: session,
    sessionEpoch: 1,
    revision: session.projectRevisionId,
    policy: DEFAULT_AGENT_POLICY,
  };
}

function postCommitFailure(reason: string): JoyCodeCompoundApplier {
  const durableRunner = new JoyCodeCompoundRunner();
  return {
    apply(
      session: EditorSession,
      preparedChanges: PreparedChangeStore,
      approval: PreparedChangeApprovalHandle,
      authority: PreparedChangeAuthority,
    ) {
      durableRunner.apply(session, preparedChanges, approval, authority);
      throw new Error(reason);
    },
  };
}

describe('prepared Joy Code apply outcome', () => {
  it.each([
    'the response channel was lost after commit',
    'the response channel was cancelled after commit',
  ])('recovers a durable commit when %s', (reason) => {
    const session = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const authority = authorityFor(session);
    const preparedChanges = new PreparedChangeStore();
    const prepared = preparedChanges.prepare(
      compileDraft(session, 'prepared-outcome-plan', 'Durable response recovery'),
      authority,
    );
    const historyBefore = session.historyEntries.length;

    const outcome = applyPreparedJoyCodeChange({
      session,
      preparedChanges,
      prepared,
      authority,
      runner: postCommitFailure(reason),
    });

    expect(outcome.recoveredFromReceipt).toBe(true);
    expect(outcome.result).toMatchObject({
      applied: false,
      replayed: true,
      revisionId: session.projectRevisionId,
      receipt: {
        executionId: prepared.executionId,
        operationDigest: prepared.operationDigest,
      },
    });
    expect(session.agentIdempotency.getExecutionReceipt(prepared.executionId)).toMatchObject({
      operationDigest: prepared.operationDigest,
    });
    expect(session.historyEntries).toHaveLength(historyBefore + 1);
  });

  it('does not turn an error before commit into a successful receipt replay', () => {
    const session = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const authority = authorityFor(session);
    const preparedChanges = new PreparedChangeStore();
    const prepared = preparedChanges.prepare(
      compileDraft(session, 'prepared-outcome-before-commit', 'Never committed'),
      authority,
    );
    const historyBefore = session.historyEntries.length;
    const failingRunner: JoyCodeCompoundApplier = {
      apply: () => {
        throw new Error('provider result disappeared before commit');
      },
    };

    expect(() =>
      applyPreparedJoyCodeChange({
        session,
        preparedChanges,
        prepared,
        authority,
        runner: failingRunner,
      }),
    ).toThrow('provider result disappeared before commit');
    expect(session.agentIdempotency.getExecutionReceipt(prepared.executionId)).toBeUndefined();
    expect(session.historyEntries).toHaveLength(historyBefore);
  });

  it('does not recover a receipt bound to a different proposed payload', () => {
    const session = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const authority = authorityFor(session);
    const preparedChanges = new PreparedChangeStore();
    const first = preparedChanges.prepare(
      compileDraft(session, 'prepared-outcome-first', 'First durable title'),
      authority,
    );
    const conflicting = preparedChanges.prepare(
      compileDraft(session, 'prepared-outcome-conflict', 'Different durable title'),
      authority,
    );
    const runner = new JoyCodeCompoundRunner();

    expect(
      applyPreparedJoyCodeChange({
        session,
        preparedChanges,
        prepared: first,
        authority,
        runner,
      }).recoveredFromReceipt,
    ).toBe(false);
    expect(() =>
      applyPreparedJoyCodeChange({
        session,
        preparedChanges,
        prepared: conflicting,
        authority,
        runner,
      }),
    ).toThrow('JOY_CODE_EXECUTION_CONFLICT');
  });
});
