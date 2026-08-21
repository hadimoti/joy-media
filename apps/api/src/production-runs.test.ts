import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { PostgresControlPlane } from './postgres-control-plane.js';
import type { ProductionRunAuthority, ProductionRunRecordV1 } from './production-runs.js';

const owner = { id: 'joy-owner' };
const other = { id: 'joy-other' };
const authority: ProductionRunAuthority = {
  principalId: owner.id,
  role: 'owner',
  displayName: 'Joy Owner',
};

describe('Postgres production runs', () => {
  it('persists runs across instances with pagination, actor isolation, event order, and duplicate run-key protection', async () => {
    const { pool, controlPlane } = await initializedControlPlane();
    await controlPlane.createProject(owner, 'project-1', 'Production Project');
    await controlPlane.createProject(other, 'project-2', 'Other Project');

    await expect(
      controlPlane.createProductionRun(owner, 'project-1', {
        runKey: 'run-key-1',
        record: queuedRecord('run-1'),
        authority,
        now: 100,
      }),
    ).resolves.toMatchObject({ runId: 'run-1', state: 'queued', updatedSeq: 1 });
    await controlPlane.createProductionRun(owner, 'project-1', {
      runKey: 'run-key-2',
      record: queuedRecord('run-2'),
      authority,
      now: 101,
    });

    await expect(
      controlPlane.createProductionRun(owner, 'project-1', {
        runKey: 'run-key-1',
        record: queuedRecord('run-duplicate'),
        authority,
      }),
    ).rejects.toMatchObject({ code: 'PRODUCTION_RUN_KEY_EXISTS' });
    const otherAuthority: ProductionRunAuthority = { principalId: other.id, role: 'owner' };
    const otherRecord = queuedRecord('run-other', {
      events: [{ ...queuedRecord('run-other').events[0]!, actor: otherAuthority }],
    });
    await expect(
      controlPlane.createProductionRun(other, 'project-1', {
        runKey: 'run-key-other',
        record: otherRecord,
        authority: otherAuthority,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    const restarted = new PostgresControlPlane(pool, { skipLocked: false });
    const firstPage = await restarted.listProductionRuns(owner, 'project-1', { limit: 1 });
    expect(firstPage).toMatchObject({ runs: [{ runId: 'run-1' }], nextCursor: 'run-1' });
    const cursor = firstPage.nextCursor;
    if (cursor === undefined) expect.unreachable('first page should include a cursor');
    await expect(
      restarted.listProductionRuns(owner, 'project-1', { limit: 1, cursor }),
    ).resolves.toMatchObject({ runs: [{ runId: 'run-2' }] });
    await expect(restarted.getProductionRun(owner, 'project-1', 'run-1')).resolves.toMatchObject({
      runId: 'run-1',
      events: [{ seq: 1, type: 'run.queued' }],
    });

    const unordered = {
      ...queuedRecord('run-unordered'),
      events: [
        { ...queuedRecord('run-unordered').events[0]!, seq: 2 },
        { ...queuedRecord('run-unordered').events[0]!, seq: 1 },
      ],
      updatedSeq: 1,
    };
    await expect(
      restarted.createProductionRun(owner, 'project-1', {
        runKey: 'run-key-unordered',
        record: unordered,
        authority,
      }),
    ).rejects.toMatchObject({ code: 'PRODUCTION_RUN_INVALID' });

    const mixedEventAuthority = queuedRecord('run-mixed-event', {
      events: [
        queuedRecord('run-mixed-event').events[0]!,
        {
          eventVersion: 1,
          seq: 2,
          type: 'run.started',
          state: 'running',
          actor: { principalId: 'reviewer-2', role: 'reviewer' },
          checkpointRevision: 0,
          message: 'started elsewhere',
        },
      ],
      updatedSeq: 2,
    });
    await expect(
      restarted.createProductionRun(owner, 'project-1', {
        runKey: 'run-key-mixed-event',
        record: mixedEventAuthority,
        authority,
      }),
    ).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });

    const mixedApprovalAuthority = parkedRecord('run-mixed-approval', 'approval-mixed');
    const approval = mixedApprovalAuthority.approvals[0];
    if (approval === undefined) expect.unreachable('parked fixture should include an approval');
    await expect(
      restarted.createProductionRun(owner, 'project-1', {
        runKey: 'run-key-mixed-approval',
        record: {
          ...mixedApprovalAuthority,
          approvals: [
            {
              ...approval,
              authority: { principalId: 'reviewer-2', role: 'reviewer' },
            },
          ],
        },
        authority,
      }),
    ).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });

    await pool.end();
  });

  it('applies approval responses idempotently while rejecting stale, wrong, and expired approvals', async () => {
    const { pool, controlPlane } = await initializedControlPlane();
    await controlPlane.createProject(owner, 'project-approval', 'Approvals');
    const parked = parkedRecord('run-approval', 'approval-1');
    await controlPlane.createProductionRun(owner, 'project-approval', {
      runKey: 'run-key-approval',
      record: parked,
      authority,
      approvalExpiresAt: 1_000,
      now: 100,
    });

    await expect(
      controlPlane.respondToProductionApproval(owner, 'project-approval', 'run-approval', {
        approvalId: 'approval-missing',
        approved: true,
        responseRef: 'response-missing',
        authority,
        now: 200,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });

    await expect(
      controlPlane.respondToProductionApproval(owner, 'project-approval', 'run-approval', {
        approvalId: 'approval-1',
        approved: true,
        responseRef: 'response-expired',
        authority,
        now: 1_001,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });

    const applied = await controlPlane.respondToProductionApproval(
      owner,
      'project-approval',
      'run-approval',
      {
        approvalId: 'approval-1',
        approved: true,
        responseRef: 'response-1',
        response: { approved: [{ assetId: 'asset-1' }] },
        authority,
        expectedUpdatedSeq: 2,
        now: 500,
      },
    );
    expect(applied).toMatchObject({
      duplicate: false,
      record: {
        updatedSeq: 3,
        approvals: [
          {
            state: 'approved',
            responseRef: 'response-1',
            respondedSeq: 3,
            response: { approved: [{ assetId: 'asset-1' }] },
          },
        ],
        events: [
          { seq: 1, type: 'run.parked' },
          { seq: 2, type: 'approval.requested' },
          { seq: 3, type: 'approval.responded' },
        ],
      },
    });
    expect(JSON.stringify(applied.record)).not.toContain('private');

    await expect(
      controlPlane.respondToProductionApproval(owner, 'project-approval', 'run-approval', {
        approvalId: 'approval-1',
        approved: true,
        responseRef: 'response-1',
        response: { approved: [{ assetId: 'asset-1' }] },
        authority,
        expectedUpdatedSeq: 2,
        now: 501,
      }),
    ).resolves.toMatchObject({ duplicate: true, record: { updatedSeq: 3 } });
    await expect(
      controlPlane.respondToProductionApproval(owner, 'project-approval', 'run-approval', {
        approvalId: 'approval-1',
        approved: true,
        responseRef: 'response-1',
        response: { approved: [{ assetId: 'asset-1' }] },
        authority,
        now: 502,
      }),
    ).resolves.toMatchObject({ duplicate: true, record: { updatedSeq: 3 } });
    await expect(
      controlPlane.respondToProductionApproval(owner, 'project-approval', 'run-approval', {
        approvalId: 'approval-1',
        approved: true,
        responseRef: 'response-1',
        response: { approved: [{ nested: { z: 2, a: 1 }, assetId: 'asset-1' }] },
        authority,
        now: 502,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
    await expect(
      controlPlane.respondToProductionApproval(owner, 'project-approval', 'run-approval', {
        approvalId: 'approval-1',
        approved: true,
        responseRef: 'response-role-mismatch',
        authority: { principalId: owner.id, role: 'reviewer' },
        now: 502,
      }),
    ).rejects.toMatchObject({ code: 'AUTHORITY_INVALID' });
    await expect(
      controlPlane.respondToProductionApproval(owner, 'project-approval', 'run-approval', {
        approvalId: 'approval-1',
        approved: false,
        responseRef: 'response-2',
        response: { approved: false },
        rejectionReason: 'Needs a safer ending',
        authority,
        now: 503,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });

    await pool.end();
  });

  it('treats reordered response object keys as a duplicate API approval', async () => {
    const { pool, controlPlane } = await initializedControlPlane();
    await controlPlane.createProject(owner, 'project-approval-reordered', 'Approvals');
    const parked = parkedRecord('run-approval-reordered', 'approval-1');
    await controlPlane.createProductionRun(owner, 'project-approval-reordered', {
      runKey: 'run-key-approval-reordered',
      record: parked,
      authority,
      now: 100,
    });

    await expect(
      controlPlane.respondToProductionApproval(
        owner,
        'project-approval-reordered',
        'run-approval-reordered',
        {
          approvalId: 'approval-1',
          approved: true,
          responseRef: 'response-reordered',
          response: { approved: true, nested: { a: 1, b: 2 } },
          authority,
          now: 500,
        },
      ),
    ).resolves.toMatchObject({ duplicate: false, record: { updatedSeq: 3 } });

    await expect(
      controlPlane.respondToProductionApproval(
        owner,
        'project-approval-reordered',
        'run-approval-reordered',
        {
          approvalId: 'approval-1',
          approved: true,
          responseRef: 'response-reordered',
          response: { nested: { b: 2, a: 1 }, approved: true },
          authority,
          now: 501,
        },
      ),
    ).resolves.toMatchObject({ duplicate: true, record: { updatedSeq: 3 } });

    await pool.end();
  });

  it('matches JSON serialization semantics for undefined and omitted API response values', async () => {
    const { pool, controlPlane } = await initializedControlPlane();
    await controlPlane.createProject(owner, 'project-approval-json-semantics', 'Approvals');
    const parked = parkedRecord('run-approval-json-semantics', 'approval-1');
    await controlPlane.createProductionRun(owner, 'project-approval-json-semantics', {
      runKey: 'run-key-approval-json-semantics',
      record: parked,
      authority,
      now: 100,
    });

    await expect(
      controlPlane.respondToProductionApproval(
        owner,
        'project-approval-json-semantics',
        'run-approval-json-semantics',
        {
          approvalId: 'approval-1',
          approved: true,
          responseRef: 'response-json-semantics',
          response: { keep: 1, omit: undefined, list: [undefined, 2] },
          authority,
          now: 500,
        },
      ),
    ).resolves.toMatchObject({ duplicate: false, record: { updatedSeq: 3 } });

    await expect(
      controlPlane.respondToProductionApproval(
        owner,
        'project-approval-json-semantics',
        'run-approval-json-semantics',
        {
          approvalId: 'approval-1',
          approved: true,
          responseRef: 'response-json-semantics',
          response: { list: [null, 2], keep: 1 },
          authority,
          now: 501,
        },
      ),
    ).resolves.toMatchObject({ duplicate: true, record: { updatedSeq: 3 } });

    await pool.end();
  });

  it('cancels with optimistic revisions and rejects private paths, raw media, and oversized logs', async () => {
    const { pool, controlPlane } = await initializedControlPlane();
    await controlPlane.createProject(owner, 'project-cancel', 'Cancellation');
    await controlPlane.createProductionRun(owner, 'project-cancel', {
      runKey: 'run-key-cancel',
      record: queuedRecord('run-cancel'),
      authority,
    });

    await expect(
      controlPlane.cancelProductionRun(owner, 'project-cancel', 'run-cancel', {
        authority,
        expectedUpdatedSeq: 2,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(
      controlPlane.cancelProductionRun(owner, 'project-cancel', 'run-cancel', {
        authority,
        expectedUpdatedSeq: 1,
        now: 700,
      }),
    ).resolves.toMatchObject({
      state: 'canceled',
      updatedSeq: 2,
      events: [
        { seq: 1, type: 'run.queued' },
        { seq: 2, type: 'run.canceled' },
      ],
    });

    const withPath = queuedRecord('run-path', {
      nodes: [
        {
          ...nodeProjection('node-1'),
          logs: [
            {
              seq: 1,
              nodeId: 'node-1',
              attempt: 1,
              level: 'info',
              message: 'C:\\private\\final.mp4',
            },
          ],
        },
      ],
    });
    await expect(
      controlPlane.createProductionRun(owner, 'project-cancel', {
        runKey: 'run-key-path',
        record: withPath,
        authority,
      }),
    ).rejects.toMatchObject({ code: 'PRODUCTION_RUN_INVALID' });

    const withFileUrl = queuedRecord('run-file-url', {
      nodes: [
        {
          ...nodeProjection('node-1'),
          logs: [
            {
              seq: 1,
              nodeId: 'node-1',
              attempt: 1,
              level: 'info',
              message: 'file:///Users/private/final.mp4',
            },
          ],
        },
      ],
    });
    await expect(
      controlPlane.createProductionRun(owner, 'project-cancel', {
        runKey: 'run-key-file-url',
        record: withFileUrl,
        authority,
      }),
    ).rejects.toMatchObject({ code: 'PRODUCTION_RUN_INVALID' });

    const withUnixPath = queuedRecord('run-unix-path', {
      nodes: [
        {
          ...nodeProjection('node-1'),
          logs: [
            {
              seq: 1,
              nodeId: 'node-1',
              attempt: 1,
              level: 'info',
              message: '/private/tmp/final.mp4',
            },
          ],
        },
      ],
    });
    await expect(
      controlPlane.createProductionRun(owner, 'project-cancel', {
        runKey: 'run-key-unix-path',
        record: withUnixPath,
        authority,
      }),
    ).rejects.toMatchObject({ code: 'PRODUCTION_RUN_INVALID' });

    const withRawMedia = {
      ...queuedRecord('run-raw'),
      checkpoint: { mediaBase64: 'AAAA' },
    };
    await expect(
      controlPlane.createProductionRun(owner, 'project-cancel', {
        runKey: 'run-key-raw',
        record: withRawMedia,
        authority,
      }),
    ).rejects.toMatchObject({ code: 'PRODUCTION_RUN_INVALID' });

    const withNestedRawMedia = queuedRecord('run-nested-raw', {
      checkpoint: {
        review: {
          opaqueToken: 'QUJD/'.repeat(32),
        },
      },
    });
    await expect(
      controlPlane.createProductionRun(owner, 'project-cancel', {
        runKey: 'run-key-nested-raw',
        record: withNestedRawMedia,
        authority,
      }),
    ).rejects.toMatchObject({ code: 'PRODUCTION_RUN_INVALID' });

    const withNestedAlnumRawMedia = queuedRecord('run-nested-alnum-raw', {
      checkpoint: {
        review: {
          opaqueToken: 'A'.repeat(128),
        },
      },
    });
    await expect(
      controlPlane.createProductionRun(owner, 'project-cancel', {
        runKey: 'run-key-nested-alnum-raw',
        record: withNestedAlnumRawMedia,
        authority,
      }),
    ).rejects.toMatchObject({ code: 'PRODUCTION_RUN_INVALID' });

    const withRawMediaLog = queuedRecord('run-raw-log', {
      nodes: [
        {
          ...nodeProjection('node-1'),
          logs: [
            {
              seq: 1,
              nodeId: 'node-1',
              attempt: 1,
              level: 'info',
              message: 'QUJD/'.repeat(32),
            },
          ],
        },
      ],
    });
    await expect(
      controlPlane.createProductionRun(owner, 'project-cancel', {
        runKey: 'run-key-raw-log',
        record: withRawMediaLog,
        authority,
      }),
    ).rejects.toMatchObject({ code: 'PRODUCTION_RUN_INVALID' });

    const withLargeLog = queuedRecord('run-log', {
      nodes: [
        {
          ...nodeProjection('node-1'),
          logs: [
            { seq: 1, nodeId: 'node-1', attempt: 1, level: 'info', message: 'x'.repeat(1_001) },
          ],
        },
      ],
    });
    await expect(
      controlPlane.createProductionRun(owner, 'project-cancel', {
        runKey: 'run-key-log',
        record: withLargeLog,
        authority,
      }),
    ).rejects.toMatchObject({ code: 'PRODUCTION_RUN_INVALID' });

    await pool.end();
  });
});

async function initializedControlPlane(): Promise<{
  readonly pool: Pool;
  readonly controlPlane: PostgresControlPlane;
}> {
  const database = newDb();
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool() as Pool;
  const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
  await controlPlane.initialize();
  return { pool, controlPlane };
}

function queuedRecord(
  runId: string,
  overrides: Partial<ProductionRunRecordV1> = {},
): ProductionRunRecordV1 {
  return {
    recordVersion: 1,
    runId,
    workflowId: 'wf-production',
    workflowVersion: '1.0.0',
    projectRevision: 'rev-1',
    state: 'queued',
    checkpointRevision: 0,
    links: {},
    events: [
      {
        eventVersion: 1,
        seq: 1,
        type: 'run.queued',
        state: 'queued',
        actor: authority,
        checkpointRevision: 0,
        message: 'production run queued',
      },
    ],
    approvals: [],
    nodes: [],
    createdSeq: 1,
    updatedSeq: 1,
    ...overrides,
  };
}

function parkedRecord(runId: string, approvalId: string): ProductionRunRecordV1 {
  return queuedRecord(runId, {
    state: 'parked',
    checkpointRevision: 1,
    checkpoint: {
      checkpointVersion: 1,
      runId,
      workflowId: 'wf-production',
      workflowVersion: '1.0.0',
      projectRevision: 'rev-1',
      state: 'waiting_for_input',
      nodes: {
        review: {
          runKey: 'review-key',
          state: 'waiting_for_input',
          attempts: 1,
          deterministic: false,
          pendingRequest: { kind: 'approve-render', prompt: 'Approve final?' },
        },
      },
    },
    events: [
      {
        eventVersion: 1,
        seq: 1,
        type: 'run.parked',
        state: 'parked',
        actor: authority,
        checkpointRevision: 1,
        message: 'production run parked',
      },
      {
        eventVersion: 1,
        seq: 2,
        type: 'approval.requested',
        state: 'parked',
        nodeId: 'review',
        approvalId,
        checkpointRevision: 1,
        message: 'approve-render',
      },
    ],
    approvals: [
      {
        approvalVersion: 1,
        approvalId,
        nodeId: 'review',
        kind: 'approve-render',
        prompt: 'Approve final?',
        requestPayload: { diffRef: 'asset-diff-1' },
        state: 'pending',
        requestedSeq: 2,
      },
    ],
    nodes: [{ ...nodeProjection('review'), pendingApprovalId: approvalId }],
    updatedSeq: 2,
  });
}

function nodeProjection(nodeId: string): ProductionRunRecordV1['nodes'][number] {
  return {
    nodeId,
    type: 'render.review',
    category: 'review',
    state: 'waiting_for_input',
    attempts: 1,
    deterministic: false,
    reused: false,
    logs: [],
    artifactIds: [],
  };
}
