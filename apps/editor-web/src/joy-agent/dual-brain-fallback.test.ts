import { describe, expect, it, vi } from 'vitest';
import type { HostRpcRun } from './host-rpc.js';
import type { JoyAgentRunIterator } from './engine-client.js';
import type { JoyAgentSafeEvent } from './protocol.js';
import { createFallbackRunIterator } from './dual-brain-fallback.js';

function iterator(events: JoyAgentSafeEvent[]): JoyAgentRunIterator {
  let index = 0;
  return {
    run: { runId: 'run-1', epoch: 1 },
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      const event = events[index++];
      return event ? { value: event, done: false } : { value: undefined, done: true };
    },
    async return() {
      return { value: undefined, done: true };
    },
  };
}

function event(seq: number, extra: Partial<JoyAgentSafeEvent> = {}): JoyAgentSafeEvent {
  return {
    protocolVersion: 2,
    runId: 'run-1',
    runEpoch: 1,
    seq,
    at: '2026-10-04T00:00:00.000Z',
    phase: 'failed',
    ...extra,
  };
}

describe('Dual-Brain runtime fallback', () => {
  it('falls back on an eligible provider failure before user output and renumbers events', async () => {
    const primary = iterator([event(0, { errorCode: 'JOY_AGENT_AUTH_FAILED' })]);
    const fallback = iterator([event(0, { phase: 'completed', message: 'Done' })]);
    const start = vi.fn(() => fallback);
    const cancel = vi.fn();
    const proxy = createFallbackRunIterator(primary, start, cancel);
    const values = [];
    for await (const value of proxy) values.push(value);

    expect(start).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(values.map((value) => value.seq)).toEqual([0, 1]);
    expect(values[0]).toMatchObject({
      phase: 'thinking',
      message: expect.stringContaining('fallback'),
    });
    expect(values.at(-1)).toMatchObject({ phase: 'completed', message: 'Done' });
    expect(proxy.run).toEqual(fallback.run satisfies HostRpcRun);
  });

  it('does not switch after a proposal has been emitted', async () => {
    const primary = iterator([
      event(0, {
        phase: 'previewing',
        proposal: {
          changeSetId: 'c',
          operationDigest: 'd',
          bindingDigest: 'b',
          operationCount: 0,
          baseRevision: 'r',
          summary: '',
        },
      }),
      event(1, { errorCode: 'JOY_AGENT_AUTH_FAILED' }),
    ]);
    const start = vi.fn(() => iterator([]));
    const proxy = createFallbackRunIterator(primary, start, vi.fn());
    for await (const _value of proxy) {
      /* drain */
    }
    expect(start).not.toHaveBeenCalled();
  });

  it('falls back when the primary iterator rejects', async () => {
    const primary = iterator([]);
    primary.next = vi.fn().mockRejectedValue(new Error('connection reset'));
    const fallback = iterator([event(0, { phase: 'completed' })]);
    const start = vi.fn(() => fallback);
    const proxy = createFallbackRunIterator(primary, start, vi.fn());
    const values = [];
    for await (const value of proxy) values.push(value);
    expect(start).toHaveBeenCalledOnce();
    expect(values.at(-1)?.phase).toBe('completed');
  });

  it('surfaces one safe failure when the fallback iterator also rejects', async () => {
    const primary = iterator([event(0, { errorCode: 'JOY_AGENT_RATE_LIMITED' })]);
    const fallback = iterator([]);
    fallback.next = vi.fn().mockRejectedValue(new Error('provider response included private data'));
    const proxy = createFallbackRunIterator(primary, () => fallback, vi.fn());
    const values = [];
    for await (const value of proxy) values.push(value);
    expect(values.filter((value) => value.phase === 'failed')).toHaveLength(1);
    expect(values.at(-1)).toMatchObject({
      errorCode: 'JOY_AGENT_UNKNOWN',
      message: 'Fallback provider failed.',
    });
  });
});
