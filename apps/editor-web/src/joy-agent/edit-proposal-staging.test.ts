import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { DEFAULT_AGENT_POLICY } from '../agent-policy-settings.js';
import type { EditorSession } from '../editor-session.js';
import type { JoyAgentTarget } from '../agent-presence.js';
import { createAgentPreviewStore } from '../agent-preview-store.js';
import type { HostRpcHandlerContext } from './host-rpc.js';
import { HostRpcDiagnosticError } from './host-rpc.js';
import { PreparedChangeStore, type PreparedChangeAuthority } from './prepared-change-store.js';
import { createJoyAgentRunController } from './run-controller.js';
import {
  createJoyAgentComposerHostLease,
  isJoyAgentComposerHostLeaseCurrent,
} from './composer-host-lease.js';
import { createJoyAgentProposalStagingHandler } from './edit-proposal-staging.js';

const REVISION = 'rev-1';
const RUN_ID = 'run-1';
const EPOCH = 1;

function session(): EditorSession {
  return {
    projectRevisionId: REVISION,
    timelineProject: buildReferenceSpikeProject(),
    visualProject: INITIAL_EDITOR_PROJECT,
  } as unknown as EditorSession;
}

function proposal() {
  return {
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
  } as unknown as Parameters<ReturnType<typeof createJoyAgentProposalStagingHandler>>[0];
}

function rpcContext(): HostRpcHandlerContext {
  return {
    run: { runId: RUN_ID, epoch: EPOCH },
    requestId: 'request-1',
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 1_000,
  };
}

function harness(overrides: { activeModelRunId?: string } = {}) {
  const liveSession = session();
  const preparedChanges = new PreparedChangeStore();
  const agentPreviewStore = createAgentPreviewStore();
  const proposalTargetsRef = { current: new Map<string, readonly JoyAgentTarget[]>() };
  const controller = createJoyAgentRunController({
    projectId: liveSession.visualProject.id,
    conversationId: `conversation-${liveSession.visualProject.id}`,
  });
  controller.start({
    runId: RUN_ID,
    epoch: EPOCH,
    at: new Date().toISOString(),
    state: 'inspecting',
  });
  const lease = createJoyAgentComposerHostLease(controller, { runId: RUN_ID, epoch: EPOCH });
  const hasHostAuthority = (rpcRun: { runId: string; epoch: number }): boolean =>
    lease.run.runId === rpcRun.runId &&
    lease.run.epoch === rpcRun.epoch &&
    isJoyAgentComposerHostLeaseCurrent(lease);
  const staged: string[] = [];
  const authority = (hostRunId: string): PreparedChangeAuthority => ({
    projectId: liveSession.visualProject.id,
    hostRunId,
    sessionIdentity: liveSession,
    sessionEpoch: 1,
    revision: REVISION,
    policy: DEFAULT_AGENT_POLICY,
  });
  const handler = createJoyAgentProposalStagingHandler({
    runId: RUN_ID,
    baseRevision: REVISION,
    contextProjectId: liveSession.visualProject.id,
    capturedSession: liveSession,
    latestSessionRef: { current: liveSession },
    hasHostAuthority,
    isRunCurrent: () => (overrides.activeModelRunId ?? RUN_ID) === RUN_ID,
    selectedEntityReference: undefined,
    preparedChanges,
    currentPreparedAuthority: authority,
    agentPreviewStore,
    proposalTargetsRef,
    onStaged: (id) => staged.push(id),
  });
  return { handler, preparedChanges, agentPreviewStore, proposalTargetsRef, staged };
}

describe('createJoyAgentProposalStagingHandler', () => {
  it('compiles, prepares, stages a preview, and returns opaque identities', async () => {
    const { handler, preparedChanges, agentPreviewStore, proposalTargetsRef, staged } = harness();

    const result = await handler(proposal(), rpcContext());

    expect(result.baseRevision).toBe(REVISION);
    expect(result.operationCount).toBe(1);
    expect(result.changeSetId).toEqual(expect.any(String));
    expect(result.operationDigest).toEqual(expect.any(String));
    expect(staged).toEqual([result.changeSetId]);
    expect(preparedChanges.getView(result.changeSetId)).toBeDefined();
    expect(agentPreviewStore.getBundle()?.runId).toBe(
      preparedChanges.getView(result.changeSetId)?.planId,
    );
    expect([...proposalTargetsRef.current.keys()]).toHaveLength(1);
  });

  it('rejects the proposal when the active model run no longer matches', async () => {
    const { handler, preparedChanges, staged } = harness({ activeModelRunId: 'run-2' });

    await expect(handler(proposal(), rpcContext())).rejects.toBeInstanceOf(HostRpcDiagnosticError);
    expect(staged).toEqual([]);
    void preparedChanges;
  });
});
