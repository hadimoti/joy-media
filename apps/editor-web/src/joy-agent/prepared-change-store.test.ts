import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import {
  compileJoyCodeCompoundDraft,
  type JoyCodeCompoundDraft,
} from '../joy-code-compound-compiler.js';
import { DEFAULT_AGENT_POLICY } from '../agent-policy-settings.js';
import { PreparedChangeStore, type PreparedChangeAuthority } from './prepared-change-store.js';

const preparedSessionIdentity = Object.freeze({});

function authority(overrides: Partial<PreparedChangeAuthority> = {}): PreparedChangeAuthority {
  return {
    projectId: 'prepared-change-project',
    hostRunId: 'prepared-change-host-run',
    sessionIdentity: preparedSessionIdentity,
    sessionEpoch: 1,
    revision: 'prepared-change-revision',
    policy: DEFAULT_AGENT_POLICY,
    ...overrides,
  };
}

function compileDraft(content = 'Original prepared title'): JoyCodeCompoundDraft {
  const result = compileJoyCodeCompoundDraft({
    planId: 'prepared-change-plan',
    baseRevision: authority().revision,
    timeline: buildReferenceSpikeProject(),
    visualProject: INITIAL_EDITOR_PROJECT,
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
  if (!result.ok) throw new Error(`Fixture did not compile: ${result.error.code}`);
  return result;
}

type MutableDraft = {
  document: { visualObjects: Record<string, { text?: string }> };
  groups: Array<{ summary: string; affectedIds: string[] }>;
  warnings: string[];
};

type MutableView = {
  groups: Array<{ summary: string; affectedIds: string[] }>;
  warnings: string[];
};

function attemptMutation(callback: () => void): void {
  try {
    callback();
  } catch {
    // A frozen defensive copy is valid; a detached mutable clone is also valid.
  }
}

describe('PreparedChangeStore', () => {
  it('isolates the prepared execution payload from source, preview, and resolved-copy mutation', () => {
    const store = new PreparedChangeStore();
    const draft = compileDraft();
    const currentAuthority = authority();
    const titleId = 'text-clean-title-prepared-change-plan-0';
    const expectedDigest = draft.operationDigest;
    const expectedSummary = draft.groups[0]?.summary;
    const prepared = store.prepare(draft, currentAuthority);

    attemptMutation(() => {
      const mutable = draft as unknown as MutableDraft;
      mutable.document.visualObjects[titleId]!.text = 'Mutated source title';
      mutable.groups[0]!.summary = 'Mutated source summary';
      mutable.warnings.push('Mutated source warning');
    });

    expect(prepared).not.toHaveProperty('document');
    expect(prepared).not.toHaveProperty('timeline');
    attemptMutation(() => {
      const mutable = prepared as unknown as MutableView;
      mutable.groups[0]!.summary = 'Forged display summary';
      mutable.warnings.push('Forged display warning');
    });
    const preview = store.getPreviewDraft(prepared.changeSetId);
    expect(preview).toBeDefined();
    if (preview === undefined) return;
    attemptMutation(() => {
      const mutable = preview as unknown as MutableDraft;
      mutable.document.visualObjects[titleId]!.text = 'Forged preview title';
      mutable.groups[0]!.summary = 'Forged preview summary';
      mutable.warnings.push('Forged preview warning');
    });

    const approval = store.approve(prepared.changeSetId, currentAuthority);
    const resolved = store.resolveApproved(approval, currentAuthority);
    expect(resolved.draft.operationDigest).toBe(expectedDigest);
    expect(resolved.draft.document.visualObjects[titleId]?.text).toBe('Original prepared title');
    expect(resolved.draft.groups[0]?.summary).toBe(expectedSummary);
    expect(resolved.draft.warnings).toEqual([]);

    attemptMutation(() => {
      const mutable = resolved.draft as unknown as MutableDraft;
      mutable.document.visualObjects[titleId]!.text = 'Mutated resolved title';
      mutable.groups[0]!.summary = 'Mutated resolved summary';
    });
    const resolvedAgain = store.resolveApproved(approval, currentAuthority);
    expect(resolvedAgain.draft.document.visualObjects[titleId]?.text).toBe(
      'Original prepared title',
    );
    expect(resolvedAgain.draft.groups[0]?.summary).toBe(expectedSummary);
  });

  it('rejects a forged approval handle and a revoked prepared change', () => {
    const store = new PreparedChangeStore();
    const currentAuthority = authority();
    const prepared = store.prepare(compileDraft(), currentAuthority);
    const approval = store.approve(prepared.changeSetId, currentAuthority);
    const forged = {
      changeSetId: prepared.changeSetId,
      approvalToken: 'forged-approval-token',
    } as unknown as typeof approval;

    expect(() => store.resolveApproved(forged, currentAuthority)).toThrow();
    expect(store.resolveApproved(approval, currentAuthority).draft.operationDigest).toMatch(
      /^[a-f0-9]{64}$/,
    );

    store.revoke(prepared.changeSetId);
    expect(store.getPreviewDraft(prepared.changeSetId)).toBeUndefined();
    expect(() => store.resolveApproved(approval, currentAuthority)).toThrow();
  });

  it('does not expose an approved replay view to a different session authority', () => {
    const store = new PreparedChangeStore();
    const currentAuthority = authority();
    const prepared = store.prepare(compileDraft(), currentAuthority);
    const approval = store.approve(prepared.changeSetId, currentAuthority);

    expect(() =>
      store.getApprovedView(approval, {
        ...currentAuthority,
        sessionIdentity: Object.freeze({}),
      }),
    ).toThrow('JOY_CODE_PREPARED_CHANGE_STALE_SESSION');
  });

  it('uses one host-derived durable execution identity for conflicting payloads in a run', () => {
    const store = new PreparedChangeStore();
    const currentAuthority = authority();
    const first = store.prepare(compileDraft('First authority'), currentAuthority);
    const conflicting = store.prepare(compileDraft('Different authority'), currentAuthority);

    expect(first.operationDigest).not.toBe(conflicting.operationDigest);
    expect(first.executionId).toBe(conflicting.executionId);
    expect(first.bindingDigest).not.toBe(conflicting.bindingDigest);
  });

  it('uses the host run identity rather than a model plan ID for execution authority', () => {
    const store = new PreparedChangeStore();
    const first = store.prepare(
      compileDraft('First host run'),
      authority({ hostRunId: 'run-one' }),
    );
    const second = store.prepare(
      compileDraft('Second host run'),
      authority({ hostRunId: 'run-two' }),
    );

    expect(first.planId).toBe(second.planId);
    expect(first.executionId).not.toBe(second.executionId);
  });

  it.each([
    ['project', authority({ projectId: 'other-project' })],
    ['host run', authority({ hostRunId: 'other-host-run' })],
    ['session', authority({ sessionIdentity: Object.freeze({}) })],
    ['revision', authority({ revision: 'newer-revision' })],
    ['policy', authority({ policy: { ...DEFAULT_AGENT_POLICY, maxCostPerRunUsd: 11 } })],
  ] as const)('invalidates approval when the %s binding changes', (_binding, changedContext) => {
    const store = new PreparedChangeStore();
    const currentAuthority = authority();
    const prepared = store.prepare(compileDraft(), currentAuthority);
    const approval = store.approve(prepared.changeSetId, currentAuthority);

    expect(() => store.resolveApproved(approval, changedContext)).toThrow();
  });
});
