import { describe, expect, it, vi } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { editorialClean } from '@joy-media/motion-core';
import { canonicalJson } from '@joy-media/workflow-engine';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { DEFAULT_AGENT_POLICY } from '../agent-policy-settings.js';
import { EditorSession } from '../editor-session.js';
import type { JoyAgentTarget } from '../agent-presence.js';
import { createAgentPreviewStore } from '../agent-preview-store.js';
import { JoyCodeCompoundRunner } from '../joy-code-compound-runner.js';
import type {
  JoyAgentEngineClient,
  JoyAgentRunHost,
  JoyAgentRunIterator,
} from './engine-client.js';
import type { HostRpcJson, HostRpcMethod } from './host-rpc.js';
import { JOY_AGENT_PROTOCOL_VERSION, type JoyAgentSafeEvent } from './protocol.js';
import { PreparedChangeStore, type PreparedChangeAuthority } from './prepared-change-store.js';
import type { CreativeSkillRunScope } from './skill-runner.js';
import { runScopedLookToolLoop, type LookScopedRunDeps } from './look-scoped-host.js';
import type { LivingLooksRunInput } from '../LivingLooksPanel.js';

const CONTROL_DEFAULTS = Object.fromEntries(editorialClean.controls.map((c) => [c.id, c.default]));

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function newSession(store = storage()) {
  return {
    store,
    session: new EditorSession(store, buildReferenceSpikeProject(), INITIAL_EDITOR_PROJECT),
  };
}

const event = (phase: JoyAgentSafeEvent['phase'], extra: Partial<JoyAgentSafeEvent> = {}) =>
  ({
    protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
    runId: 'run-1',
    runEpoch: 1,
    seq: 1,
    at: '2026-09-09T00:00:00.000Z',
    phase,
    ...extra,
  }) as JoyAgentSafeEvent;

const METHOD_FOR: Record<LivingLooksRunInput['kind'], string> = {
  apply: 'look_apply',
  update: 'look_update',
  reset: 'look_reset_overrides',
  detach: 'look_detach',
};

function argsFor(intent: LivingLooksRunInput): HostRpcJson {
  switch (intent.kind) {
    case 'apply':
      return {
        definitionId: intent.definitionId,
        entityBindings: intent.entityBindings,
        controlValues: intent.controlValues,
      } as HostRpcJson;
    case 'update':
      return {
        instanceId: intent.instanceId,
        ...(intent.nextControlValues === undefined
          ? {}
          : { nextControlValues: intent.nextControlValues }),
      } as HostRpcJson;
    case 'reset':
      return { instanceId: intent.instanceId, bindingIds: intent.bindingIds } as HostRpcJson;
    case 'detach':
      return { instanceId: intent.instanceId } as HostRpcJson;
  }
}

/**
 * A fake engine client that runs the actual Look tool-loop: it calls the
 * trusted host's `look_*` method exactly as the bounded tool-loop would after
 * the model emitted that tool call, then emits the terminal events a real
 * Worker would after a staged preview.
 */
function drivingClient(intent: LivingLooksRunInput): JoyAgentEngineClient {
  const startRun = vi.fn((_request: unknown, host?: JoyAgentRunHost): JoyAgentRunIterator => {
    const iterator = (async function* () {
      const name = METHOD_FOR[intent.kind];
      const method = host!.methods[name] as unknown as HostRpcMethod<HostRpcJson, HostRpcJson>;
      if (method === undefined) {
        yield event('failed', { message: `no ${name} method` });
        return;
      }
      let staged: {
        readonly changeSetId: string;
        readonly operationDigest: string;
        readonly bindingDigest: string;
        readonly operationCount: number;
      };
      try {
        staged = (await method.parseResult(
          await method.execute(method.parseArgs(argsFor(intent)), {
            run: { runId: 'run-1', epoch: 1 },
            requestId: 'request-1',
            signal: new AbortController().signal,
            deadlineAt: Date.now() + 5_000,
          }),
        )) as typeof staged;
      } catch (error) {
        yield event('failed', {
          message: error instanceof Error ? error.message : 'host rejected the look intent',
        });
        return;
      }
      yield event('previewing', {
        proposal: {
          summary: 'Look change',
          baseRevision: 'rev',
          changeSetId: staged.changeSetId,
          operationDigest: staged.operationDigest,
          bindingDigest: staged.bindingDigest,
          operationCount: staged.operationCount,
        },
      });
      yield event('awaiting-approval', { message: 'review' });
    })();
    return Object.assign(iterator, { run: { runId: 'run-1', epoch: 1 } });
  });
  return {
    configure: vi.fn(),
    testConnection: vi.fn(),
    probeMediaCapabilities: vi.fn(),
    startRun,
    cancel: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    getStatus: vi.fn(),
    getMediaCapabilities: vi.fn(),
    registerObservationReviewLease: vi.fn(),
    sendApprovedImageObservation: vi.fn(),
  } as unknown as JoyAgentEngineClient;
}

let RUN_SEQ = 0;

function makeDeps(
  session: EditorSession,
  intent: LivingLooksRunInput,
  overrides: { authorityCurrent?: boolean } = {},
): {
  readonly deps: LookScopedRunDeps;
  readonly scope: CreativeSkillRunScope;
  readonly preparedChanges: PreparedChangeStore;
  readonly authorityFor: (hostRunId: string) => PreparedChangeAuthority;
} {
  const preparedChanges = new PreparedChangeStore();
  const agentPreviewStore = createAgentPreviewStore();
  const proposalTargetsRef = { current: new Map<string, readonly JoyAgentTarget[]>() };
  const scope: CreativeSkillRunScope = {
    projectId: session.timelineProject.id,
    runId: `look-run-${(RUN_SEQ += 1)}`,
    epoch: 1,
    revision: session.projectRevisionId,
  };
  const authorityFor = (hostRunId: string): PreparedChangeAuthority => ({
    projectId: session.timelineProject.id,
    hostRunId,
    sessionIdentity: session,
    sessionEpoch: 1,
    revision: session.projectRevisionId,
    policy: DEFAULT_AGENT_POLICY,
  });
  let idCounter = 0;
  return {
    preparedChanges,
    scope,
    authorityFor,
    deps: {
      client: drivingClient(intent),
      getSession: () => session,
      latestSessionRef: { current: session },
      preparedChanges,
      agentPreviewStore,
      proposalTargetsRef,
      currentPreparedAuthority: authorityFor,
      isAuthorityCurrent: () => overrides.authorityCurrent ?? true,
      buildContextInput: (s) => ({ projectId: s.projectId, revision: s.revision }),
      lookRunContext: {
        resolvedFonts: {},
        availableFonts: [],
        makeInstanceId: () => `look-fixed-${(idCounter += 1)}-0000-0000-000000000000`,
      },
    },
  };
}

function applyStaged(
  session: EditorSession,
  preparedChanges: PreparedChangeStore,
  changeSetId: string,
  authorityFor: (hostRunId: string) => PreparedChangeAuthority,
): void {
  const view = preparedChanges.getView(changeSetId)!;
  const authority = authorityFor(view.hostRunId);
  const approval = preparedChanges.approve(changeSetId, authority);
  const applied = new JoyCodeCompoundRunner().apply(session, preparedChanges, approval, authority);
  expect(applied).toMatchObject({ applied: true });
}

const APPLY_INTENT: LivingLooksRunInput = {
  kind: 'apply',
  definitionId: editorialClean.id,
  definitionVersion: editorialClean.version,
  entityBindings: { headline: 'intro-title' },
  controlValues: CONTROL_DEFAULTS,
};

describe('runScopedLookToolLoop — actual agent Look tool-loop (GAP 5)', () => {
  it('applies a Look through the tool-loop, then commit + one Undo revert both', async () => {
    const { session } = newSession();
    const historyBefore = session.historyEntries.length;
    const { deps, preparedChanges, authorityFor, scope } = makeDeps(session, APPLY_INTENT);

    const result = await runScopedLookToolLoop(deps, { scope, prompt: 'apply editorial clean' });
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') return;

    const draft = preparedChanges.getPreviewDraft(result.changeSetId)!;
    const instanceId = Object.keys(draft.lookInstances!.instances)[0]!;
    expect(draft.lookInstances!.instances[instanceId]!.definitionId).toBe(editorialClean.id);

    applyStaged(session, preparedChanges, result.changeSetId, authorityFor);
    expect(session.lookInstances.instances[instanceId]).toBeDefined();
    expect(Object.keys(session.visualProject.propertyAnimations ?? {}).length).toBeGreaterThan(0);
    expect(session.historyEntries).toHaveLength(historyBefore + 1);

    session.undo();
    expect(session.lookInstances.instances[instanceId]).toBeUndefined();
    expect(session.visualProject.propertyAnimations ?? {}).toEqual({});
  });

  it('detaches a Look through the tool-loop: staged (not auto-applied), keyframes stay', async () => {
    const { session } = newSession();
    // First apply a Look so there is an instance to detach.
    {
      const applied = makeDeps(session, APPLY_INTENT);
      const r = await runScopedLookToolLoop(applied.deps, {
        scope: applied.scope,
        prompt: 'apply',
      });
      expect(r.kind).toBe('prepared');
      if (r.kind !== 'prepared') return;
      applyStaged(session, applied.preparedChanges, r.changeSetId, applied.authorityFor);
    }
    const instanceId = Object.keys(session.lookInstances.instances)[0]!;
    const animsBefore = canonicalJson(session.visualProject.propertyAnimations ?? {});
    const historyBefore = session.historyEntries.length;

    const detach = makeDeps(session, { kind: 'detach', instanceId });
    const result = await runScopedLookToolLoop(detach.deps, {
      scope: { ...detach.scope, revision: session.projectRevisionId },
      prompt: 'detach it',
    });
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') return;
    // Nothing applied yet — the agent detach is staged for approval.
    expect(session.lookInstances.instances[instanceId]).toBeDefined();

    applyStaged(session, detach.preparedChanges, result.changeSetId, detach.authorityFor);
    expect(session.lookInstances.instances[instanceId]).toBeUndefined();
    expect(canonicalJson(session.visualProject.propertyAnimations ?? {})).toBe(animsBefore);
    expect(session.historyEntries).toHaveLength(historyBefore + 1);

    session.undo();
    expect(session.lookInstances.instances[instanceId]).toBeDefined();
  });

  it('fails the loop (nothing staged) when the run scope is no longer current', async () => {
    const { session } = newSession();
    const { deps, preparedChanges, scope } = makeDeps(session, APPLY_INTENT, {
      authorityCurrent: false,
    });
    const result = await runScopedLookToolLoop(deps, { scope, prompt: 'apply' });
    expect(result.kind).toBe('failed');
    expect(preparedChanges).toBeDefined();
  });

  it('an agent look_update stages a recompiled instance with the requested control value', async () => {
    const agent = newSession().session;
    const applied = makeDeps(agent, APPLY_INTENT);
    const seeded = await runScopedLookToolLoop(applied.deps, {
      scope: applied.scope,
      prompt: 'apply',
    });
    if (seeded.kind !== 'prepared') throw new Error('seed failed');
    applyStaged(agent, applied.preparedChanges, seeded.changeSetId, applied.authorityFor);
    const instanceId = Object.keys(agent.lookInstances.instances)[0]!;

    const updateIntent: LivingLooksRunInput = {
      kind: 'update',
      instanceId,
      nextControlValues: { [editorialClean.controls[0]!.id]: 0.9 },
    };
    const agentUpdate = makeDeps(agent, updateIntent);
    const agentResult = await runScopedLookToolLoop(agentUpdate.deps, {
      scope: { ...agentUpdate.scope, revision: agent.projectRevisionId },
      prompt: 'turn it up',
    });
    if (agentResult.kind !== 'prepared') throw new Error('agent update failed');
    const agentDraft = agentUpdate.preparedChanges.getPreviewDraft(agentResult.changeSetId)!;

    expect(agentDraft.lookInstances!.instances[instanceId]!.controlValues).toMatchObject({
      [editorialClean.controls[0]!.id]: 0.9,
    });
    expect(agentDraft.operationDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
