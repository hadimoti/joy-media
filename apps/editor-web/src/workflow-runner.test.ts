import { describe, expect, it } from 'vitest';
import {
  buildReferenceSpikeProject,
  emptySpikeProject,
  makeVideoClip,
  SECOND_US,
} from '@joy-media/test-fixtures';
import { createPlan, type AgentPlanStep } from '@joy-media/agent-tools';
import type {
  NodeHandler,
  NodeLibrary,
  ProductionRunAuthority,
  ProductionRunStore,
} from '@joy-media/workflow-engine';
import { resumeWorkflow, runWorkflow } from './workflow-runner.js';
import { saveWorkflow } from './workflow-recorder.js';
import { EditorSession } from './editor-session.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { BrowserProductionRunStore } from './browser-production-run-store.js';
import {
  createFixtureFirstPartyLibrary,
  createProductionFirstPartyLibrary,
} from './first-party-handlers.js';
import { parametersFromSchema } from './WorkflowsPanel.js';

const owner: ProductionRunAuthority = {
  principalId: 'local-owner',
  role: 'owner',
  displayName: 'Local owner',
};

describe('workflow-runner', () => {
  it('executes a recorded editor.commandTransaction workflow', async () => {
    const storage = new Map<string, string>();
    const session = new EditorSession(
      {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );

    const baseClip = makeVideoClip('agent-clip-1', 30 * SECOND_US, 5 * SECOND_US);
    const step: AgentPlanStep = {
      id: 'step-1',
      description: 'Insert a clip at the end of track-0',
      mode: 'command',
      tool: 'insertClip',
      arguments: {
        compositionId: 'root',
        trackId: 'track-0',
        clip: { ...baseClip },
      },
      dependsOn: [],
      expectedChange: 'Insert agent-clip-1',
      preconditions: [],
      requiresConfirmation: false,
    };
    const plan = createPlan('Run workflow test', [step]);
    const recorded = saveWorkflow(session, plan);

    const beforeClips =
      session.timelineProject.compositions.root?.tracks
        .find((t) => t.id === 'track-0')
        ?.clips.map((c) => c.id) ?? [];

    await runWorkflow(session, recorded.workflow.id, {
      trackId: 'track-0',
      clipId: baseClip.id,
      clipStartUs: baseClip.startUs,
      clipDurationUs: baseClip.durationUs,
      clipSourceInUs: baseClip.sourceInUs,
    });

    const afterClips =
      session.timelineProject.compositions.root?.tracks
        .find((t) => t.id === 'track-0')
        ?.clips.map((c) => c.id) ?? [];

    expect(afterClips).toEqual([...beforeClips, 'agent-clip-1']);
  });

  it('re-uses a recorded workflow on a different clip when inputs are overridden', async () => {
    const storage = new Map<string, string>();
    const project = emptySpikeProject({ trackCount: 1, durationUs: 30_000_000 });
    const session = new EditorSession(
      {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      project,
      INITIAL_EDITOR_PROJECT,
    );

    const clipA = makeVideoClip('clip-a', 0, 5 * SECOND_US);
    const step: AgentPlanStep = {
      id: 'step-1',
      description: 'Insert a clip',
      mode: 'command',
      tool: 'insertClip',
      arguments: {
        compositionId: 'root',
        trackId: 'track-0',
        clip: { ...clipA },
      },
      dependsOn: [],
      expectedChange: 'Insert clip-a',
      preconditions: [],
      requiresConfirmation: false,
    };
    const plan = createPlan('Re-use workflow on different clip', [step]);
    const recorded = saveWorkflow(session, plan);

    const beforeClips =
      session.timelineProject.compositions.root?.tracks
        .find((t) => t.id === 'track-0')
        ?.clips.map((c) => c.id) ?? [];

    const first = await runWorkflow(session, recorded.workflow.id, {
      trackId: 'track-0',
      clipId: clipA.id,
      clipStartUs: clipA.startUs,
      clipDurationUs: clipA.durationUs,
      clipSourceInUs: clipA.sourceInUs,
    });
    expect(first.status).toBe('succeeded');

    const afterClipA =
      session.timelineProject.compositions.root?.tracks
        .find((t) => t.id === 'track-0')
        ?.clips.map((c) => c.id) ?? [];
    expect(afterClipA).toEqual([...beforeClips, 'clip-a']);

    session.undo();
    expect(
      session.timelineProject.compositions.root?.tracks
        .find((t) => t.id === 'track-0')
        ?.clips.map((c) => c.id) ?? [],
    ).toEqual(beforeClips);

    const clipB = makeVideoClip('clip-b', 0, 5 * SECOND_US);
    const second = await runWorkflow(session, recorded.workflow.id, {
      trackId: 'track-0',
      clipId: clipB.id,
      clipStartUs: clipB.startUs,
      clipDurationUs: clipB.durationUs,
      clipSourceInUs: clipB.sourceInUs,
    });
    expect(second.status).toBe('succeeded');

    const afterClipB =
      session.timelineProject.compositions.root?.tracks
        .find((t) => t.id === 'track-0')
        ?.clips.map((c) => c.id) ?? [];
    expect(afterClipB).toEqual([...beforeClips, 'clip-b']);
  });

  it('resumes a serialized parked workflow through a fresh store-backed runner without rerunning deterministic nodes', async () => {
    const storage = memoryStorage();
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const firstCounts: Record<string, number> = {};
    const firstStore = productionRunStore(storage, session.timelineProject.id);
    const first = await runWorkflow(
      session,
      'joy.first-party.long-video-draft-reels',
      { assetId: 'asset-long-1' },
      {
        productionRunStore: firstStore,
        authority: owner,
        firstPartyLibrary: countedLibrary(createFixtureFirstPartyLibrary(), firstCounts),
      },
    );
    expect(first.status).toBe('waiting_for_input');
    if (first.status !== 'waiting_for_input') return;
    expect(firstCounts['analysis.transcribe']).toBe(1);
    expect(firstCounts['analysis.hooks']).toBe(1);

    const serialized = JSON.stringify(await firstStore.load(first.runId));
    const revivedStore = productionRunStore(storage, session.timelineProject.id);
    const revived = await revivedStore.load(first.runId);
    expect(revived).toMatchObject({
      state: 'parked',
      checkpointRevision: 1,
      workflowInputs: { assetId: 'asset-long-1' },
      checkpoint: {
        nodes: {
          transcribe: { state: 'succeeded', output: expect.any(Object) },
          hooks: { state: 'succeeded', output: expect.any(Object) },
        },
      },
      approvals: [{ nodeId: 'approve-candidates', state: 'pending' }],
    });
    expect(serialized).toContain('"workflowInputs"');

    const payload = first.request.payload as { candidates: readonly { title: string }[] };
    const secondCounts: Record<string, number> = {};
    const second = await resumeWorkflow(
      session,
      first.runId,
      { 'approve-candidates': { candidates: payload.candidates.slice(0, 2) } },
      {
        productionRunStore: revivedStore,
        authority: owner,
        firstPartyLibrary: countedLibrary(createFixtureFirstPartyLibrary(), secondCounts),
        ...(first.approvalExpiresAtSeq === undefined
          ? {}
          : { approvalExpiresAtSeq: first.approvalExpiresAtSeq }),
      },
    );
    expect(second.status).toBe('waiting_for_input');
    expect(secondCounts['analysis.transcribe'] ?? 0).toBe(0);
    expect(secondCounts['analysis.hooks'] ?? 0).toBe(0);
    await expect(revivedStore.load(first.runId)).resolves.toMatchObject({
      checkpointRevision: 2,
      approvals: [
        { nodeId: 'approve-candidates', state: 'approved' },
        { nodeId: 'approve-drafts', state: 'pending' },
      ],
    });
  });

  it('rejects stale two-tab checkpoint updates after another runner advances the run', async () => {
    const storage = memoryStorage();
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const store = productionRunStore(storage, session.timelineProject.id);
    const options = {
      productionRunStore: store,
      authority: owner,
      firstPartyLibrary: createFixtureFirstPartyLibrary(),
    } as const;
    const first = await runWorkflow(
      session,
      'joy.first-party.long-video-draft-reels',
      { assetId: 'asset-long-1' },
      options,
    );
    expect(first.status).toBe('waiting_for_input');
    if (first.status !== 'waiting_for_input') return;
    const staleSnapshot = await store.load(first.runId);
    if (staleSnapshot === undefined) expect.unreachable('run should be persisted');

    const payload = first.request.payload as { candidates: readonly { title: string }[] };
    const humanInputs = { 'approve-candidates': { candidates: payload.candidates.slice(0, 1) } };
    const current = await resumeWorkflow(session, first.runId, humanInputs, {
      ...options,
      ...(first.approvalExpiresAtSeq === undefined
        ? {}
        : { approvalExpiresAtSeq: first.approvalExpiresAtSeq }),
    });
    expect(current.status).toBe('waiting_for_input');

    const staleStore: ProductionRunStore = {
      load: async () => staleSnapshot,
      create: (record) => store.create(record),
      compareAndSwapCheckpoint: (update) => store.compareAndSwapCheckpoint(update),
      recordApprovalResponse: async () => ({
        ok: true,
        duplicate: false,
        record: staleSnapshot,
      }),
    };
    const stale = await resumeWorkflow(session, first.runId, humanInputs, {
      productionRunStore: staleStore,
      authority: owner,
      firstPartyLibrary: createFixtureFirstPartyLibrary(),
    });
    expect(stale).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('checkpoint revision conflict'),
    });
  });

  it('does not resume canceled or expired parked approval requests', async () => {
    const storage = memoryStorage();
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const store = productionRunStore(storage, session.timelineProject.id);
    const options = {
      productionRunStore: store,
      authority: owner,
      firstPartyLibrary: createFixtureFirstPartyLibrary(),
    } as const;

    const canceled = await runWorkflow(
      session,
      'joy.first-party.long-video-draft-reels',
      { assetId: 'asset-long-1' },
      options,
    );
    expect(canceled.status).toBe('waiting_for_input');
    if (canceled.status !== 'waiting_for_input') return;
    const canceledRecord = await store.load(canceled.runId);
    if (canceledRecord === undefined) expect.unreachable('run should be persisted');
    await store.cancel(canceled.runId, {
      authority: owner,
      expectedUpdatedSeq: canceledRecord.updatedSeq,
    });
    const afterCancel = await resumeWorkflow(
      session,
      canceled.runId,
      { 'approve-candidates': { candidates: [] } },
      options,
    );
    expect(afterCancel).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('canceled'),
    });

    const expired = await runWorkflow(
      session,
      'joy.first-party.long-video-draft-reels',
      { assetId: 'asset-long-2' },
      options,
    );
    expect(expired.status).toBe('waiting_for_input');
    if (expired.status !== 'waiting_for_input') return;
    const expiredResult = await resumeWorkflow(
      session,
      expired.runId,
      { 'approve-candidates': { candidates: [] } },
      {
        ...options,
        approvalExpiresAtSeq: Math.max(0, (expired.approvalExpiresAtSeq ?? 0) - 1),
      },
    );
    expect(expiredResult).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('approval-expired'),
    });
  });

  it('defaults workflow run inputs from both the selected clip and current playhead', () => {
    const parameters = parametersFromSchema(
      {
        properties: {
          trackId: { type: 'string' },
          clipId: { type: 'string' },
          clipStartUs: { type: 'number' },
          atUs: { type: 'number' },
          newStartUs: { type: 'number' },
          newEndUs: { type: 'number' },
        },
        required: ['trackId', 'clipId', 'clipStartUs', 'atUs', 'newStartUs', 'newEndUs'],
      },
      {
        trackId: 'track-7',
        clip: { id: 'clip-7', startUs: 2_000_000, durationUs: 5_000_000 },
      },
      3_500_000,
    );
    expect(
      Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter.default])),
    ).toEqual({
      trackId: 'track-7',
      clipId: 'clip-7',
      clipStartUs: 2_000_000,
      atUs: 3_500_000,
      newStartUs: 3_500_000,
      newEndUs: 7_000_000,
    });
  });

  it('uses production first-party ports by default and fails unsupported ports without fixture success', async () => {
    const storage = memoryStorage();
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const store = productionRunStore(storage, session.timelineProject.id);
    const result = await runWorkflow(
      session,
      'joy.first-party.long-video-draft-reels',
      { assetId: 'asset-long-1' },
      {
        productionRunStore: store,
        authority: owner,
        firstPartyLibrary: createProductionFirstPartyLibrary(),
      },
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('workflow/port-unavailable:analysis.transcribe'),
    });
    const record = await store.load(result.runId);
    expect(record?.state).toBe('failed');
    expect(record?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'ingest', state: 'succeeded' }),
        expect.objectContaining({
          nodeId: 'transcribe',
          state: 'failed',
          failureCode: 'workflow/port-unavailable:analysis.transcribe',
        }),
      ]),
    );
  });
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function productionRunStore(
  storage: ReturnType<typeof memoryStorage>,
  projectId: string,
): BrowserProductionRunStore {
  return new BrowserProductionRunStore(storage, { projectId, authority: owner });
}

function countedLibrary(library: NodeLibrary, counts: Record<string, number>): NodeLibrary {
  const handlers: Record<string, NodeHandler> = {};
  for (const [type, handler] of Object.entries(library.handlers)) {
    handlers[type] = (context) => {
      counts[type] = (counts[type] ?? 0) + 1;
      return handler(context);
    };
  }
  return { registry: library.registry, handlers };
}
