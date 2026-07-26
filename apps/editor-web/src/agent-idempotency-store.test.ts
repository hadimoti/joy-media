import { describe, expect, it } from 'vitest';
import { BrowserAgentIdempotencyStore } from './agent-idempotency-store.js';

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
});
