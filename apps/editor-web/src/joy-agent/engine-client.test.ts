import { describe, expect, it } from 'vitest';
import { createJoyAgentEngineClient } from './engine-client.js';
import type { MainToWorkerMessage } from './protocol.js';

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly messages: MainToWorkerMessage[] = [];
  terminated = false;

  postMessage(message: MainToWorkerMessage): void {
    this.messages.push(message);
    if (message.type === 'configure')
      queueMicrotask(() =>
        this.onmessage?.({
          data: {
            protocolVersion: 1,
            type: 'configured',
            status: {
              provider: message.config.provider,
              modelId: message.config.modelId,
              capability: 'untested',
            },
          },
        } as MessageEvent<unknown>),
      );
    if (message.type === 'test')
      queueMicrotask(() =>
        this.onmessage?.({
          data: {
            protocolVersion: 1,
            type: 'test-result',
            status: { provider: 'openrouter', modelId: 'openrouter/auto', capability: 'tool-loop' },
          },
        } as MessageEvent<unknown>),
      );
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('JOY Agent Engine client lifecycle', () => {
  it('finishes approval transport and accepts a second prompt; cancel settles a pending read', async () => {
    const worker = new FakeWorker();
    const client = createJoyAgentEngineClient(() => worker as unknown as Worker);
    await client.configure({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'model',
      apiKey: 'session-key',
    });
    const first = client.startRun({ runId: 'first', prompt: 'edit' });
    const next = first.next();
    worker.onmessage?.({
      data: {
        protocolVersion: 1,
        type: 'event',
        event: {
          protocolVersion: 1,
          runId: 'first',
          seq: 1,
          at: new Date().toISOString(),
          phase: 'awaiting-approval',
        },
      },
    } as MessageEvent);
    expect((await next).value.phase).toBe('awaiting-approval');
    const finished = first.next();
    worker.onmessage?.({
      data: { protocolVersion: 1, type: 'run-finished', runId: 'first' },
    } as MessageEvent);
    await expect(finished).resolves.toMatchObject({ done: true });
    const second = client.startRun({ runId: 'second', prompt: 'another edit' });
    const pending = second.next();
    await client.cancel('second');
    await expect(pending).resolves.toMatchObject({ done: true });
    await expect(second.next()).resolves.toMatchObject({ done: true });
  });
  it('configures and tests one Worker-backed session', async () => {
    const worker = new FakeWorker();
    const client = createJoyAgentEngineClient(() => worker as unknown as Worker);
    await expect(
      client.configure({
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'openrouter/auto',
        apiKey: 'page-session-key',
      }),
    ).resolves.toMatchObject({ capability: 'untested' });
    await expect(client.testConnection()).resolves.toMatchObject({ capability: 'tool-loop' });
    expect(worker.messages.filter((message) => message.type === 'configure')).toHaveLength(1);
  });

  it('closes pending async iterators when the session is cleared', async () => {
    const worker = new FakeWorker();
    const client = createJoyAgentEngineClient(() => worker as unknown as Worker);
    await client.configure({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/auto',
      apiKey: 'page-session-key',
    });
    const iterator = client.startRun({
      runId: 'run-1',
      taskKind: 'joy-code',
      prompt: 'trim',
      baseRevision: 'rev-1',
    });
    const next = iterator.next();
    client.clear();
    await expect(next).resolves.toEqual({ value: undefined, done: true });
    expect(client.getStatus()).toBeUndefined();
    expect(worker.terminated).toBe(true);
  });
});
