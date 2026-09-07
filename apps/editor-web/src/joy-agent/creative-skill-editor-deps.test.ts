import { describe, expect, it, vi } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { DEFAULT_AGENT_POLICY } from '../agent-policy-settings.js';
import type { EditorSession } from '../editor-session.js';
import type { JoyAgentTarget } from '../agent-presence.js';
import { createAgentPreviewStore } from '../agent-preview-store.js';
import type { JoyAgentEngineClient } from './engine-client.js';
import { PreparedChangeStore, type PreparedChangeAuthority } from './prepared-change-store.js';
import type { CreativeSkillRunScope } from './skill-runner.js';
import { createCreativeSkillEditorPrimitiveDeps } from './creative-skill-editor-deps.js';

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

function graph(over: { agentPreviewStore?: ReturnType<typeof createAgentPreviewStore> } = {}) {
  const liveSession = session();
  return {
    client: {} as unknown as JoyAgentEngineClient,
    getSession: () => liveSession,
    latestSessionRef: { current: liveSession },
    preparedChanges: new PreparedChangeStore(),
    agentPreviewStore: over.agentPreviewStore ?? createAgentPreviewStore(),
    proposalTargetsRef: { current: new Map<string, readonly JoyAgentTarget[]>() },
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
    isAuthorityCurrent: () => true,
    previewAckTimeoutMs: 50,
  };
}

const signal = new AbortController().signal;

describe('createCreativeSkillEditorPrimitiveDeps', () => {
  it('summarizes the live session for readProjectContext without a model call', async () => {
    const deps = createCreativeSkillEditorPrimitiveDeps(graph());
    const context = await deps.readProjectContext({
      scope: SCOPE,
      contextSelectors: ['overview'],
      signal,
    });
    expect(context.summary).toMatch(/Project revision rev-1/);
    expect(context.summary).toMatch(/track/);
  });

  it('reports no bounded source evidence when observation never ran', async () => {
    const deps = createCreativeSkillEditorPrimitiveDeps(graph());
    const coverage = await deps.readObservationCoverage({ scope: SCOPE, signal });
    expect(coverage).toEqual({
      coverageSummary: 'No bounded source evidence was requested for this recipe.',
      coverageComplete: false,
      evidenceIds: [],
    });
  });

  it('confirms a renderer acknowledgement only when the bundle for the plan is ready', async () => {
    const g = graph();
    const deps = createCreativeSkillEditorPrimitiveDeps(g);
    const missing = await deps.confirmPreviewRendered({
      scope: SCOPE,
      changeSetId: 'does-not-exist',
      signal,
    });
    expect(missing.rendererAcknowledged).toBe(false);
  });

  it('produces an honest R1 verify-deliverable report: structural passed, O6 checks unavailable', async () => {
    const deps = createCreativeSkillEditorPrimitiveDeps(graph());
    const { report, summary } = await deps.verifyComposedAndEncoded({
      scope: SCOPE,
      signal,
      evidenceRequirements: ['composed-output', 'encoded-output'],
    });
    const byMethod = new Map(report.checks.map((check) => [check.method, check.status]));
    expect(byMethod.get('structural')).toBe('passed');
    expect(byMethod.get('rendered')).toBe('unavailable');
    expect(byMethod.get('encoded-output')).toBe('unavailable');
    expect(report.overall).toBe('incomplete');
    expect(summary).toMatch(/unavailable in R1/);
  });

  it('delegates runScopedToolLoop to the recipe-scoped edit tool-loop', async () => {
    const g = graph();
    const deps = createCreativeSkillEditorPrimitiveDeps(g);
    // No client wiring here -- assert the call reaches the loop and fails
    // gracefully rather than throwing synchronously.
    g.client.startRun = vi.fn(() => {
      throw new Error('client not configured');
    }) as unknown as JoyAgentEngineClient['startRun'];
    const result = await deps.runScopedToolLoop({
      skillId: 'build-rough-cut',
      scope: SCOPE,
      signal,
      allowedToolNames: ['read_project_context', 'validate_proposal'],
      prompt: 'prepare a rough cut',
      maxRepairProposals: 2,
    });
    expect(result.kind).toBe('failed');
  });
});
