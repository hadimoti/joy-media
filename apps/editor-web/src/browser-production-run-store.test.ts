import { describe, expect, it } from 'vitest';
import {
  createProductionRunRecordFromDashboard,
  createQueuedProductionRunRecord,
  type ProductionRunAuthority,
  type ProductionRunRecordV1,
  type RunDashboard,
  type RunCheckpoint,
} from '@joy-media/workflow-engine';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import { BrowserProductionRunStore } from './browser-production-run-store.js';

const owner: ProductionRunAuthority = {
  principalId: 'owner-1',
  role: 'owner',
  displayName: 'Owner One',
};

const reviewer: ProductionRunAuthority = {
  principalId: 'reviewer-1',
  role: 'reviewer',
  displayName: 'Reviewer One',
};

describe('BrowserProductionRunStore', () => {
  it('reopens explicitly local/offline records without contacting or merging API history', async () => {
    const storage = memoryStorage();
    const first = new BrowserProductionRunStore(storage, {
      projectId: 'project-a',
      authority: owner,
    });
    const record = queuedRecord('run-1');

    await first.createLocalRun(record, { runKey: 'offline-key-1' });

    const reopened = new BrowserProductionRunStore(storage, {
      projectId: 'project-a',
      authority: owner,
    });
    await expect(reopened.load('run-1')).resolves.toMatchObject({
      runId: 'run-1',
      state: 'queued',
      events: [{ type: 'run.queued', actor: owner }],
    });
    await expect(reopened.list({ limit: 10 })).resolves.toMatchObject({
      runs: [{ runId: 'run-1' }],
    });
    expect(JSON.stringify(storage.values())).not.toContain('/v1/projects');
  });

  it('paginates lists and isolates local histories by project and actor', async () => {
    const storage = memoryStorage();
    const projectAOwner = new BrowserProductionRunStore(storage, {
      projectId: 'project-a',
      authority: owner,
    });
    await projectAOwner.create(queuedRecord('run-a-1'));
    await projectAOwner.create(queuedRecord('run-a-2'));
    await projectAOwner.create(queuedRecord('run-a-3'));

    const firstPage = await projectAOwner.list({ limit: 2 });
    expect(firstPage.runs.map((run) => run.runId)).toEqual(['run-a-1', 'run-a-2']);
    expect(firstPage.nextCursor).toBe('2');
    if (firstPage.nextCursor === undefined) expect.unreachable('first page should have a cursor');
    const secondPage = await projectAOwner.list({ limit: 2, cursor: firstPage.nextCursor });
    expect(secondPage.runs.map((run) => run.runId)).toEqual(['run-a-3']);
    expect(secondPage.nextCursor).toBeUndefined();

    const projectBOwner = new BrowserProductionRunStore(storage, {
      projectId: 'project-b',
      authority: owner,
    });
    const projectAReviewer = new BrowserProductionRunStore(storage, {
      projectId: 'project-a',
      authority: reviewer,
    });
    await expect(projectBOwner.load('run-a-1')).resolves.toBeUndefined();
    await expect(projectAReviewer.load('run-a-1')).resolves.toBeUndefined();
  });

  it('rejects non-monotonic event histories and reports checkpoint revision conflicts', async () => {
    const store = new BrowserProductionRunStore(memoryStorage(), {
      projectId: 'project-a',
      authority: owner,
    });
    const record = queuedRecord('run-1');
    const firstEvent = record.events[0];
    if (firstEvent === undefined) expect.unreachable('queued fixture should include an event');
    const invalidEvents = [
      firstEvent,
      { ...firstEvent, seq: 1, type: 'run.started' as const, state: 'running' as const },
    ];

    await expect(store.create({ ...record, events: invalidEvents })).rejects.toThrow(
      'strictly monotonic',
    );
    await store.create(record);

    await expect(
      store.compareAndSwapCheckpoint({
        runId: 'run-1',
        expectedRevision: 1,
        checkpoint: checkpoint('run-1', 'succeeded'),
        authority: owner,
      }),
    ).resolves.toEqual({ ok: false, reason: 'revision-conflict', currentRevision: 0 });

    const result = await store.compareAndSwapCheckpoint({
      runId: 'run-1',
      expectedRevision: 0,
      checkpoint: checkpoint('run-1', 'succeeded'),
      authority: owner,
    });
    expect(result).toMatchObject({
      ok: true,
      record: { checkpointRevision: 1, state: 'succeeded' },
    });
    if (result.ok) {
      expect(result.record.events.map((event) => event.seq)).toEqual([1, 2]);
      expect(result.record.events[1]).toMatchObject({
        type: 'run.succeeded',
        actor: owner,
        checkpointRevision: 1,
      });
    }
  });

  it('rejects duplicate local run ids and duplicate local run keys', async () => {
    const store = new BrowserProductionRunStore(memoryStorage(), {
      projectId: 'project-a',
      authority: owner,
    });
    await store.createLocalRun(queuedRecord('run-1'), { runKey: 'same-key' });

    await expect(store.createLocalRun(queuedRecord('run-1'))).rejects.toThrow(
      'PRODUCTION_RUN_EXISTS',
    );
    await expect(
      store.createLocalRun(queuedRecord('run-2'), { runKey: 'same-key' }),
    ).rejects.toThrow('PRODUCTION_RUN_KEY_EXISTS');
  });

  it('rejects wrong or expired approvals, records rejections, and treats exact duplicates as idempotent', async () => {
    const store = new BrowserProductionRunStore(memoryStorage(), {
      projectId: 'project-a',
      authority: owner,
    });
    const record = parkedRecord('run-1');
    const approval = record.approvals[0];
    if (approval === undefined) expect.unreachable('fixture should include one approval');
    await store.create(record);

    await expect(
      store.respondToApproval('run-1', {
        approvalId: approval.approvalId,
        approved: true,
        responseRef: 'decision:yes',
        authority: owner,
        expectedRequestedSeq: approval.requestedSeq + 1,
      }),
    ).resolves.toEqual({ ok: false, reason: 'approval-conflict' });
    await expect(
      store.respondToApproval('run-1', {
        approvalId: approval.approvalId,
        approved: true,
        responseRef: 'decision:yes',
        authority: owner,
        expiresAtSeq: approval.requestedSeq - 1,
      }),
    ).resolves.toEqual({ ok: false, reason: 'approval-expired' });

    const rejection = await store.respondToApproval('run-1', {
      approvalId: approval.approvalId,
      approved: false,
      responseRef: 'decision:no',
      authority: owner,
      expectedRequestedSeq: approval.requestedSeq,
    });
    expect(rejection).toMatchObject({
      ok: true,
      duplicate: false,
      record: {
        approvals: [{ state: 'rejected', responseRef: 'decision:no', authority: owner }],
      },
    });
    await expect(
      store.respondToApproval('run-1', {
        approvalId: approval.approvalId,
        approved: false,
        responseRef: 'decision:no',
        authority: owner,
      }),
    ).resolves.toMatchObject({ ok: true, duplicate: true });
    await expect(
      store.respondToApproval('run-1', {
        approvalId: approval.approvalId,
        approved: true,
        responseRef: 'decision:yes',
        authority: owner,
      }),
    ).resolves.toEqual({ ok: false, reason: 'approval-conflict' });
  });

  it('cancels local runs with actor and revision checks', async () => {
    const store = new BrowserProductionRunStore(memoryStorage(), {
      projectId: 'project-a',
      authority: owner,
    });
    await store.create(queuedRecord('run-1'));

    await expect(store.cancel('run-1', { authority: owner, expectedRevision: 1 })).resolves.toEqual(
      { ok: false, reason: 'revision-conflict', currentRevision: 0 },
    );

    const canceled = await store.cancel('run-1', { authority: owner, expectedRevision: 0 });
    expect(canceled).toMatchObject({
      ok: true,
      record: { state: 'canceled', events: [{ seq: 1 }, { seq: 2, type: 'run.canceled' }] },
    });
  });

  it('rejects local paths, raw media payloads, and oversized public logs', async () => {
    const store = new BrowserProductionRunStore(
      memoryStorage(),
      { projectId: 'project-a', authority: owner },
      { maxLogMessageBytes: 12 },
    );
    const pathRecord: ProductionRunRecordV1 = {
      ...queuedRecord('run-path'),
      links: { artifactIds: ['C:\\Users\\Owner\\Videos\\private.mp4'] },
    };
    await expect(store.create(pathRecord)).rejects.toThrow('private local path');

    const rawRecord = {
      ...queuedRecord('run-raw'),
      checkpoint: {
        ...checkpoint('run-raw', 'succeeded'),
        nodes: {
          node: {
            runKey: 'rk',
            state: 'succeeded',
            attempts: 1,
            deterministic: true,
            output: new Blob(['private bytes'], { type: 'video/mp4' }),
          },
        },
      },
    } as unknown as ProductionRunRecordV1;
    await expect(store.create(rawRecord)).rejects.toThrow('raw media');

    await expect(store.create(parkedRecord('run-log', 'this log is far too long'))).rejects.toThrow(
      'oversized production run log',
    );
  });
});

function memoryStorage(): BrowserKeyValueStore & { values(): readonly string[] } {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values: () => [...values.values()],
  };
}

function queuedRecord(runId: string): ProductionRunRecordV1 {
  return createQueuedProductionRunRecord({
    runId,
    workflowId: 'workflow-1',
    workflowVersion: '1.0.0',
    projectRevision: 'project-revision-1',
    authority: owner,
  });
}

function parkedRecord(runId: string, logMessage = 'waiting'): ProductionRunRecordV1 {
  return createProductionRunRecordFromDashboard({
    checkpoint: checkpoint(runId, 'waiting_for_input'),
    dashboard: dashboard(runId, logMessage),
    authority: owner,
  });
}

function checkpoint(runId: string, state: RunCheckpoint['state']): RunCheckpoint {
  return {
    checkpointVersion: 1,
    runId,
    workflowId: 'workflow-1',
    workflowVersion: '1.0.0',
    projectRevision: 'project-revision-1',
    state,
    nodes: {
      node: {
        runKey: 'run-key-node',
        state: state === 'waiting_for_input' ? 'waiting_for_input' : 'succeeded',
        attempts: 1,
        deterministic: true,
        ...(state === 'waiting_for_input'
          ? {
              pendingRequest: {
                kind: 'approve-render',
                prompt: 'Approve render?',
              },
            }
          : {}),
      },
    },
  };
}

function dashboard(runId: string, logMessage: string): RunDashboard {
  return {
    runId,
    workflowId: 'workflow-1',
    workflowVersion: '1.0.0',
    projectRevision: 'project-revision-1',
    state: 'waiting_for_input',
    counts: { waiting_for_input: 1 },
    executedNodeIds: ['node'],
    reusedNodeIds: [],
    nodes: [
      {
        nodeId: 'node',
        type: 'render.approve',
        category: 'delivery',
        state: 'waiting_for_input',
        attempts: 1,
        deterministic: true,
        runKey: 'run-key-node',
        reused: false,
        pendingRequest: { kind: 'approve-render', prompt: 'Approve render?' },
        logs: [{ seq: 1, nodeId: 'node', attempt: 1, level: 'warn', message: logMessage }],
        artifacts: [],
      },
    ],
  };
}
