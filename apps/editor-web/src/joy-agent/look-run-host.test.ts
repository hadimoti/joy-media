import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import type { LookCompileInput, LookDefinition } from '@joy-media/motion-core';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { DEFAULT_AGENT_POLICY } from '../agent-policy-settings.js';
import type { EditorSession } from '../editor-session.js';
import type { JoyAgentTarget } from '../agent-presence.js';
import { createAgentPreviewStore } from '../agent-preview-store.js';
import { PreparedChangeStore, type PreparedChangeAuthority } from './prepared-change-store.js';
import type { CreativeSkillRunScope } from './skill-runner.js';
import { stageLookRun, type LookRunDeps } from './look-run-host.js';

const REVISION = 'rev-1';
const SCOPE: CreativeSkillRunScope = {
  projectId: INITIAL_EDITOR_PROJECT.id,
  runId: 'look-run-1',
  epoch: 1,
  revision: REVISION,
};

function session(): EditorSession {
  return {
    projectRevisionId: REVISION,
    timelineProject: buildReferenceSpikeProject(),
    visualProject: INITIAL_EDITOR_PROJECT,
  } as unknown as EditorSession;
}

function deps(overrides: { authorityCurrent?: boolean } = {}): {
  value: LookRunDeps;
  staged: string[];
  preparedChanges: PreparedChangeStore;
} {
  const liveSession = session();
  const preparedChanges = new PreparedChangeStore();
  const agentPreviewStore = createAgentPreviewStore();
  const proposalTargetsRef = { current: new Map<string, readonly JoyAgentTarget[]>() };
  const staged: string[] = [];
  return {
    staged,
    preparedChanges,
    value: {
      getSession: () => liveSession,
      latestSessionRef: { current: liveSession },
      preparedChanges,
      agentPreviewStore,
      proposalTargetsRef,
      currentPreparedAuthority: (hostRunId: string): PreparedChangeAuthority =>
        ({
          projectId: liveSession.visualProject.id,
          hostRunId,
          sessionIdentity: liveSession,
          sessionEpoch: 1,
          revision: REVISION,
          policy: DEFAULT_AGENT_POLICY,
        }) as unknown as PreparedChangeAuthority,
      isAuthorityCurrent: () => overrides.authorityCurrent ?? true,
      onStaged: (_scope, id) => staged.push(id),
    },
  };
}

/** A Look whose slots resolve to real objects in INITIAL_EDITOR_PROJECT. */
function lookDefinition(overrides: Partial<LookDefinition> = {}): LookDefinition {
  return {
    schemaVersion: 1,
    id: 'test-look',
    version: 1,
    title: 'Test Look',
    description: 'A test look.',
    slots: [{ id: 'headline', label: 'Headline', ownerKind: 'visual-object', required: true }],
    bindingTargets: [
      {
        bindingId: 'headline-opacity',
        channel: 'keyframe',
        ownerSlotId: 'headline',
        ownerKind: 'visual-object',
        propertyId: 'opacity',
        timeDomain: 'composition',
      },
    ],
    controls: [
      {
        id: 'entrance',
        label: 'Entrance',
        kind: 'enum',
        options: ['fade', 'hold'],
        default: 'fade',
        drives: [
          {
            bindingId: 'headline-opacity',
            byOption: { fade: 0, hold: 1 },
            atFractions: [0, 0.15],
            interpolation: 'eased',
          },
        ],
      },
    ],
    constraints: {
      portrait: { safeMarginPx: 96, maxHeadlineChars: 40, minHoldUs: 500_000 },
      landscape: { safeMarginPx: 64, maxHeadlineChars: 60, minHoldUs: 500_000 },
    },
    provenance: { author: 'JOY', license: 'internal' },
    requiredOperationKinds: ['motion.setKeyframe'],
    requiredFonts: [],
    verification: [],
    ...overrides,
  };
}

function compileInput(overrides: Partial<LookCompileInput> = {}): LookCompileInput {
  return {
    definition: lookDefinition(),
    definitionVersion: 1,
    compositionId: 'root',
    compositionDurationUs: 30_000_000,
    format: 'portrait',
    entityBindings: { headline: 'intro-title' },
    controlValues: { entrance: 'fade' },
    overriddenBindingIds: [],
    resolvedFonts: {},
    ...overrides,
  };
}

describe('stageLookRun', () => {
  it('stages a Look plan through the shared validate_proposal handler and returns a change set', async () => {
    const d = deps();
    const result = await stageLookRun(d.value, {
      scope: SCOPE,
      compileInput: compileInput(),
      goal: 'apply Test Look',
    });
    expect(result.kind).toBe('ready-for-approval');
    if (result.kind !== 'ready-for-approval') return;
    expect(result.operationCount).toBeGreaterThan(0);
    expect(d.staged).toContain(result.changeSetId);
    expect(d.preparedChanges.getView(result.changeSetId)).toBeDefined();
  });

  it('blocks on a compile failure without staging anything', async () => {
    const d = deps();
    const result = await stageLookRun(d.value, {
      scope: SCOPE,
      compileInput: compileInput({ definitionVersion: 99 }),
      goal: 'apply',
    });
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.reason).toBe('compile-failed');
    expect(result.diagnostics.join(' ')).toMatch(/LOOK_COMPILE_VERSION_MISMATCH/);
    expect(d.staged).toEqual([]);
  });

  it('blocks when the run authority is no longer current', async () => {
    const d = deps({ authorityCurrent: false });
    const result = await stageLookRun(d.value, {
      scope: SCOPE,
      compileInput: compileInput(),
      goal: 'apply',
    });
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.reason).toBe('stale-authority');
    expect(d.staged).toEqual([]);
  });

  it('blocks when a required slot is unbound — no partial stage', async () => {
    const d = deps();
    const result = await stageLookRun(d.value, {
      scope: SCOPE,
      compileInput: compileInput({ entityBindings: {} }),
      goal: 'apply',
    });
    expect(result.kind).toBe('blocked');
    expect(d.staged).toEqual([]);
  });
});
