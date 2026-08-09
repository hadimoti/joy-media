import { afterEach, describe, expect, it } from 'vitest';
import { createPlan, type AgentPlanStep } from '@joy-media/agent-tools';
import { FIRST_PARTY_WORKFLOW_IDS } from '@joy-media/workflow-engine';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { EditorSession } from './editor-session.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import {
  detectDerivedFrom,
  loadFirstPartyWorkflows,
  getFirstPartyWorkflowVersion,
} from './first-party-workflows.js';
import { saveWorkflow } from './workflow-recorder.js';
import {
  getParkedWorkflowRun,
  normalizeFirstPartyInputs,
  resetFirstPartyLibraryForTests,
  resumeWorkflow,
  runWorkflow,
} from './workflow-runner.js';

afterEach(() => {
  resetFirstPartyLibraryForTests();
});

describe('WP-17 first-party workflows', () => {
  it('loads the three system workflows at the pinned version', () => {
    const loaded = loadFirstPartyWorkflows();
    expect(loaded.map((entry) => entry.workflow.id)).toEqual([...FIRST_PARTY_WORKFLOW_IDS]);
    expect(getFirstPartyWorkflowVersion()).toBe('1.0.0');
  });

  it('detects derived-from lineage on recorded workflows only', () => {
    const storage = new Map<string, string>();
    const session = new EditorSession(
      {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const step: AgentPlanStep = {
      id: 'step-1',
      description: 'Caption a long video draft reels candidate',
      mode: 'command',
      tool: 'insertClip',
      arguments: { compositionId: 'root', trackId: 'track-0', clip: { id: 'x' } },
      dependsOn: [],
      expectedChange: 'x',
      preconditions: [],
      requiresConfirmation: false,
    };
    const recorded = saveWorkflow(
      session,
      createPlan('Teach long video draft reels caption step', [step]),
    );
    expect(detectDerivedFrom(recorded)).toBe('joy.first-party.long-video-draft-reels');
  });

  it('normalizes assetId modal input into the first-party asset object', () => {
    const workflow = loadFirstPartyWorkflows()[0]?.workflow;
    expect(workflow).toBeDefined();
    if (workflow === undefined) return;
    expect(normalizeFirstPartyInputs(workflow, { assetId: 'asset-long-1' })).toEqual({
      assetId: 'asset-long-1',
      asset: { assetId: 'asset-long-1', fixture: true },
    });
  });

  it('normalizes a visible source asset id into the podcast input shape', () => {
    const workflow = loadFirstPartyWorkflows().find((entry) =>
      entry.workflow.id.endsWith('podcast-cleanup'),
    )?.workflow;
    expect(workflow).toBeDefined();
    if (workflow === undefined) return;
    expect(normalizeFirstPartyInputs(workflow, { source: 'asset-episode-1' })).toEqual({
      source: { assetId: 'asset-episode-1', fixture: true },
    });
  });

  it('runs long-video→draft-reels with stubs, parks, resumes, and produces a manifest', async () => {
    const storage = new Map<string, string>();
    const session = new EditorSession(
      {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );

    const first = await runWorkflow(session, 'joy.first-party.long-video-draft-reels', {
      assetId: 'asset-long-1',
    });
    expect(first.status).toBe('waiting_for_input');
    if (first.status !== 'waiting_for_input') return;

    expect(first.request.kind).toBe('choose-candidates');
    expect(getParkedWorkflowRun(first.runId)?.nodeId).toBe('approve-candidates');
    const payload = first.request.payload as { candidates: readonly { title: string }[] };
    expect(payload.candidates.map((candidate) => candidate.title)).toEqual([
      'Hook A',
      'Hook B',
      'Hook C',
    ]);

    const second = await resumeWorkflow(session, first.runId, {
      'approve-candidates': { candidates: payload.candidates.slice(0, 2) },
    });
    expect(second.status).toBe('waiting_for_input');
    if (second.status !== 'waiting_for_input') return;
    expect(second.request.kind).toBe('approve-render');
    expect(second.nodeId).toBe('approve-drafts');

    const draftPayload = second.request.payload as { items: readonly unknown[] };
    const third = await resumeWorkflow(session, second.runId, {
      'approve-drafts': { approved: draftPayload.items },
    });
    expect(third.status).toBe('succeeded');
    if (third.status !== 'succeeded') return;
    expect(third.outputs).toMatchObject({
      written: false,
      deferred: true,
      fileName: 'long-video-draft-reels-run.json',
      inMemoryManifest: true,
    });
  });
});
