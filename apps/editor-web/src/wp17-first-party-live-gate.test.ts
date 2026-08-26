import { afterEach, describe, expect, it } from 'vitest';
import { createPlan, type AgentPlanStep } from '@joy-media/agent-tools';
import {
  FIRST_PARTY_WORKFLOW_IDS,
  REFERENCE_SOCIAL_CUTDOWN_SLICE_WORKFLOW_ID,
} from '@joy-media/workflow-engine';
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
  normalizeFirstPartyInputs,
  resetFirstPartyLibraryForTests,
  resumeWorkflow,
  runWorkflow,
} from './workflow-runner.js';
import { BrowserProductionRunStore } from './browser-production-run-store.js';
import { createFixtureFirstPartyLibrary } from './first-party-handlers.js';

afterEach(() => {
  resetFirstPartyLibraryForTests();
});

describe('WP-17 first-party workflows', () => {
  it('loads the production pipeline packs at the pinned version', () => {
    const loaded = loadFirstPartyWorkflows();
    expect(loaded.map((entry) => entry.workflow.id)).toEqual([...FIRST_PARTY_WORKFLOW_IDS]);
    expect(loaded).toHaveLength(FIRST_PARTY_WORKFLOW_IDS.length);
    expect(loaded.map((entry) => entry.workflow.id)).toContain(
      REFERENCE_SOCIAL_CUTDOWN_SLICE_WORKFLOW_ID,
    );
    expect(
      loaded.find((entry) => entry.workflow.id === REFERENCE_SOCIAL_CUTDOWN_SLICE_WORKFLOW_ID),
    ).toMatchObject({
      label: 'Certified editor slice',
      requiredPorts: ['editor.executeCommandTransaction'],
    });
    expect(
      loaded
        .filter((entry) => entry.workflow.id !== REFERENCE_SOCIAL_CUTDOWN_SLICE_WORKFLOW_ID)
        .every((entry) => entry.label === 'Production pack'),
    ).toBe(true);
    expect(getFirstPartyWorkflowVersion()).toBe('2.0.0');
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
    expect(normalizeFirstPartyInputs(workflow, { assetId: 'asset-long-1' })).toMatchObject({
      assetId: 'asset-long-1',
      brief: 'Create a polished, on-brand edit from the selected media.',
      selectedMedia: { assetId: 'asset-long-1' },
    });
  });

  it('runs long-video→draft-reels with explicit fixtures, parks, resumes, and produces a manifest', async () => {
    const storage = new Map<string, string>();
    const session = new EditorSession(
      {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const runStore = new BrowserProductionRunStore(
      {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      {
        projectId: session.timelineProject.id,
        authority: { principalId: 'local-owner', role: 'owner', displayName: 'Local owner' },
      },
    );
    const runnerOptions = {
      productionRunStore: runStore,
      firstPartyLibrary: createFixtureFirstPartyLibrary(),
      authority: { principalId: 'local-owner', role: 'owner', displayName: 'Local owner' },
    } as const;

    const first = await runWorkflow(
      session,
      'joy.first-party.long-video-draft-reels',
      {
        assetId: 'asset-long-1',
      },
      runnerOptions,
    );
    expect(first.status).toBe('waiting_for_input');
    if (first.status !== 'waiting_for_input') return;

    expect(first.request.kind).toBe('confirm-cost');
    await expect(runStore.load(first.runId)).resolves.toMatchObject({
      state: 'parked',
      checkpointRevision: 1,
      approvals: [{ nodeId: 'confirm-cost', state: 'pending' }],
    });

    const second = await resumeWorkflow(
      session,
      first.runId,
      {
        'confirm-cost': { approved: true, approvalRef: 'cost-ok' },
      },
      runnerOptions,
    );
    expect(second.status).toBe('waiting_for_input');
    if (second.status !== 'waiting_for_input') return;
    expect(second.nodeId).toBe('approve-candidates');
    expect(second.request.kind).toBe('choose-candidates');
    const payload = second.request.payload as { candidates: readonly { title: string }[] };
    expect(payload.candidates.map((candidate) => candidate.title)).toEqual([
      'Hook A',
      'Hook B',
      'Hook C',
    ]);
    await expect(runStore.load(first.runId)).resolves.toMatchObject({
      state: 'parked',
      checkpointRevision: 2,
      approvals: [
        { nodeId: 'confirm-cost', state: 'approved' },
        { nodeId: 'approve-candidates', state: 'pending' },
      ],
    });

    const third = await resumeWorkflow(
      session,
      second.runId,
      {
        'approve-candidates': { candidates: payload.candidates.slice(0, 2) },
      },
      runnerOptions,
    );
    expect(third.status).toBe('waiting_for_input');
    if (third.status !== 'waiting_for_input') return;
    expect(third.request.kind).toBe('approve-render');
    expect(third.nodeId).toBe('approve-drafts');

    const draftPayload = third.request.payload as { items: readonly unknown[] };
    const fourth = await resumeWorkflow(
      session,
      third.runId,
      {
        'approve-drafts': { approved: draftPayload.items },
      },
      runnerOptions,
    );
    expect(fourth.status).toBe('succeeded');
    if (fourth.status !== 'succeeded') return;
    expect(fourth.outputs).toMatchObject({
      written: false,
      deferred: true,
      fileName: 'long-video-draft-reels-run.json',
      inMemoryManifest: true,
    });
  });
});
