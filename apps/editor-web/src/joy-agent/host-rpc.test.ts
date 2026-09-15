import { describe, expect, it, vi } from 'vitest';
import {
  HostRpcDiagnosticError,
  createHostRpcClient,
  createHostRpcHost,
  type HostRpcJson,
  type HostRpcMethod,
  type HostRpcWireMessage,
} from './host-rpc.js';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const parseQuery = (value: HostRpcJson): { readonly query: string } => {
  const record = value as Readonly<Record<string, HostRpcJson>>;
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    typeof record.query !== 'string' ||
    Object.keys(value).length !== 1
  ) {
    throw new Error('invalid query');
  }
  return { query: record.query as string };
};

const parseMatches = (value: HostRpcJson): { readonly matches: readonly string[] } => {
  const record = value as Readonly<Record<string, HostRpcJson>>;
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    !Array.isArray(record.matches) ||
    !record.matches.every((item) => typeof item === 'string') ||
    Object.keys(value).length !== 1
  ) {
    throw new Error('invalid matches');
  }
  return { matches: record.matches as readonly string[] };
};

function createHarness(
  method: HostRpcMethod<{ readonly query: string }, { readonly matches: readonly string[] }>,
) {
  const toHost: HostRpcWireMessage[] = [];
  const toClient: HostRpcWireMessage[] = [];
  const client = createHostRpcClient({
    transport: { postMessage: (message) => toHost.push(message) },
    requestIdFactory: (() => {
      let sequence = 0;
      return () => `request-${++sequence}`;
    })(),
  });
  const host = createHostRpcHost({
    transport: { postMessage: (message) => toClient.push(message) },
    methods: { find_titles: method },
  });
  return { client, host, toClient, toHost };
}

const queryMethod: HostRpcMethod<
  { readonly query: string },
  { readonly matches: readonly string[] }
> = {
  parseArgs: parseQuery,
  execute: async ({ query }) => ({ matches: [`title:${query}`] }),
  parseResult: parseMatches,
};

describe('JOY Agent host RPC', () => {
  it('correlates concurrent responses to their originating request IDs', async () => {
    const { client, host, toClient, toHost } = createHarness(queryMethod);
    const run = client.beginRun('run-1');
    const first = client.call<{ readonly matches: readonly string[] }>(run, 'find_titles', {
      query: 'first',
    });
    const second = client.call<{ readonly matches: readonly string[] }>(run, 'find_titles', {
      query: 'second',
    });

    expect(toHost).toHaveLength(2);
    expect(toHost[0]).toMatchObject({ requestId: 'request-1', runEpoch: 1 });
    expect(toHost[1]).toMatchObject({ requestId: 'request-2', runEpoch: 1 });

    host.receive(toHost[1]);
    host.receive(toHost[0]);
    await flush();
    expect(toClient).toHaveLength(2);
    client.receive(toClient[0]);
    client.receive(toClient[1]);

    await expect(second).resolves.toEqual({ matches: ['title:second'] });
    await expect(first).resolves.toEqual({ matches: ['title:first'] });
  });

  it('rejects secret-bearing or handle-shaped arguments before crossing the transport', async () => {
    const { client, toHost } = createHarness(queryMethod);
    const run = client.beginRun('run-1');

    await expect(
      client.call(run, 'find_titles', {
        query: 'title',
        storage: { setItem: () => undefined },
      } as unknown as HostRpcJson),
    ).rejects.toMatchObject({ diagnostic: { code: 'JOY_AGENT_RPC_UNSAFE_PAYLOAD' } });
    await expect(
      client.call(run, 'find_titles', {
        query: 'title',
        apiKey: 'not-allowed',
      } as unknown as HostRpcJson),
    ).rejects.toMatchObject({ diagnostic: { code: 'JOY_AGENT_RPC_UNSAFE_PAYLOAD' } });
    expect(toHost).toHaveLength(0);
  });

  it('does not allow a storage URL to cross as a plain string payload', async () => {
    const { client, toHost } = createHarness(queryMethod);
    const run = client.beginRun('run-1');

    await expect(
      client.call(run, 'find_titles', { query: 'blob:local-project-media' }),
    ).rejects.toMatchObject({ diagnostic: { code: 'JOY_AGENT_RPC_UNSAFE_PAYLOAD' } });
    expect(toHost).toHaveLength(0);
  });

  it('rejects a non-exact request envelope without invoking its handler', async () => {
    const execute = vi.fn(queryMethod.execute);
    const { host, toClient } = createHarness({ ...queryMethod, execute });

    expect(
      host.receive({
        protocolVersion: 1,
        type: 'host-rpc-request',
        requestId: 'request-1',
        runId: 'run-1',
        runEpoch: 1,
        method: 'find_titles',
        arguments: { query: 'title' },
        deadlineMs: 1_000,
        writer: { fence: 1 },
      }),
    ).toBe(false);
    await flush();

    expect(execute).not.toHaveBeenCalled();
    expect(toClient).toContainEqual(
      expect.objectContaining({
        type: 'host-rpc-response',
        ok: false,
        error: expect.objectContaining({ code: 'JOY_AGENT_RPC_INVALID_REQUEST' }),
      }),
    );
  });

  it('enforces a deadline on both sides and aborts the host handler', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const { client, host, toHost } = createHarness({
        ...queryMethod,
        execute: async (_args, context) =>
          new Promise<{ readonly matches: readonly string[] }>((_resolve, reject) => {
            context.signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          }),
      });
      const run = client.beginRun('run-1');
      const result = client.call(run, 'find_titles', { query: 'title' }, { deadlineMs: 25 });
      const rejection = expect(result).rejects.toMatchObject({
        diagnostic: { code: 'JOY_AGENT_RPC_TIMEOUT', retryable: true },
      });

      host.receive(toHost[0]);
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never forwards an oversized handler result', async () => {
    const { client, host, toClient, toHost } = createHarness({
      ...queryMethod,
      execute: async () => ({ matches: ['x'.repeat(70_000)] }),
    });
    const run = client.beginRun('run-1');
    const result = client.call(run, 'find_titles', { query: 'title' });

    host.receive(toHost[0]);
    await flush();
    expect(toClient[0]).toMatchObject({
      type: 'host-rpc-response',
      ok: false,
      error: { code: 'JOY_AGENT_RPC_OUTPUT_TOO_LARGE', retryable: false },
    });
    client.receive(toClient[0]);
    await expect(result).rejects.toMatchObject({
      diagnostic: { code: 'JOY_AGENT_RPC_OUTPUT_TOO_LARGE' },
    });
  });

  it('uses a method parser output as the strict wire response', async () => {
    const { client, host, toClient, toHost } = createHarness({
      ...queryMethod,
      execute: async () => ({
        matches: ['title:clean'],
        ignoredBySchema: 'must not cross the boundary',
      }),
      parseResult: (value) => {
        const record = value as Readonly<Record<string, HostRpcJson>>;
        if (
          !Array.isArray(record.matches) ||
          !record.matches.every((item) => typeof item === 'string')
        )
          throw new Error('invalid matches');
        return { matches: record.matches as readonly string[] };
      },
    });
    const run = client.beginRun('run-1');
    const result = client.call<{ readonly matches: readonly string[] }>(run, 'find_titles', {
      query: 'title',
    });

    host.receive(toHost[0]);
    await flush();
    expect(toClient[0]).toMatchObject({ ok: true, result: { matches: ['title:clean'] } });
    expect(JSON.stringify(toClient[0])).not.toContain('ignoredBySchema');
    client.receive(toClient[0]);
    await expect(result).resolves.toEqual({ matches: ['title:clean'] });
  });

  it('caps the default client deadline when a stricter maximum is configured', async () => {
    const sent: HostRpcWireMessage[] = [];
    const client = createHostRpcClient({
      transport: { postMessage: (message) => sent.push(message) },
      maxDeadlineMs: 10,
    });
    const run = client.beginRun('run-1');
    const pending = client.call(run, 'find_titles', { query: 'title' });

    expect(sent[0]).toMatchObject({ type: 'host-rpc-request', deadlineMs: 10 });
    client.cancelRun(run);
    await expect(pending).rejects.toMatchObject({
      diagnostic: { code: 'JOY_AGENT_RPC_CANCELLED' },
    });
  });

  it('fails closed when a correlated response has an extra field', async () => {
    const { client, toHost } = createHarness(queryMethod);
    const run = client.beginRun('run-1');
    const pending = client.call(run, 'find_titles', { query: 'title' });
    const request = toHost[0] as Extract<HostRpcWireMessage, { readonly type: 'host-rpc-request' }>;

    expect(
      client.receive({
        protocolVersion: 1,
        type: 'host-rpc-response',
        requestId: request.requestId,
        runId: request.runId,
        runEpoch: request.runEpoch,
        method: request.method,
        ok: true,
        result: { matches: ['title'] },
        debug: 'not allowed',
      }),
    ).toBe(false);
    await expect(pending).rejects.toMatchObject({
      diagnostic: { code: 'JOY_AGENT_RPC_INVALID_RESPONSE' },
    });
  });

  it('cancels an active epoch, aborts its host call, and permits the next epoch', async () => {
    let firstSignal: AbortSignal | undefined;
    const { client, host, toClient, toHost } = createHarness({
      ...queryMethod,
      execute: async ({ query }, context) => {
        if (query === 'slow') {
          firstSignal = context.signal;
          return new Promise(() => undefined);
        }
        return { matches: ['new epoch'] };
      },
    });
    const firstRun = client.beginRun('run-1');
    const first = client.call(firstRun, 'find_titles', { query: 'slow' });
    host.receive(toHost[0]);

    client.cancelRun(firstRun);
    expect(toHost[1]).toMatchObject({ type: 'host-rpc-cancel', runEpoch: 1 });
    host.receive(toHost[1]);
    await expect(first).rejects.toMatchObject({ diagnostic: { code: 'JOY_AGENT_RPC_CANCELLED' } });
    expect(firstSignal?.aborted).toBe(true);

    const nextRun = client.beginRun('run-1');
    expect(nextRun.epoch).toBe(2);
    const second = client.call<{ readonly matches: readonly string[] }>(nextRun, 'find_titles', {
      query: 'fast',
    });
    host.receive(toHost[2]);
    await flush();
    client.receive(toClient.at(-1)!);
    await expect(second).resolves.toEqual({ matches: ['new epoch'] });
  });

  it('projects handler failures as structured diagnostics without raw error text', async () => {
    const { client, host, toClient, toHost } = createHarness({
      ...queryMethod,
      execute: async () => {
        throw new HostRpcDiagnosticError({
          code: 'JOY_AGENT_RPC_INVALID_REQUEST',
          retryable: true,
          operation: 'find_titles',
          field: 'query',
          facts: { maximumResults: 128 },
        });
      },
    });
    const run = client.beginRun('run-1');
    const result = client.call(run, 'find_titles', { query: 'title' });

    host.receive(toHost[0]);
    await flush();
    expect(JSON.stringify(toClient[0])).not.toContain('apiKey');
    client.receive(toClient[0]);
    await expect(result).rejects.toMatchObject({
      diagnostic: {
        code: 'JOY_AGENT_RPC_INVALID_REQUEST',
        retryable: true,
        operation: 'find_titles',
        field: 'query',
        facts: { maximumResults: 128 },
      },
    });
  });

  it('replaces an unexpected handler exception with a stable safe diagnostic', async () => {
    const { client, host, toClient, toHost } = createHarness({
      ...queryMethod,
      execute: async () => {
        throw new Error('provider credential must never cross host RPC');
      },
    });
    const run = client.beginRun('run-1');
    const result = client.call(run, 'find_titles', { query: 'title' });

    host.receive(toHost[0]);
    await flush();
    expect(toClient[0]).toMatchObject({
      type: 'host-rpc-response',
      ok: false,
      error: { code: 'JOY_AGENT_RPC_HANDLER_FAILED', retryable: false },
    });
    expect(JSON.stringify(toClient[0])).not.toContain('provider credential');
    client.receive(toClient[0]);
    await expect(result).rejects.toMatchObject({
      diagnostic: { code: 'JOY_AGENT_RPC_HANDLER_FAILED', retryable: false },
    });
  });
});
