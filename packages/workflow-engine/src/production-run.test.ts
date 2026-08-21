import { describe, expect, it } from 'vitest';

import type { JoyWorkflow, WorkflowEdge, WorkflowNode } from './definition.js';
import { WORKFLOW_FORMAT_VERSION } from './definition.js';
import { RunRecorder, buildRunDashboard, instrumentHandlers } from './operations.js';
import {
  InMemoryProductionRunStore,
  appendProductionRunEvent,
  buildProductionRunBoardSnapshot,
  createProductionRunRecordFromDashboard,
  createQueuedProductionRunRecord,
  markProductionRunRunning,
  productionRunStateFromWorkflowRunState,
  recordProductionApprovalResponse,
} from './production-run.js';
import type { ProductionRunAuthority, ProductionRunRecordV1 } from './production-run.js';
import type { NodeHandler } from './runtime.js';
import { executeWorkflow } from './runtime.js';

const node = (id: string, overrides: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id,
  category: 'transform',
  type: `t.${id}`,
  params: {},
  deterministic: true,
  ...overrides,
});

const workflow = (
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  overrides: Partial<JoyWorkflow> = {},
): JoyWorkflow => ({
  formatVersion: WORKFLOW_FORMAT_VERSION,
  id: 'wf-production',
  version: '1.0.0',
  name: 'Production run test workflow',
  inputs: {},
  outputs: {},
  nodes,
  edges,
  permissions: [],
  policy: { concurrency: 1, failure: 'stop', defaultRetry: { maxAttempts: 1, backoffMs: 0 } },
  ...overrides,
});

const authority: ProductionRunAuthority = {
  principalId: 'user-1',
  role: 'owner',
  displayName: 'Production Owner',
};

function runProductionCase(
  runId: string,
  handler: NodeHandler,
  options: { shouldCancel?: () => boolean } = {},
): ProductionRunRecordV1 {
  const wf = workflow([node('task')], []);
  const recorder = new RunRecorder();
  const result = executeWorkflow({
    workflow: wf,
    runId,
    projectRevision: 'rev-1',
    workflowInputs: null,
    handlers: instrumentHandlers({ 't.task': handler }, recorder),
    ...options,
  });
  return createProductionRunRecordFromDashboard({
    dashboard: buildRunDashboard({ workflow: wf, result, recorder }),
    checkpoint: result.checkpoint,
  });
}

describe('production run records', () => {
  it('represents queued, running, parked, failed, canceled, and succeeded runs', () => {
    const queued = createQueuedProductionRunRecord({
      runId: 'run-queued',
      workflowId: 'wf-production',
      workflowVersion: '1.0.0',
      projectRevision: 'rev-1',
    });
    expect(queued).toMatchObject({
      recordVersion: 1,
      runId: 'run-queued',
      state: 'queued',
      checkpointRevision: 0,
    });

    const running = markProductionRunRunning(queued, authority);
    expect(running.state).toBe('running');
    expect(running.events.map((event) => [event.seq, event.type, event.state])).toEqual([
      [1, 'run.queued', 'queued'],
      [2, 'run.started', 'running'],
    ]);

    expect(productionRunStateFromWorkflowRunState('waiting_for_input')).toBe('parked');
    expect(productionRunStateFromWorkflowRunState('waiting_for_manual_intervention')).toBe(
      'parked',
    );
    expect(
      runProductionCase('run-parked', () => ({
        waiting: true,
        request: { kind: 'approve-render', prompt: 'Ship it?', payload: { private: true } },
      })).state,
    ).toBe('parked');
    expect(
      runProductionCase('run-failed', () => ({
        ok: false,
        failureCode: 'provider/unavailable',
        retryable: false,
      })).state,
    ).toBe('failed');
    expect(
      runProductionCase('run-canceled', () => ({ ok: true, output: 'unreached' }), {
        shouldCancel: () => true,
      }).state,
    ).toBe('canceled');
    expect(runProductionCase('run-succeeded', () => ({ ok: true, output: 'done' })).state).toBe(
      'succeeded',
    );
  });

  it('appends events with monotonic sequence numbers', () => {
    const queued = createQueuedProductionRunRecord({
      runId: 'run-events',
      workflowId: 'wf-production',
      workflowVersion: '1.0.0',
      projectRevision: 'rev-1',
    });
    const first = appendProductionRunEvent(queued, {
      type: 'run.checkpointed',
      state: 'running',
      message: 'checkpoint persisted',
    });
    const second = appendProductionRunEvent(first, {
      type: 'run.succeeded',
      state: 'succeeded',
      message: 'complete',
    });

    expect(second.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(second.updatedSeq).toBe(3);
    expect(second.state).toBe('succeeded');
  });

  it('bounds public logs and artifacts while linking ids without private payloads', () => {
    const wf = workflow([node('task')], []);
    const recorder = new RunRecorder();
    recorder.log('task', 'info', 'first', 1, { secret: 'payload' });
    recorder.log('task', 'warn', 'second', 1, { secret: 'payload' });
    recorder.log('task', 'error', 'third', 1, { secret: 'payload' });
    recorder.addArtifact({
      nodeId: 'task',
      name: 'private render',
      kind: 'render',
      ref: 'C:\\private\\renders\\final.mp4',
    });
    const result = executeWorkflow({
      workflow: wf,
      runId: 'run-bounded',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers: { 't.task': () => ({ ok: true, output: null }) },
    });

    const record = createProductionRunRecordFromDashboard({
      dashboard: buildRunDashboard({ workflow: wf, result, recorder }),
      checkpoint: result.checkpoint,
      links: {
        jobId: 'job-1',
        providerRunId: 'provider-run-1',
        reportId: 'report-1',
        artifactIds: ['artifact-root-1'],
        artifactIdsByNodeId: { task: ['artifact-1', 'artifact-2', 'artifact-3'] },
      },
      maxLogsPerNode: 2,
      maxArtifactIdsPerNode: 2,
    });

    expect(record.links).toEqual({
      jobId: 'job-1',
      providerRunId: 'provider-run-1',
      reportId: 'report-1',
      artifactIds: ['artifact-root-1'],
    });
    expect(record.nodes[0]?.logs.map((entry) => entry.message)).toEqual(['second', 'third']);
    expect(record.nodes[0]?.logs[0]).not.toHaveProperty('data');
    expect(record.nodes[0]?.artifactIds).toEqual(['artifact-2', 'artifact-3']);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('C:\\private');
    expect(serialized).not.toContain('payload');
    expect(serialized).not.toContain('artifact-1');
  });

  it('round-trips records through JSON serialization', () => {
    const record = runProductionCase('run-json', () => ({ ok: true, output: { ok: true } }));
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it('updates checkpoints through compare-and-swap revisions', async () => {
    const record = createQueuedProductionRunRecord({
      runId: 'run-cas',
      workflowId: 'wf-production',
      workflowVersion: '1.0.0',
      projectRevision: 'rev-1',
    });
    const checkpointRecord = runProductionCase('run-cas', () => ({ ok: true, output: null }));
    const store = new InMemoryProductionRunStore();
    await store.create(record);
    const checkpoint = checkpointRecord.checkpoint;
    if (checkpoint === undefined) {
      expect.unreachable('production run record should include a public checkpoint');
    }
    const dashboard = buildProductionRunBoardSnapshot([checkpointRecord]).runs[0];
    if (dashboard === undefined) {
      expect.unreachable('production run board snapshot should include the checkpoint record');
    }

    const updated = await store.compareAndSwapCheckpoint({
      runId: 'run-cas',
      expectedRevision: 0,
      checkpoint,
      dashboard,
    });
    expect(updated).toMatchObject({
      ok: true,
      record: { checkpointRevision: 1, state: 'succeeded' },
    });

    const stale = await store.compareAndSwapCheckpoint({
      runId: 'run-cas',
      expectedRevision: 0,
      checkpoint,
    });
    expect(stale).toEqual({ ok: false, reason: 'revision-conflict', currentRevision: 1 });
  });

  it('records approval responses idempotently and rejects conflicting duplicates', () => {
    const parked = runProductionCase('run-approval', () => ({
      waiting: true,
      request: { kind: 'approve-render', prompt: 'Approve final?', payload: { private: 'diff' } },
    }));
    const approvalId = parked.approvals[0]?.approvalId;
    expect(approvalId).toBeDefined();

    const first = recordProductionApprovalResponse(parked, {
      approvalId: approvalId as string,
      approved: true,
      responseRef: 'approval-response-1',
      authority,
    });
    expect(first).toMatchObject({ ok: true, duplicate: false });
    if (!first.ok) {
      expect.unreachable('approval response should apply');
    }
    expect(first.record.approvals[0]).toMatchObject({
      requestPayload: { private: 'diff' },
      state: 'approved',
      responseRef: 'approval-response-1',
      respondedSeq: 3,
    });
    expect(JSON.stringify(first.record)).toContain('"requestPayload":{"private":"diff"}');

    const duplicate = recordProductionApprovalResponse(first.record, {
      approvalId: approvalId as string,
      approved: true,
      responseRef: 'approval-response-1',
      authority,
    });
    expect(duplicate).toMatchObject({ ok: true, duplicate: true, record: first.record });

    const duplicateWithReorderedKeys = recordProductionApprovalResponse(first.record, {
      approvalId: approvalId as string,
      approved: true,
      responseRef: 'approval-response-2',
      response: { nested: { b: 2, a: 1 }, approved: true },
      authority,
    });
    expect(duplicateWithReorderedKeys).toEqual({ ok: false, reason: 'approval-conflict' });

    const conflict = recordProductionApprovalResponse(first.record, {
      approvalId: approvalId as string,
      approved: false,
      responseRef: 'approval-response-2',
      authority,
    });
    expect(conflict).toEqual({ ok: false, reason: 'approval-conflict' });
  });

  it('treats reordered response object keys as duplicate approvals', () => {
    const parked = runProductionCase('run-approval-reordered', () => ({
      waiting: true,
      request: { kind: 'approve-render', prompt: 'Approve final?' },
    }));
    const approvalId = parked.approvals[0]?.approvalId;
    if (approvalId === undefined) expect.unreachable('approval should exist');

    const first = recordProductionApprovalResponse(parked, {
      approvalId,
      approved: true,
      responseRef: 'approval-response-reordered',
      response: { approved: true, nested: { a: 1, b: 2 } },
      authority,
    });
    expect(first).toMatchObject({ ok: true, duplicate: false });
    if (!first.ok) expect.unreachable('first approval should apply');

    const duplicate = recordProductionApprovalResponse(first.record, {
      approvalId,
      approved: true,
      responseRef: 'approval-response-reordered',
      response: { nested: { b: 2, a: 1 }, approved: true },
      authority,
    });
    expect(duplicate).toEqual({ ok: true, duplicate: true, record: first.record });
  });

  it('projects production records into a board snapshot', () => {
    const parked = runProductionCase('run-board-parked', () => ({
      waiting: true,
      request: { kind: 'approve-render', prompt: 'Approve board?' },
    }));
    const succeeded = runProductionCase('run-board-succeeded', () => ({
      ok: true,
      output: { artifactId: 'artifact-final' },
    }));

    const snapshot = buildProductionRunBoardSnapshot([parked, succeeded]);
    expect(snapshot).toMatchObject({
      snapshotVersion: 1,
      counts: { parked: 1, succeeded: 1 },
    });
    expect(snapshot.runs.map((run) => [run.runId, run.state])).toEqual([
      ['run-board-parked', 'parked'],
      ['run-board-succeeded', 'succeeded'],
    ]);
    expect(snapshot.runs[0]?.approvals).toEqual([
      {
        approvalId: parked.approvals[0]?.approvalId,
        nodeId: 'task',
        kind: 'approve-render',
        prompt: 'Approve board?',
        requestedSeq: 2,
        state: 'pending',
      },
    ]);
    expect(snapshot.runs[1]?.nodes[0]).toMatchObject({
      nodeId: 'task',
      state: 'succeeded',
      attempts: 1,
    });
  });
});
