import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { generateText } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { normalizeByokSessionConfig } from '@joy-media/joy-agent-engine';
import {
  createModelFromConfig,
  createProviderTransport,
  type ProviderTraffic,
} from './provider.js';
import type { HttpsRequest } from './public-endpoint-fetch.js';

const CHAT_REPLY = JSON.stringify({
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1,
  model: 'local-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

/** Stands in for https.request: it records each call and answers with a chat reply. No socket opens. */
function fakeHttps() {
  const calls: Record<string, unknown>[] = [];
  const request = vi.fn(
    (options: Record<string, unknown>, onResponse: (res: IncomingMessage) => void) => {
      calls.push(options);
      return Object.assign(new EventEmitter(), {
        write: (): boolean => true,
        destroy: (): void => undefined,
        end: (): void => {
          const res = Readable.from([Buffer.from(CHAT_REPLY)]);
          Object.assign(res, {
            statusCode: 200,
            statusMessage: 'OK',
            headers: { 'content-type': 'application/json' },
          });
          onResponse(res as unknown as IncomingMessage);
        },
      });
    },
  );
  return { request: request as unknown as HttpsRequest, mock: request, calls };
}

function okFetch() {
  return vi.fn(
    async () =>
      new Response(CHAT_REPLY, { status: 200, headers: { 'content-type': 'application/json' } }),
  );
}

const PUBLIC_CUSTOM = normalizeByokSessionConfig({
  provider: 'custom',
  baseUrl: 'https://api.example.com/v1',
  modelId: 'local-model',
  apiKey: 'sk-test-not-a-real-key',
  consentToPublicEndpoint: true,
});

const LOOPBACK_CUSTOM = normalizeByokSessionConfig({
  provider: 'custom',
  baseUrl: 'http://127.0.0.1:1234/v1',
  modelId: 'local-model',
  apiKey: 'local-key',
});

// The CLI passes the owner's consent for a registry provider's public URL, so the engine accepts it.
const REGISTRY = normalizeByokSessionConfig({
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  modelId: 'gpt-4o',
  apiKey: 'sk-test-not-a-real-key',
  consentToPublicEndpoint: true,
});

describe('the provider transport for a public custom endpoint', () => {
  it('sends the model request through the vetted transport and never through the global fetch', async () => {
    const globalFetch = okFetch();
    const https = fakeHttps();
    const resolveHost = vi.fn(async (_hostname: string) => ['93.184.216.34']);
    const traffic: ProviderTraffic = { requests: 0 };
    const model = createModelFromConfig(PUBLIC_CUSTOM, traffic, {
      fetch: globalFetch,
      request: https.request,
      resolveHost,
    });

    const result = await generateText({ model, prompt: 'Say hello.', maxRetries: 0 });

    expect(result.text).toBe('ok');
    expect(resolveHost).toHaveBeenCalledWith('api.example.com');
    expect(https.mock).toHaveBeenCalledTimes(1);
    expect(https.calls[0]).toMatchObject({
      hostname: 'api.example.com',
      path: '/v1/chat/completions',
      servername: 'api.example.com',
    });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(traffic.requests).toBe(1);
  });

  it('records the refusal and never falls back to the global fetch when the name resolves privately', async () => {
    const globalFetch = okFetch();
    const https = fakeHttps();
    const traffic: ProviderTraffic = { requests: 0 };
    const model = createModelFromConfig(PUBLIC_CUSTOM, traffic, {
      fetch: globalFetch,
      request: https.request,
      resolveHost: async () => ['10.0.0.7'],
    });

    await expect(generateText({ model, prompt: 'Say hello.', maxRetries: 0 })).rejects.toThrow();

    expect(globalFetch).not.toHaveBeenCalled();
    expect(https.mock).not.toHaveBeenCalled();
    expect(traffic.networkErrorCode).toBe('ENDPOINT_REFUSED');
  });

  it('keeps the global fetch and resolves nothing for a loopback endpoint', async () => {
    const globalFetch = okFetch();
    const https = fakeHttps();
    const resolveHost = vi.fn(async (_hostname: string) => ['93.184.216.34']);
    const transport = createProviderTransport(LOOPBACK_CUSTOM, {
      fetch: globalFetch,
      request: https.request,
      resolveHost,
    });

    await transport('http://127.0.0.1:1234/v1/models', {});

    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(resolveHost).not.toHaveBeenCalled();
    expect(https.mock).not.toHaveBeenCalled();
  });

  it('keeps the global fetch and resolves nothing for a registry endpoint', async () => {
    const globalFetch = okFetch();
    const https = fakeHttps();
    const resolveHost = vi.fn(async (_hostname: string) => ['93.184.216.34']);
    const transport = createProviderTransport(REGISTRY, {
      fetch: globalFetch,
      request: https.request,
      resolveHost,
    });

    await transport('https://api.openai.com/v1/models', {});

    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(resolveHost).not.toHaveBeenCalled();
    expect(https.mock).not.toHaveBeenCalled();
  });
});
