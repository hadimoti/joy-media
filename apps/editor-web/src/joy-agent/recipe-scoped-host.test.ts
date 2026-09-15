import { describe, expect, it, vi } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { DEFAULT_AGENT_POLICY } from '../agent-policy-settings.js';
import type { EditorSession } from '../editor-session.js';
import type { JoyAgentTarget } from '../agent-presence.js';
import { createAgentPreviewStore } from '../agent-preview-store.js';
import type {
  JoyAgentEngineClient,
  JoyAgentRunIterator,
  JoyAgentRunHost,
} from './engine-client.js';
import type { JoyAgentObservationHostBridge } from './observation-tool-adapter.js';
import type { HostRpcJson, HostRpcMethod } from './host-rpc.js';
import { JOY_AGENT_PROTOCOL_VERSION, type JoyAgentSafeEvent } from './protocol.js';
import { PreparedChangeStore, type PreparedChangeAuthority } from './prepared-change-store.js';
import type { CreativeSkillRunScope } from './skill-runner.js';
import { runScopedCreativeSkillEditToolLoop } from './recipe-scoped-host.js';

const REVISION = 'rev-1';
const SCOPE: CreativeSkillRunScope = {
  projectId: INITIAL_EDITOR_PROJECT.id,
  runId: 'skill-run-1',
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

const PROPOSAL = {
  summary: 'Insert a clean title',
  operations: [
    {
      id: 'title',
      dependsOn: [],
      kind: 'text.insertTemplate',
      templateId: 'clean-title',
      content: 'Hello',
      startUs: 0,
      durationUs: 1_000_000,
      placementPreset: 'center',
    },
  ],
};

const event = (phase: JoyAgentSafeEvent['phase'], extra: Partial<JoyAgentSafeEvent> = {}) =>
  ({
    protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
    runId: 'run-1',
    runEpoch: 1,
    seq: 1,
    at: '2026-09-07T00:00:00.000Z',
    phase,
    ...extra,
  }) as JoyAgentSafeEvent;

/**
 * A fake engine client that actually drives the trusted host's
 * `validate_proposal` method, then emits the terminal events a real Worker
 * would after a staged preview.
 */
function drivingClient(): JoyAgentEngineClient {
  const startRun = vi.fn((_request: unknown, host?: JoyAgentRunHost): JoyAgentRunIterator => {
    const iterator = (async function* () {
      const method = host!.methods.validate_proposal as unknown as HostRpcMethod<
        HostRpcJson,
        HostRpcJson
      >;
      let staged: {
        readonly changeSetId: string;
        readonly operationDigest: string;
        readonly operationCount: number;
      };
      try {
        staged = (await method.parseResult(
          await method.execute(method.parseArgs(PROPOSAL as unknown as HostRpcJson), {
            run: { runId: 'run-1', epoch: 1 },
            requestId: 'request-1',
            signal: new AbortController().signal,
            deadlineAt: Date.now() + 1_000,
          }),
        )) as typeof staged;
      } catch {
        yield event('failed', { message: 'host rejected the proposal' });
        return;
      }
      yield event('previewing', {
        proposal: {
          summary: PROPOSAL.summary,
          baseRevision: REVISION,
          changeSetId: staged.changeSetId,
          operationDigest: staged.operationDigest,
          bindingDigest: 'b'.repeat(64),
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

function deps(overrides: { authorityCurrent?: boolean } = {}) {
  const liveSession = session();
  const preparedChanges = new PreparedChangeStore();
  const agentPreviewStore = createAgentPreviewStore();
  const proposalTargetsRef = { current: new Map<string, readonly JoyAgentTarget[]>() };
  const staged: string[] = [];
  return {
    staged,
    preparedChanges,
    agentPreviewStore,
    value: {
      client: drivingClient(),
      getSession: () => liveSession,
      latestSessionRef: { current: liveSession },
      preparedChanges,
      agentPreviewStore,
      proposalTargetsRef,
      buildContextInput: (scope: CreativeSkillRunScope) => ({
        projectId: scope.projectId,
        revision: scope.revision,
      }),
      currentPreparedAuthority: (hostRunId: string): PreparedChangeAuthority => ({
        projectId: liveSession.visualProject.id,
        hostRunId,
        sessionIdentity: liveSession,
        sessionEpoch: 1,
        revision: REVISION,
        policy: DEFAULT_AGENT_POLICY,
      }),
      isAuthorityCurrent: () => overrides.authorityCurrent ?? true,
      onStaged: (_scope: CreativeSkillRunScope, id: string) => staged.push(id),
    },
  };
}

function input(overrides: Partial<Parameters<typeof runScopedCreativeSkillEditToolLoop>[1]> = {}) {
  return {
    skillId: 'build-rough-cut' as const,
    scope: SCOPE,
    signal: new AbortController().signal,
    allowedToolNames: ['read_project_context', 'validate_proposal'] as const,
    prompt: 'Prepare a reversible rough cut.',
    maxRepairProposals: 2,
    ...overrides,
  };
}

describe('runScopedCreativeSkillEditToolLoop', () => {
  it('stages a real prepared change through the shared handler and returns its identity', async () => {
    const d = deps();

    const result = await runScopedCreativeSkillEditToolLoop(d.value, input());

    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('expected prepared');
    expect(d.staged).toEqual([result.changeSetId]);
    expect(d.preparedChanges.getView(result.changeSetId)).toBeDefined();
    expect(d.agentPreviewStore.getBundle()?.runId).toBe(
      d.preparedChanges.getView(result.changeSetId)?.planId,
    );
  });

  it('fails the loop when the recipe run scope is no longer current', async () => {
    const d = deps({ authorityCurrent: false });

    const result = await runScopedCreativeSkillEditToolLoop(d.value, input());

    expect(result.kind).toBe('failed');
    expect(d.staged).toEqual([]);
  });

  it('keeps observation authority in the visual identity domain', async () => {
    const d = deps();
    const durableProjectId = SCOPE.projectId;
    const visualProjectId = 'visual-document-a';
    const baseSession = d.value.latestSessionRef.current;
    const visualSession = {
      ...baseSession,
      visualProject: { ...baseSession.visualProject, id: visualProjectId },
    } as EditorSession;
    let readAuthority: (() => unknown) | undefined;
    const bridge = {
      tools: {},
      createEvidenceResolver: vi.fn(),
      createReviewCandidate: vi.fn(),
      markReviewedEvidence: vi.fn(),
    } as unknown as JoyAgentObservationHostBridge;
    const recipeDeps = {
      ...d.value,
      getSession: () => visualSession,
      latestSessionRef: { current: visualSession },
      buildContextInput: () => ({ projectId: visualProjectId, revision: REVISION }),
      getModelId: () => 'model-a',
      getPromptPolicyDigest: () => 'policy-a',
      observationAdapterFactory: {
        create: (input: { readonly currentAuthority: () => unknown }) => {
          readAuthority = input.currentAuthority;
          return bridge;
        },
      },
    };

    const result = await runScopedCreativeSkillEditToolLoop(
      recipeDeps,
      input({ allowedToolNames: ['media_observe', 'validate_proposal'] }),
    );
    expect(result.kind).toBe('prepared');
    expect(readAuthority).toBeDefined();
    const authority = readAuthority!() as {
      projectId: string;
      revision: string;
      run: { runId: string; epoch: number };
      modelId: string;
      promptPolicyDigest: string;
    };
    expect(authority).toMatchObject({
      projectId: visualProjectId,
      revision: REVISION,
      modelId: 'model-a',
      promptPolicyDigest: 'policy-a',
      run: { epoch: 1 },
    });
    expect(authority.projectId).not.toBe(durableProjectId);

    recipeDeps.latestSessionRef.current = {
      ...visualSession,
      visualProject: { ...visualSession.visualProject, id: 'wrong-document' },
    } as EditorSession;
    expect(readAuthority!()).toBeUndefined();
  });
});
