import { describe, expect, it, vi } from 'vitest';
import { createSingleWorkerEngineClient } from './engine-client.js';
import { JOY_AGENT_PROTOCOL_VERSION } from './protocol.js';
import type { ProviderCallRequest } from './provider-call.js';

/** A Worker that confirms the configuration, and can then ask for one provider call, as the real Worker does. */
class SlotWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly messages: Array<Record<string, unknown>> = [];
  private config: Record<string, string> = {};

  postMessage(message: unknown): void {
    const sent = message as Record<string, unknown>;
    this.messages.push(sent);
    if (sent['type'] !== 'configure') return;
    this.config = sent['config'] as Record<string, string>;
    queueMicrotask(() =>
      this.emit({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'configured',
        status: {
          provider: this.config['provider'],
          modelId: this.config['modelId'],
          capability: 'untested',
        },
      }),
    );
  }

  /** The Worker asks the main thread for one provider call in the configured session. */
  askForProviderCall(): void {
    this.emit({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'provider-request',
      requestId: 'provider-call-1',
      profileId: this.config['profileId'],
      baseUrl: this.config['baseUrl'],
      modelId: this.config['modelId'],
      body: { messages: [{ role: 'user', content: 'hello' }] },
    });
  }

  terminate(): void {}

  private emit(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

describe('an agent slot session', () => {
  it('passes its slot to the provider call, and never sends the slot to the Worker', async () => {
    const worker = new SlotWorker();
    const providerCall = vi.fn(async (_request: ProviderCallRequest) => 'reply');
    const client = createSingleWorkerEngineClient(() => worker as unknown as Worker, providerCall);

    await client.configure({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1234/v1',
      modelId: 'llama3',
      profileId: 'profile-local',
      slot: 'creative',
    });
    worker.askForProviderCall();

    await vi.waitFor(() => expect(providerCall).toHaveBeenCalledTimes(1));
    expect(providerCall).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-local',
        baseUrl: 'http://127.0.0.1:1234/v1',
        modelId: 'llama3',
        slot: 'creative',
      }),
    );
    const configure = worker.messages.find((message) => message['type'] === 'configure');
    expect(configure?.['config']).not.toHaveProperty('slot');
  });

  it('sends no slot field for a session that runs in no slot', async () => {
    const worker = new SlotWorker();
    const providerCall = vi.fn(async (_request: ProviderCallRequest) => 'reply');
    const client = createSingleWorkerEngineClient(() => worker as unknown as Worker, providerCall);

    await client.configure({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1234/v1',
      modelId: 'llama3',
      profileId: 'profile-local',
    });
    worker.askForProviderCall();

    await vi.waitFor(() => expect(providerCall).toHaveBeenCalledTimes(1));
    expect(providerCall.mock.calls[0]?.[0]).not.toHaveProperty('slot');
  });
});
