import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ArtifactStore } from '@joy-media/commands';
import type { ProductionRunRecordV1 } from '@joy-media/workflow-engine';
import { loadProductionBoardRecords, ProductionBoardPanelView } from './ProductionBoardPanel.js';
import { buildProductionBoardModel } from './production-board-model.js';

const emptyArtifacts: ArtifactStore = { artifacts: {}, versions: {} };

describe('ProductionBoardPanel', () => {
  it('renders loading, error, and empty states', () => {
    expect(renderToStaticMarkup(<ProductionBoardPanelView loadState="loading" />)).toContain(
      'Loading runs',
    );
    expect(
      renderToStaticMarkup(
        <ProductionBoardPanelView loadState="error" errorMessage="network down" />,
      ),
    ).toContain('Production Board unavailable: network down');
    expect(
      renderToStaticMarkup(
        <ProductionBoardPanelView
          loadState="loaded"
          model={buildProductionBoardModel({
            records: [],
            currentProjectRevision: 'rev-1',
            artifacts: emptyArtifacts,
            dataLanes: [],
          })}
        />,
      ),
    ).toContain('Start a Workflow');
  });

  it('renders status groups, authority badge, sections, and action availability', () => {
    const model = buildProductionBoardModel({
      records: [
        run({
          state: 'parked',
          approvals: [
            {
              approvalVersion: 1,
              approvalId: 'approval-1',
              nodeId: 'scene-candidates',
              kind: 'choose-candidates',
              prompt: 'Choose candidates',
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
          ],
        }),
      ],
      currentProjectRevision: 'rev-1',
      artifacts: emptyArtifacts,
      dataLanes: [],
    });

    const markup = renderToStaticMarkup(
      <ProductionBoardPanelView loadState="loaded" model={model} retryAvailable />,
    );

    expect(markup).toContain('Needs review');
    expect(markup).toContain('Producer · owner');
    expect(markup).toContain('Brief/Input');
    expect(markup).toContain('Approve');
    expect(markup).toContain('>Approve</button>');
    expect(markup).toContain('>Reject</button>');
    expect(markup).toContain('disabled=""><svg');
  });

  it('renders stale revision conflicts and artifact/provider/report links', () => {
    const artifacts: ArtifactStore = {
      artifacts: {
        'artifact-1': {
          id: 'artifact-1',
          kind: 'renderOutput',
          schemaVersion: 1,
          revision: 1,
          label: 'Verified delivery',
          contentRef: { type: 'asset', assetId: 'asset-1' },
          binding: { type: 'none' },
          provenance: {
            sourceArtifactIds: [],
            inputHashes: [],
            createdBy: { type: 'agent', id: 'joy-code' },
            workflowNodeId: 'delivery-qa',
          },
          createdAt: '2026-08-22T00:00:00.000Z',
          updatedAt: '2026-08-22T00:00:00.000Z',
        },
      },
      versions: {},
    };
    const model = buildProductionBoardModel({
      records: [
        run({
          projectRevision: 'old-rev',
          links: {
            providerRunId: 'provider-1',
            reportId: 'report-1',
            artifactIds: ['artifact-1'],
          },
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
              id: 'artifact:artifact-1',
              label: 'Verified delivery',
              kind: 'generation',
              artifactId: 'artifact-1',
              versionCount: 0,
              pinned: false,
              stale: true,
              detail: 'rev 1',
            },
          ],
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <ProductionBoardPanelView loadState="loaded" model={model} />,
    );

    expect(markup).toContain('Stale project revision');
    expect(markup).toContain('Project revision changed since this run parked');
    expect(markup).toContain('Provider provider-1');
    expect(markup).toContain('Report report-1');
    expect(markup).toContain('Artifact Verified delivery');
    expect(markup).toContain('Generated lane');
  });

  it('loads every paged store result before applying newest-updated ordering', async () => {
    const records = Array.from({ length: 101 }, (_, index) =>
      run({
        runId: `run-${String(index + 1).padStart(3, '0')}`,
        createdSeq: index + 1,
        updatedSeq: index + 1,
      }),
    );
    const newest = run({
      runId: 'newest-second-page',
      createdSeq: 102,
      updatedSeq: 10_000,
      state: 'running',
    });
    const pagedRecords = [...records, newest];

    const loaded = await loadProductionBoardRecords({
      async list(options = {}) {
        const limit = options.limit ?? 25;
        const offset = options.cursor === undefined ? 0 : Number(options.cursor);
        const runs = pagedRecords.slice(offset, offset + limit);
        const nextOffset = offset + runs.length;
        return {
          runs,
          ...(nextOffset < pagedRecords.length ? { nextCursor: String(nextOffset) } : {}),
        };
      },
    });
    const model = buildProductionBoardModel({
      records: loaded,
      currentProjectRevision: 'rev-1',
      artifacts: emptyArtifacts,
      dataLanes: [],
    });

    expect(loaded).toHaveLength(102);
    expect(model.runs[0]?.runId).toBe('newest-second-page');
  });
});

function run(overrides: Partial<ProductionRunRecordV1> = {}): ProductionRunRecordV1 {
  const state = overrides.state ?? 'parked';
  return {
    recordVersion: 1,
    runId: 'run-1',
    workflowId: 'joy.workflow.production',
    workflowVersion: '1.0.0',
    projectRevision: 'rev-1',
    state,
    checkpointRevision: 1,
    workflowInputs: { brief: 'make a short' },
    links: {},
    events: [
      {
        eventVersion: 1,
        seq: 1,
        type: 'run.queued',
        state: 'queued',
        checkpointRevision: 0,
        actor: { principalId: 'owner-1', role: 'owner', displayName: 'Producer' },
      },
      {
        eventVersion: 1,
        seq: 2,
        type: 'run.parked',
        state,
        checkpointRevision: 1,
      },
    ],
    approvals: [],
    nodes: [],
    createdSeq: 1,
    updatedSeq: 2,
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
