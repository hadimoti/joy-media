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
  createEditorSessionFirstPartyLibrary,
  createProductionFirstPartyLibrary,
} from './first-party-handlers.js';
import { parametersFromSchema } from './WorkflowsPanel.js';
import {
  deliveryMediaStateFromEvidence,
  deliveryPreflight,
  type VerifiedRenderEnvelope,
} from './delivery-preflight.js';

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
    expect(first.nodeId).toBe('confirm-cost');
    expect(firstCounts['analysis.researchBrief']).toBe(1);
    expect(firstCounts['generation.script']).toBe(1);
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
          research: { state: 'succeeded', output: expect.any(Object) },
          script: { state: 'succeeded', output: expect.any(Object) },
          candidates: { state: 'succeeded', output: expect.any(Object) },
        },
      },
      approvals: [{ nodeId: 'confirm-cost', state: 'pending' }],
    });
    expect(serialized).toContain('"workflowInputs"');

    const blockedResume = await resumeWorkflow(
      session,
      first.runId,
      { 'confirm-cost': { approved: true, approvalRef: 'cost-ok' } },
      {
        productionRunStore: revivedStore,
        authority: owner,
        firstPartyLibrary: createProductionFirstPartyLibrary(),
        ...approvalResumeOptions(first),
      },
    );
    expect(blockedResume).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Connect the approved provider/Worker adapters'),
    });
    await expect(revivedStore.load(first.runId)).resolves.toMatchObject({
      state: 'parked',
      checkpointRevision: 1,
    });

    const secondCounts: Record<string, number> = {};
    const second = await resumeWorkflow(
      session,
      first.runId,
      { 'confirm-cost': { approved: true, approvalRef: 'cost-ok' } },
      {
        productionRunStore: revivedStore,
        authority: owner,
        firstPartyLibrary: countedLibrary(createFixtureFirstPartyLibrary(), secondCounts),
        ...approvalResumeOptions(first),
      },
    );
    expect(second.status).toBe('waiting_for_input');
    expect(second).toMatchObject({ nodeId: 'approve-candidates' });
    expect(secondCounts['generation.script'] ?? 0).toBe(0);
    expect(secondCounts['analysis.hooks'] ?? 0).toBe(0);
    await expect(revivedStore.load(first.runId)).resolves.toMatchObject({
      checkpointRevision: 2,
      approvals: [
        { nodeId: 'confirm-cost', state: 'approved' },
        { nodeId: 'approve-candidates', state: 'pending' },
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

    const humanInputs = { 'confirm-cost': { approved: true, approvalRef: 'cost-ok' } };
    const current = await resumeWorkflow(session, first.runId, humanInputs, {
      ...options,
      ...approvalResumeOptions(first),
    });
    expect(current).toMatchObject({ status: 'waiting_for_input', nodeId: 'approve-candidates' });

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

  it('rejects stale approval identity after another tab advances to a new approval request', async () => {
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

    const humanInputs = { 'confirm-cost': { approved: true, approvalRef: 'cost-ok' } };
    const current = await resumeWorkflow(session, first.runId, humanInputs, {
      ...options,
      ...approvalResumeOptions(first),
    });
    expect(current).toMatchObject({
      status: 'waiting_for_input',
      nodeId: 'approve-candidates',
    });

    const stale = await resumeWorkflow(session, first.runId, humanInputs, {
      ...options,
      ...approvalResumeOptions(first),
    });
    expect(stale).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('approval-conflict'),
    });
    await expect(store.load(first.runId)).resolves.toMatchObject({
      approvals: [
        { nodeId: 'confirm-cost', state: 'approved' },
        { nodeId: 'approve-candidates', state: 'pending' },
      ],
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
      { 'confirm-cost': { approved: true } },
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
      { 'confirm-cost': { approved: true } },
      {
        ...options,
        ...approvalResumeOptions(expired),
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

  it('fails closed when production first-party ports are unavailable without fixture success', async () => {
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
      error: expect.stringContaining('no connected first-party production ports'),
    });
    const record = await store.load(result.runId);
    expect(record).toBeUndefined();

    const library = createProductionFirstPartyLibrary();
    const portUnavailableCases = [
      {
        type: 'analysis.silence',
        category: 'analysis',
        failureCode: 'workflow/port-unavailable:analysis.detectSilence',
      },
      {
        type: 'analysis.loudness',
        category: 'analysis',
        failureCode: 'workflow/port-unavailable:analysis.measureLoudness',
      },
      {
        type: 'transform.denoise',
        category: 'transform',
        failureCode: 'workflow/port-unavailable:transform.denoise',
      },
      {
        type: 'transform.normalizeAudio',
        category: 'transform',
        failureCode: 'workflow/port-unavailable:transform.normalizeAudio',
      },
    ] as const;
    for (const portCase of portUnavailableCases) {
      const handler = library.handlers[portCase.type];
      if (handler === undefined) expect.unreachable(`missing handler ${portCase.type}`);
      expect(
        handler({
          node: {
            id: `node-${portCase.type}`,
            category: portCase.category,
            type: portCase.type,
            params: { source: { kind: 'literal', value: { assetId: 'asset-long-1' } } },
            deterministic: true,
          },
          upstream: {},
          workflowInputs: { assetId: 'asset-long-1' },
          attempt: 1,
          runKey: `run-key-${portCase.type}`,
          runId: 'run-production-unavailable',
          projectRevision: 'rev-production',
        }),
      ).toEqual({
        ok: false,
        failureCode: portCase.failureCode,
        retryable: false,
      });
    }
  });

  it('runs the certified reference cutdown through one real durable editor transaction', async () => {
    const storage = memoryStorage();
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      verifiedEditorProject(),
    );
    const store = productionRunStore(storage, session.timelineProject.id);
    const options = {
      productionRunStore: store,
      authority: owner,
      firstPartyLibrary: createEditorSessionFirstPartyLibrary(session),
    } as const;
    const before = session.timelineProject.compositions.root?.tracks[0]?.clips.map((clip) => ({
      id: clip.id,
      startUs: clip.startUs,
      durationUs: clip.durationUs,
    }));

    const parked = await runWorkflow(
      session,
      'joy.first-party.reference-social-cutdown.slice',
      {
        selectedMedia: { assetId: 'asset-intro', mimeType: 'video/mp4', fileBacked: true },
        references: [{ referenceId: 'ref-fast-open' }],
      },
      options,
    );
    expect(parked.status).toBe('waiting_for_input');
    if (parked.status !== 'waiting_for_input') return;
    expect(
      session.timelineProject.compositions.root?.tracks[0]?.clips.map((clip) => clip.id),
    ).toEqual(before?.map((clip) => clip.id));

    const resumed = await resumeWorkflow(
      session,
      parked.runId,
      {
        'approve-cutdown': {
          commands: [
            {
              type: 'timeline.trimClipEnd',
              payload: {
                compositionId: 'root',
                trackId: 'track-0',
                clipId: 'intro',
                newEndUs: 8_000_000,
              },
            },
            {
              type: 'timeline.moveClip',
              payload: {
                compositionId: 'root',
                trackId: 'track-0',
                clipId: 'product',
                newStartUs: 8_000_000,
              },
            },
            {
              type: 'timeline.moveClip',
              payload: {
                compositionId: 'root',
                trackId: 'track-0',
                clipId: 'outro',
                newStartUs: 18_000_000,
              },
            },
          ],
        },
      },
      { ...options, ...approvalResumeOptions(parked) },
    );
    expect(resumed).toMatchObject({ status: 'succeeded' });
    expect(session.timelineProject.compositions.root?.tracks[0]?.clips[0]).toMatchObject({
      id: 'intro',
      startUs: 0,
      durationUs: 8_000_000,
    });
    expect(session.canUndo).toBe(true);

    session.undo();
    expect(session.timelineProject.compositions.root?.tracks[0]?.clips[0]).toMatchObject({
      id: 'intro',
      durationUs: 10_000_000,
    });
    session.redo();
    expect(session.timelineProject.compositions.root?.tracks[0]?.clips[0]).toMatchObject({
      id: 'intro',
      durationUs: 8_000_000,
    });

    const reopened = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      verifiedEditorProject(),
    );
    expect(reopened.timelineProject.compositions.root?.tracks[0]?.clips[0]).toMatchObject({
      id: 'intro',
      durationUs: 8_000_000,
    });
    const reopenedClips = videoClips(reopened);
    const reopenedAssetEvidence = new Map(
      [...new Set(reopenedClips.map((clip) => clip.assetId))].map((assetId) => [
        assetId,
        { state: 'ready' as const, url: `fixture-asset:${assetId}`, mimeType: 'video/mp4' },
      ]),
    );
    const reopenedPreflight = deliveryPreflight({
      channel: 'verified-delivery',
      clips: reopenedClips,
      mediaStates: new Map(
        reopenedClips.map((clip) => [
          clip.id,
          deliveryMediaStateFromEvidence(reopenedAssetEvidence.get(clip.assetId)!),
        ]),
      ),
      capabilities: ['worker-render-export'],
      verifiedRenderEnvelope: envelopeFor(reopened, reopenedClips),
    });
    expect(reopenedPreflight).toEqual({ channel: 'verified-delivery', allowed: true });
    expect(reopenedClips.map((clip) => clip.startUs)).toEqual([0, 8_000_000, 18_000_000]);
    const persisted = await store.load(resumed.runId);
    const transactionOutput = persisted?.checkpoint?.nodes['apply-cutdown']?.output;
    expect(transactionOutput).toMatchObject({
      transactionId: expect.stringMatching(/^editor-tx-/),
    });
    expect(JSON.stringify(transactionOutput)).not.toMatch(
      /local-editor-project|projectRevisionId|projectId/,
    );
  });

  it('rejects an add-track payload before commit and leaves the timeline unchanged', async () => {
    const storage = memoryStorage();
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      verifiedEditorProject(),
    );
    const store = productionRunStore(storage, session.timelineProject.id);
    const options = {
      productionRunStore: store,
      authority: owner,
      firstPartyLibrary: createEditorSessionFirstPartyLibrary(session),
    } as const;
    const before = JSON.stringify(session.timelineProject);
    const parked = await runWorkflow(
      session,
      'joy.first-party.reference-social-cutdown.slice',
      {
        selectedMedia: { assetId: 'asset-intro', mimeType: 'video/mp4', fileBacked: true },
        references: [{ referenceId: 'ref-malicious-track' }],
      },
      options,
    );
    expect(parked.status).toBe('waiting_for_input');
    if (parked.status !== 'waiting_for_input') return;
    const rejected = await resumeWorkflow(
      session,
      parked.runId,
      {
        'approve-cutdown': {
          commands: [
            {
              type: 'timeline.addTrack',
              payload: {
                compositionId: 'root',
                track: {
                  id: 'malicious-track',
                  kind: 'video',
                  order: 9,
                  enabled: true,
                  clips: [
                    {
                      kind: 'video',
                      id: 'malicious-gap',
                      startUs: 1_000_000,
                      durationUs: 1_000_000,
                      assetId: 'asset-intro',
                      sourceInUs: 0,
                      playbackRate: 2,
                    },
                  ],
                },
              },
            },
          ],
        },
      },
      { ...options, ...approvalResumeOptions(parked) },
    );
    expect(rejected.status).toBe('failed');
    expect(JSON.stringify(session.timelineProject)).toBe(before);
    expect(
      session.timelineProject.compositions.root?.tracks.some(
        (track) => track.id === 'malicious-track',
      ),
    ).toBe(false);
  });

  it('fails the certified cutdown when the real editor port is not connected', async () => {
    const storage = memoryStorage();
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const store = productionRunStore(storage, session.timelineProject.id);
    const parked = await runWorkflow(
      session,
      'joy.first-party.reference-social-cutdown.slice',
      {
        selectedMedia: { assetId: 'asset-intro' },
        references: [{ referenceId: 'ref-1' }],
      },
      {
        productionRunStore: store,
        authority: owner,
        firstPartyLibrary: createProductionFirstPartyLibrary(),
      },
    );
    expect(parked.status).toBe('failed');
    if (parked.status !== 'failed') return;
    expect(parked.error).toContain('no connected first-party production ports');
    expect(await store.load(parked.runId)).toBeUndefined();
  });
});

function verifiedEditorProject() {
  return {
    ...INITIAL_EDITOR_PROJECT,
    assets: {},
    visualObjects: {},
    captionDocuments: {},
    compositions: {
      ...INITIAL_EDITOR_PROJECT.compositions,
      root: {
        ...INITIAL_EDITOR_PROJECT.compositions.root!,
        tracks: [],
      },
    },
    audio: { clips: {}, buses: [], effects: [] },
  } as typeof INITIAL_EDITOR_PROJECT;
}

function videoClips(session: EditorSession) {
  const clips = session.timelineProject.compositions.root?.tracks[0]?.clips ?? [];
  return clips
    .filter(
      (clip): clip is Extract<typeof clip, { readonly kind: 'video' }> => clip.kind === 'video',
    )
    .map((clip) => ({
      id: clip.id,
      assetId: clip.assetId,
      durationUs: clip.durationUs,
      startUs: clip.startUs,
      sourceInUs: clip.sourceInUs,
      kind: clip.kind,
      ...(clip.playbackRate === undefined ? {} : { playbackRate: clip.playbackRate }),
    }));
}

function envelopeFor(
  session: EditorSession,
  clips: readonly {
    readonly startUs?: number;
    readonly durationUs: number;
    readonly playbackRate?: number;
  }[],
): VerifiedRenderEnvelope {
  const sorted = [...clips].sort((left, right) => (left.startUs ?? 0) - (right.startUs ?? 0));
  let cursor = 0;
  let nonContiguous = false;
  for (const clip of sorted) {
    if (clip.startUs !== cursor) nonContiguous = true;
    cursor = (clip.startUs ?? 0) + clip.durationUs;
  }
  const visual = session.visualProject;
  return {
    visualObjectCount: Object.keys(visual.visualObjects).length,
    transitionCount: visual.transitions?.length ?? 0,
    captionBurnIn: visual.pluginData['joy.captions.burnIn'] === true,
    audioEffectCount: visual.audio?.effects.length ?? 0,
    audioBusCount: visual.audio?.buses.length ?? 0,
    audioFadeCount: Object.values(visual.audio?.clips ?? {}).filter(
      (clip) => clip.fadeInUs !== undefined || clip.fadeOutUs !== undefined,
    ).length,
    nonContiguous,
    nonOneXPlaybackCount: clips.filter(
      (clip) => clip.playbackRate !== undefined && clip.playbackRate !== 1,
    ).length,
  };
}

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

function approvalResumeOptions(approval: {
  readonly approvalId?: string;
  readonly approvalRequestedSeq?: number;
  readonly approvalExpiresAtSeq?: number;
}) {
  return {
    ...(approval.approvalId === undefined ? {} : { approvalId: approval.approvalId }),
    ...(approval.approvalRequestedSeq === undefined
      ? {}
      : { approvalRequestedSeq: approval.approvalRequestedSeq }),
    ...(approval.approvalExpiresAtSeq === undefined
      ? {}
      : { approvalExpiresAtSeq: approval.approvalExpiresAtSeq }),
  };
}
