import { describe, expect, it } from 'vitest';
import type { ArtifactStore } from '@joy-media/commands';
import type { ProductionRunRecordV1 } from '@joy-media/workflow-engine';
import {
  buildProductionBoardModel,
  productionBoardNextRunId,
  productionBoardPrimaryRunId,
} from './production-board-model.js';

const artifacts: ArtifactStore = {
  artifacts: {
    'artifact-scene-1': {
      id: 'artifact-scene-1',
      kind: 'generatedMedia',
      schemaVersion: 1,
      revision: 2,
      label: 'Opening b-roll',
      contentRef: { type: 'asset', assetId: 'asset-video-1' },
      binding: { type: 'range', startUs: 0, durationUs: 2_000_000 },
      provenance: {
        sourceArtifactIds: [],
        inputHashes: ['hash-1'],
        createdBy: { type: 'agent', id: 'joy-code' },
        workflowNodeId: 'asset-broll',
        jobId: 'job-1',
        providerId: 'runway',
        modelId: 'gen-3',
        cost: { amount: '0.42', currency: 'USD' },
      },
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:01:00.000Z',
    },
  },
  versions: {},
};

describe('production board model', () => {
  it('returns an empty projection when no production runs exist', () => {
    const model = buildProductionBoardModel({
      records: [],
      currentProjectRevision: 'rev-1',
      artifacts,
      dataLanes: [],
    });

    expect(model.isEmpty).toBe(true);
    expect(model.groups).toEqual([]);
  });

  it('groups runs by production status and keeps events sequenced', () => {
    const model = buildProductionBoardModel({
      records: [
        run({ runId: 'failed-run', state: 'failed', updatedSeq: 4 }),
        run({ runId: 'parked-run', state: 'parked', updatedSeq: 8 }),
      ],
      currentProjectRevision: 'rev-1',
      artifacts,
      dataLanes: [],
    });

    expect(model.counts).toMatchObject({ parked: 1, failed: 1 });
    expect(model.groups.map((group) => group.state)).toEqual(['parked', 'failed']);
    expect(model.runs[0]?.runId).toBe('parked-run');
    expect(model.runs[0]?.sections.events.items.map((event) => event.title)).toEqual([
      '001 · run.queued',
      '008 · run.parked',
    ]);
  });

  it('projects board sections, artifact links, provider links, report links, data lanes, and authority badges', () => {
    const model = buildProductionBoardModel({
      records: [
        run({
          state: 'parked',
          links: {
            jobId: 'job-1',
            providerRunId: 'provider-run-1',
            reportId: 'report-1',
            artifactIds: ['artifact-scene-1'],
          },
          approvals: [
            {
              approvalVersion: 1,
              approvalId: 'approval-1',
              nodeId: 'scene-candidates',
              kind: 'choose-candidates',
              prompt: 'Pick two scenes',
              state: 'pending',
              requestedSeq: 2,
            },
          ],
          nodes: [
            node({
              nodeId: 'scene-candidates',
              type: 'scene.candidates',
              category: 'scene',
              state: 'waiting_for_input',
              pendingApprovalId: 'approval-1',
            }),
            node({
              nodeId: 'asset-broll',
              type: 'media.broll',
              category: 'asset',
              state: 'succeeded',
              artifactIds: ['artifact-scene-1'],
            }),
            node({
              nodeId: 'delivery-qa',
              type: 'render.inspect',
              category: 'qa',
              state: 'succeeded',
            }),
          ],
        }),
      ],
      currentProjectRevision: 'rev-1',
      artifacts,
      dataLanes: [
        {
          id: 'lane:generation',
          kind: 'generation',
          label: 'Generated',
          items: [
            {
              id: 'artifact:artifact-scene-1',
              label: 'Opening b-roll',
              kind: 'generation',
              artifactId: 'artifact-scene-1',
              versionCount: 0,
              pinned: false,
              stale: false,
              detail: 'rev 2',
            },
          ],
        },
      ],
      assets: [
        {
          id: 'asset-video-1',
          projectId: 'project-1',
          kind: 'video',
          displayName: 'opening.mov',
          sha256: 'a'.repeat(64),
          bytes: 123,
          descriptor: { mimeType: 'video/quicktime' },
          createdAt: 1,
        },
      ],
    });

    const projected = model.runs[0]!;
    expect(projected.authorityBadge).toBe('Producer · owner');
    expect(projected.sections.brief.items[0]?.detail).toContain('topic');
    expect(projected.sections.scenes.items).toHaveLength(1);
    expect(projected.sections.assets.items).toHaveLength(1);
    expect(projected.sections.qa.items).toHaveLength(1);
    expect(projected.sections.approvals.items[0]).toMatchObject({
      title: 'Pick two scenes',
      state: 'pending',
    });
    expect(projected.sections.jobs.items.map((item) => item.detail).join(' ')).toContain(
      '0.42 USD',
    );
    expect(projected.links.map((link) => `${link.kind}:${link.id}`)).toEqual([
      'job:job-1',
      'provider:provider-run-1',
      'report:report-1',
      'asset:asset-video-1',
      'artifact:artifact-scene-1',
      'data-lane:artifact:artifact-scene-1',
    ]);
  });

  it('models approval, retry, cancel, and stale-revision conflict availability', () => {
    const parked = buildProductionBoardModel({
      records: [
        run({
          state: 'parked',
          approvals: [
            {
              approvalVersion: 1,
              approvalId: 'approval-1',
              nodeId: 'n1',
              kind: 'approve-render',
              prompt: 'Approve render',
              state: 'pending',
              requestedSeq: 2,
            },
          ],
        }),
      ],
      currentProjectRevision: 'rev-1',
      artifacts,
      dataLanes: [],
    }).runs[0]!;

    expect(parked.actions).toMatchObject({
      canApprove: true,
      canReject: true,
      canCancel: true,
      canRetry: false,
    });

    const failed = buildProductionBoardModel({
      records: [run({ state: 'failed' })],
      currentProjectRevision: 'rev-1',
      artifacts,
      dataLanes: [],
    }).runs[0]!;
    expect(failed.actions).toMatchObject({ canRetry: true, canCancel: false });

    const stale = buildProductionBoardModel({
      records: [run({ state: 'parked', projectRevision: 'old-rev' })],
      currentProjectRevision: 'rev-1',
      artifacts,
      dataLanes: [],
    }).runs[0]!;
    expect(stale.staleRevisionConflict).toBe(true);
    expect(stale.actions).toMatchObject({
      canApprove: false,
      canReject: false,
      canCancel: false,
    });
    expect(stale.actions.disabledReason).toContain('Project revision changed');
  });

  it('supports keyboard-style run selection helpers', () => {
    const runs = [{ runId: 'a' }, { runId: 'b' }, { runId: 'c' }];

    expect(productionBoardPrimaryRunId({ runs }, 'b')).toBe('b');
    expect(productionBoardPrimaryRunId({ runs }, 'missing')).toBe('a');
    expect(productionBoardNextRunId(runs, 'a', 'next')).toBe('b');
    expect(productionBoardNextRunId(runs, 'a', 'previous')).toBe('c');
  });
});

function run(overrides: Partial<ProductionRunRecordV1> = {}): ProductionRunRecordV1 {
  const state = overrides.state ?? 'running';
  const updatedSeq = overrides.updatedSeq ?? 2;
  return {
    recordVersion: 1,
    runId: 'run-1',
    workflowId: 'joy.workflow.production',
    workflowVersion: '1.0.0',
    projectRevision: 'rev-1',
    state,
    checkpointRevision: 1,
    workflowInputs: { topic: 'summer campaign', duration: 15 },
    links: {},
    events: [
      {
        eventVersion: 1,
        seq: 1,
        type: 'run.queued',
        state: 'queued',
        checkpointRevision: 0,
        actor: { principalId: 'owner-1', role: 'owner', displayName: 'Producer' },
        message: 'queued',
      },
      {
        eventVersion: 1,
        seq: updatedSeq,
        type:
          state === 'failed'
            ? 'run.failed'
            : state === 'parked'
              ? 'run.parked'
              : 'run.checkpointed',
        state,
        checkpointRevision: 1,
        message: state,
      },
    ],
    approvals: [],
    nodes: [],
    createdSeq: 1,
    updatedSeq,
    ...overrides,
  };
}

function node(
  overrides: Partial<ProductionRunRecordV1['nodes'][number]> &
    Pick<ProductionRunRecordV1['nodes'][number], 'nodeId' | 'type' | 'category' | 'state'>,
): ProductionRunRecordV1['nodes'][number] {
  return {
    attempts: 1,
    deterministic: true,
    reused: false,
    logs: [],
    artifactIds: [],
    ...overrides,
  };
}
