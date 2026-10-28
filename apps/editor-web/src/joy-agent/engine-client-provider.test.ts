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
});
