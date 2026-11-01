import { describe, expect, it, vi } from 'vitest';
import { createJoyAgentEngineClient } from './engine-client.js';
import { ProviderCallError, type ProviderCall } from './provider-call.js';
import { JOY_AGENT_PROTOCOL_VERSION } from './protocol.js';

/** Records what the client posts, and answers configure the way the Worker does. */
class RecordingWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly messages: Record<string, unknown>[] = [];

  postMessage(message: Record<string, unknown>): void {
    this.messages.push(message);
    if (message.type === 'configure') {
      queueMicrotask(() =>
        this.emit({
          protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
          type: 'configured',
          status: { provider: 'openrouter', modelId: 'openrouter/free', capability: 'untested' },
        }),
      );
    }
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }

  terminate(): void {}
}

const CONFIG = {
  provider: 'openrouter' as const,
  baseUrl: 'https://openrouter.ai/api/v1',
  modelId: 'openrouter/free',
  profileId: 'prof-1',
};

const PROVIDER_REQUEST = {
  protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
  type: 'provider-request',
  requestId: 'provider-1',
  profileId: 'prof-1',
  baseUrl: 'https://openrouter.ai/api/v1',
  modelId: 'openrouter/free',
  body: { messages: [{ role: 'user', content: 'hi' }] },
};

async function startedClient(providerCall: ProviderCall): Promise<RecordingWorker> {
  const worker = new RecordingWorker();
  const client = createJoyAgentEngineClient(() => worker as unknown as Worker, providerCall);
  await client.configure(CONFIG);
  return worker;
}

function answers(worker: RecordingWorker): Record<string, unknown>[] {
  return worker.messages.filter((message) => message.type === 'provider-response');
}

describe('engine client provider calls', () => {
  it('refuses a provider request that names another profile, model or URL than the session', async () => {
    const providerCall = vi.fn<ProviderCall>(async () => '{}');
    const worker = await startedClient(providerCall);

    worker.emit({ ...PROVIDER_REQUEST, profileId: 'prof-other' });
    worker.emit({ ...PROVIDER_REQUEST, requestId: 'provider-2', modelId: 'other/model' });
    worker.emit({
      ...PROVIDER_REQUEST,
      requestId: 'provider-3',
      baseUrl: 'https://evil.example/v1',
    });

    await vi.waitFor(() => expect(answers(worker)).toHaveLength(3));
    expect(providerCall).not.toHaveBeenCalled();
    for (const message of answers(worker)) {
      expect(message.result).toMatchObject({ ok: false, code: 'REQUEST_INVALID' });
    }
  });
  it('sends the call to the desktop with the profile, the URL and the model, and answers the Worker with the reply', async () => {
    const providerCall = vi.fn<ProviderCall>(async () => '{"choices":[]}');
    const worker = await startedClient(providerCall);

    worker.emit(PROVIDER_REQUEST);

    await vi.waitFor(() => expect(answers(worker)).toHaveLength(1));
    expect(providerCall).toHaveBeenCalledWith({
      profileId: 'prof-1',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/free',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      signal: expect.any(AbortSignal),
    });
    expect(answers(worker)[0]).toEqual({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'provider-response',
      requestId: 'provider-1',
      result: { ok: true, text: '{"choices":[]}' },
    });
  });

  it('passes a broker refusal to the Worker with its code and message, and nothing else', async () => {
    const providerCall = vi.fn<ProviderCall>(async () => {
      throw new ProviderCallError(
        'BINDING_MISMATCH',
        'Save this profile again to confirm its endpoint.',
      );
    });
    const worker = await startedClient(providerCall);

    worker.emit(PROVIDER_REQUEST);

    await vi.waitFor(() => expect(answers(worker)).toHaveLength(1));
    expect(answers(worker)[0]).toMatchObject({
      result: {
        ok: false,
        code: 'BINDING_MISMATCH',
        message: 'Save this profile again to confirm its endpoint.',
      },
    });
  });

  it('answers an unexpected failure with a network code, never with the error object', async () => {
    const providerCall = vi.fn<ProviderCall>(async () => {
      throw new TypeError('bridge went away');
    });
    const worker = await startedClient(providerCall);

    worker.emit(PROVIDER_REQUEST);

    await vi.waitFor(() => expect(answers(worker)).toHaveLength(1));
    expect(answers(worker)[0]).toEqual({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'provider-response',
      requestId: 'provider-1',
      result: { ok: false, code: 'NETWORK_ERROR', message: 'bridge went away' },
    });
  });

  it('ends the provider call the Worker cancels, and sends it no answer', async () => {
    let callSignal: AbortSignal | undefined;
    let finish: ((text: string) => void) | undefined;
    const providerCall = vi.fn<ProviderCall>(async (request) => {
      callSignal = request.signal;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const worker = await startedClient(providerCall);
    worker.emit(PROVIDER_REQUEST);
    await vi.waitFor(() => expect(providerCall).toHaveBeenCalledTimes(1));

    worker.emit({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'provider-cancel',
      requestId: 'provider-1',
    });
    expect(callSignal?.aborted).toBe(true);
    finish?.('{"choices":[]}');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(answers(worker)).toHaveLength(0);
  });

  it('ends a provider call in progress when the client clears its worker', async () => {
    let callSignal: AbortSignal | undefined;
    const providerCall = vi.fn<ProviderCall>(async (request) => {
      callSignal = request.signal;
      return new Promise<string>(() => undefined);
    });
    const worker = new RecordingWorker();
    const client = createJoyAgentEngineClient(() => worker as unknown as Worker, providerCall);
    await client.configure(CONFIG);
    worker.emit(PROVIDER_REQUEST);
    await vi.waitFor(() => expect(providerCall).toHaveBeenCalledTimes(1));

    client.clear();

    expect(callSignal?.aborted).toBe(true);
  });

  it('ignores a second provider request that reuses an id still in use, and keeps the first call', async () => {
    let callSignal: AbortSignal | undefined;
    let finish: ((text: string) => void) | undefined;
    const providerCall = vi.fn<ProviderCall>(async (request) => {
      callSignal = request.signal;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const worker = await startedClient(providerCall);
    worker.emit(PROVIDER_REQUEST);
    await vi.waitFor(() => expect(providerCall).toHaveBeenCalledTimes(1));

    worker.emit({
      ...PROVIDER_REQUEST,
      body: { messages: [{ role: 'user', content: 'a second call under the same id' }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(providerCall).toHaveBeenCalledTimes(1);
    expect(callSignal?.aborted).toBe(false);
    finish?.('{"choices":[]}');
    await vi.waitFor(() => expect(answers(worker)).toHaveLength(1));
  });

  it('waits past the status deadline for a connection test, whose provider calls take longer', async () => {
    vi.useFakeTimers();
    try {
      const worker = new RecordingWorker();
      const client = createJoyAgentEngineClient(
        () => worker as unknown as Worker,
        vi.fn<ProviderCall>(async () => '{}'),
      );
      await client.configure(CONFIG);

      const test = client.testConnection();
      await vi.advanceTimersByTimeAsync(40_000);
      worker.emit({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'test-result',
        status: {
          provider: 'openrouter',
          modelId: 'openrouter/free',
          capability: 'tool-loop',
          message: 'Structured JOY tools verified',
        },
      });

      await expect(test).resolves.toMatchObject({ capability: 'tool-loop' });
    } finally {
      vi.useRealTimers();
    }
  });
});
