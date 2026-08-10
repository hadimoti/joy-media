import { describe, expect, it } from 'vitest';
import {
  OperationConflictError,
  ProjectOperationLedger,
  type OperationLedgerStorage,
} from './project-operation-ledger.js';

function storage(): OperationLedgerStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

describe('ProjectOperationLedger', () => {
  it('reattaches matching retries and rejects fingerprint conflicts', () => {
    const ledger = new ProjectOperationLedger(storage(), 'project-a');
    const first = ledger.begin({
      id: 'export-1',
      type: 'export',
      fingerprint: 'rev-1:preset-reels',
      revision: 1,
      now: '2026-08-10T00:00:00Z',
    });
    expect(first.attempt).toBe(1);
    const retry = ledger.begin({
      id: 'export-1',
      type: 'export',
      fingerprint: 'rev-1:preset-reels',
      revision: 1,
      now: '2026-08-10T00:01:00Z',
    });
    expect(retry).toMatchObject({ status: 'running', attempt: 2 });
    expect(() =>
      ledger.begin({
        id: 'export-1',
        type: 'export',
        fingerprint: 'rev-2:preset-reels',
        revision: 2,
      }),
    ).toThrow(OperationConflictError);
  });

  it('keeps records isolated by project and supports terminal results', () => {
    const store = storage();
    const first = new ProjectOperationLedger(store, 'project-a');
    first.begin({ id: 'audio-1', type: 'audio', fingerprint: 'x', revision: 0 });
    first.finish('audio-1', 'completed', { resultRef: 'asset-a' });
    const second = new ProjectOperationLedger(store, 'project-b');
    expect(second.list()).toEqual([]);
    expect(first.get('audio-1')).toMatchObject({ status: 'completed', resultRef: 'asset-a' });
    first.removeAll();
    expect(first.list()).toEqual([]);
  });
});
