import { describe, expect, it } from 'vitest';
import {
  createExecutionReceipt,
  isExecutionReceipt,
  receiptReplayKey,
} from './execution-receipt.js';

const input = {
  executionId: 'run-1',
  projectId: 'project-1',
  operationDigest: 'a'.repeat(64),
  baseRevision: 'local-revision:v1:project',
  resultRevision: 'local-revision:v1:project:next',
  writerFence: 1,
  changedEntityIds: ['clip-2', 'clip-1'],
  undoEntryId: 'history-5',
};

describe('agent execution receipt', () => {
  it('records the exact authority boundary with stable replay identity', () => {
    const receipt = createExecutionReceipt(input);
    expect(receipt).toEqual({
      version: 1,
      ...input,
      status: 'committed',
      changedEntityIds: ['clip-1', 'clip-2'],
    });
    expect(receiptReplayKey(receipt)).toBe(
      'run-1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
  });

  it('rejects malformed IDs, non-SHA operation digests, and invalid fences', () => {
    expect(() => createExecutionReceipt({ ...input, operationDigest: 'not-a-digest' })).toThrow(
      'operationDigest',
    );
    expect(() => createExecutionReceipt({ ...input, writerFence: 0 })).toThrow('writerFence');
    expect(() => createExecutionReceipt({ ...input, executionId: '' })).toThrow('executionId');
  });

  it('recognizes only canonical persisted receipt values', () => {
    const receipt = createExecutionReceipt(input);
    expect(isExecutionReceipt(receipt)).toBe(true);
    expect(
      isExecutionReceipt({ ...receipt, operationDigest: receipt.operationDigest.toUpperCase() }),
    ).toBe(false);
    expect(isExecutionReceipt({ ...receipt, changedEntityIds: ['clip-2', 'clip-1'] })).toBe(false);
    expect(isExecutionReceipt({ ...receipt, writerFence: 0 })).toBe(false);
  });
});
