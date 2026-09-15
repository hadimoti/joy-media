import { describe, expect, it } from 'vitest';
import {
  agentIdempotencyStorageKey,
  BrowserAgentIdempotencyStore,
  ExecutionReceiptConflictError,
} from './agent-idempotency-store.js';
import { createExecutionReceipt } from './execution-receipt.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('BrowserAgentIdempotencyStore', () => {
  it('reopens a completed receipt and treats a failed receipt as retryable', () => {
    const storage = memoryStorage();
    const first = new BrowserAgentIdempotencyStore(storage, 'project');
    first.recordExecution('run-ok', 'plan-1', '__transaction__', { success: true });
    first.recordFailure('run-failed', 'plan-2', '__transaction__', 'temporary failure');

    const reopened = new BrowserAgentIdempotencyStore(storage, 'project');
    expect(reopened.hasExecuted('run-ok')).toBe(true);
    expect(reopened.hasExecuted('run-failed')).toBe(false);
    expect(reopened.recordsForPlan('plan-1')).toHaveLength(1);
  });

  it('isolates receipts by project and ignores malformed storage', () => {
    const storage = memoryStorage();
    const projectA = new BrowserAgentIdempotencyStore(storage, 'project-a');
    projectA.recordExecution('same-key', 'plan', '__transaction__', { success: true });

    expect(new BrowserAgentIdempotencyStore(storage, 'project-b').hasExecuted('same-key')).toBe(
      false,
    );

    storage.setItem('joy-media.agent-idempotency.v1:broken', '{');
    expect(new BrowserAgentIdempotencyStore(storage, 'broken').hasExecuted('x')).toBe(false);
  });

  it('stages a durable execution receipt sidecar before exposing it in memory', () => {
    const storage = memoryStorage();
    const store = new BrowserAgentIdempotencyStore(storage, 'project-a');

    const receipt = createExecutionReceipt({
      executionId: 'execution-1',
      projectId: 'project-a',
      operationDigest: 'a'.repeat(64),
      baseRevision: 'revision-1',
      resultRevision: 'revision-2',
      writerFence: 1,
      changedEntityIds: ['clip-1'],
      undoEntryId: 'history-1',
    });
    const sidecar = store.stageExecutionReceipt(receipt);
    expect(sidecar.storageKey).toBe(agentIdempotencyStorageKey('project-a'));
    expect(store.storageKey).toBe(sidecar.storageKey);
    expect(store.getExecutionReceipt(receipt.executionId)).toBeUndefined();
    expect(storage.getItem(sidecar.storageKey)).toBeNull();

    sidecar.persist();
    expect(store.getExecutionReceipt(receipt.executionId)).toBeUndefined();
    expect(storage.getItem(sidecar.storageKey)).not.toBeNull();

    sidecar.commit();
    expect(store.getExecutionReceipt(receipt.executionId)).toEqual(receipt);
    expect(
      new BrowserAgentIdempotencyStore(storage, 'project-a').getExecutionReceipt(
        receipt.executionId,
      ),
    ).toEqual(receipt);
  });

  it('merges overlapping staged receipt writes before reopening storage', () => {
    const storage = memoryStorage();
    const store = new BrowserAgentIdempotencyStore(storage, 'project-a');
    const first = createExecutionReceipt({
      executionId: 'execution-first',
      projectId: 'project-a',
      operationDigest: 'c'.repeat(64),
      baseRevision: 'revision-1',
      resultRevision: 'revision-2',
      writerFence: 3,
      changedEntityIds: ['clip-3'],
      undoEntryId: 'history-3',
    });
    const second = createExecutionReceipt({
      executionId: 'execution-second',
      projectId: 'project-a',
      operationDigest: 'd'.repeat(64),
      baseRevision: 'revision-2',
      resultRevision: 'revision-3',
      writerFence: 4,
      changedEntityIds: ['clip-4'],
      undoEntryId: 'history-4',
    });

    const firstSidecar = store.stageExecutionReceipt(first);
    const secondSidecar = store.stageExecutionReceipt(second);
    firstSidecar.persist();
    secondSidecar.persist();
    firstSidecar.commit();
    secondSidecar.commit();

    const reopened = new BrowserAgentIdempotencyStore(storage, 'project-a');
    expect(reopened.getExecutionReceipt(first.executionId)).toEqual(first);
    expect(reopened.getExecutionReceipt(second.executionId)).toEqual(second);
  });

  it('rejects malformed and cross-project execution receipts while reopening valid sidecars', () => {
    const storage = memoryStorage();
    const receipt = createExecutionReceipt({
      executionId: 'execution-2',
      projectId: 'project-a',
      operationDigest: 'b'.repeat(64),
      baseRevision: 'revision-1',
      resultRevision: 'revision-2',
      writerFence: 2,
      changedEntityIds: ['clip-2'],
      undoEntryId: 'history-2',
    });
    storage.setItem(
      agentIdempotencyStorageKey('project-a'),
      JSON.stringify({
        version: 2,
        records: [],
        executionReceipts: [
          receipt,
          { ...receipt, executionId: 'invalid', operationDigest: 'not-a-digest' },
          { ...receipt, executionId: 'other-project', projectId: 'project-b' },
        ],
      }),
    );

    const reopened = new BrowserAgentIdempotencyStore(storage, 'project-a');
    expect(reopened.getExecutionReceipt(receipt.executionId)).toEqual(receipt);
    expect(reopened.getExecutionReceipt('invalid')).toBeUndefined();
    expect(reopened.getExecutionReceipt('other-project')).toBeUndefined();
  });

  it('retains a persisted execution conflict and rejects restaging that execution ID', () => {
    const storage = memoryStorage();
    const first = createExecutionReceipt({
      executionId: 'execution-conflict',
      projectId: 'project-a',
      operationDigest: 'e'.repeat(64),
      baseRevision: 'revision-1',
      resultRevision: 'revision-2',
      writerFence: 5,
      changedEntityIds: ['clip-5'],
      undoEntryId: 'history-5',
    });
    const conflicting = createExecutionReceipt({
      ...first,
      operationDigest: 'f'.repeat(64),
      resultRevision: 'revision-3',
      writerFence: 6,
      changedEntityIds: ['clip-6'],
      undoEntryId: 'history-6',
    });
    storage.setItem(
      agentIdempotencyStorageKey('project-a'),
      JSON.stringify({ version: 2, records: [], executionReceipts: [first, conflicting] }),
    );

    const opened = new BrowserAgentIdempotencyStore(storage, 'project-a');
    expect(opened.getExecutionReceipt(first.executionId)).toBeUndefined();
    expect(opened.getExecutionReceiptConflict(first.executionId)).toEqual([first, conflicting]);
    expect(() => opened.stageExecutionReceipt(first)).toThrow(ExecutionReceiptConflictError);

    opened.recordExecution('ordinary-record', 'plan-5', '__transaction__', { success: true });
    const reopened = new BrowserAgentIdempotencyStore(storage, 'project-a');
    expect(reopened.getExecutionReceiptConflict(first.executionId)).toEqual([first, conflicting]);
    expect(() => reopened.stageExecutionReceipt(first)).toThrow(ExecutionReceiptConflictError);
  });
});
