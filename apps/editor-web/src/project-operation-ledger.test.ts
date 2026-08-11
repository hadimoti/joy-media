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
    first.finish('audio-1', 'review', { resultRef: 'asset-a' });
    const second = new ProjectOperationLedger(store, 'project-b');
    expect(second.list()).toEqual([]);
    expect(first.get('audio-1')).toMatchObject({ status: 'review', resultRef: 'asset-a' });
    first.finish('audio-1', 'applied', { resultRef: 'asset-a' });
    expect(first.get('audio-1')).toMatchObject({ status: 'applied', resultRef: 'asset-a' });
    first.removeAll();
    expect(first.list()).toEqual([]);
  });

  it('reconciles only this project running exports after reload', () => {
    const store = storage();
    const first = new ProjectOperationLedger(store, 'project-a');
    first.begin({
      id: 'export-a',
      type: 'export',
      fingerprint: 'revision-a:reels',
      revision: 1,
      now: '2026-08-10T00:00:00Z',
    });
    first.begin({
      id: 'worker-a',
      type: 'worker-job',
      fingerprint: 'worker-a',
      revision: 1,
      now: '2026-08-10T00:00:00Z',
    });
    const second = new ProjectOperationLedger(store, 'project-b');
    second.begin({
      id: 'export-b',
      type: 'export',
      fingerprint: 'revision-b:reels',
      revision: 1,
      now: '2026-08-10T00:00:00Z',
    });

    expect(first.recoverInterrupted('export', '2026-08-10T00:01:00Z')).toEqual([
      expect.objectContaining({
        id: 'export-a',
        status: 'interrupted-retryable',
        updatedAt: '2026-08-10T00:01:00Z',
        error: 'interrupted by page reload',
      }),
      expect.objectContaining({ id: 'worker-a', status: 'running' }),
    ]);
    expect(second.get('export-b')).toMatchObject({ status: 'running' });

    const retry = first.begin({
      id: 'export-a',
      type: 'export',
      fingerprint: 'revision-a:reels',
      revision: 1,
      now: '2026-08-10T00:02:00Z',
    });
    expect(retry).toMatchObject({ status: 'running', attempt: 2 });
  });

  it('does not rewrite terminal operations during repeated reconciliation', () => {
    const ledger = new ProjectOperationLedger(storage(), 'project-a');
    ledger.begin({ id: 'export-a', type: 'export', fingerprint: 'same', revision: 1 });
    ledger.finish('export-a', 'completed', { resultRef: 'export-a' });

    expect(ledger.recoverInterrupted()).toEqual([
      expect.objectContaining({ id: 'export-a', status: 'completed', resultRef: 'export-a' }),
    ]);
  });

  it('fails an uncertain paid provider operation instead of making it retryable', () => {
    const ledger = new ProjectOperationLedger(storage(), 'project-a');
    ledger.begin({
      id: 'cloud-audio-a',
      type: 'cloud-audio',
      fingerprint: 'source:workflow',
      revision: 1,
      now: '2026-08-10T00:00:00Z',
    });

    expect(ledger.recoverUncertain('cloud-audio', '2026-08-10T00:01:00Z')).toEqual([
      expect.objectContaining({
        id: 'cloud-audio-a',
        status: 'failed',
        error: 'provider outcome unknown after page reload; automatic retry disabled',
      }),
    ]);
  });

  it('keeps the same logical id independently for different projects', () => {
    const store = storage();
    const first = new ProjectOperationLedger(store, 'project-a');
    const second = new ProjectOperationLedger(store, 'project-b');
    first.begin({ id: 'export-shared', type: 'export', fingerprint: 'a', revision: 1 });
    second.begin({ id: 'export-shared', type: 'export', fingerprint: 'b', revision: 2 });

    expect(first.get('export-shared')).toMatchObject({ projectId: 'project-a', fingerprint: 'a' });
    expect(second.get('export-shared')).toMatchObject({ projectId: 'project-b', fingerprint: 'b' });
  });

  it('retains the newest record when the bounded ledger exceeds 200 rows', () => {
    const ledger = new ProjectOperationLedger(storage(), 'project-a');
    for (let index = 0; index <= 200; index++) {
      ledger.begin({
        id: `export-${index}`,
        type: 'export',
        fingerprint: `fingerprint-${index}`,
        revision: index,
      });
    }

    expect(ledger.list()).toHaveLength(200);
    expect(ledger.get('export-200')).toBeDefined();
    expect(ledger.get('export-0')).toBeUndefined();
  });
});
