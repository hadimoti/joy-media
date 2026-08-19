import { describe, expect, it, vi } from 'vitest';
import {
  OPENROUTER_CHAT_COMPLETIONS_URL,
  OpenRouterHttpPostTransport,
} from './openrouter-http-transport.js';

describe('OpenRouterHttpPostTransport', () => {
  it('forwards the exact fixed-origin chat-completions request', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const transport = new OpenRouterHttpPostTransport(fetchImpl);
    const options: RequestInit = {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    };

    const response = await transport.post(OPENROUTER_CHAT_COMPLETIONS_URL, options);

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(OPENROUTER_CHAT_COMPLETIONS_URL, options);
  });

  it('rejects alternate origins before calling fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const transport = new OpenRouterHttpPostTransport(fetchImpl);

    await expect(
      transport.post('https://evil.example/api/v1/chat/completions', { method: 'POST' }),
    ).rejects.toThrow('fixed OpenRouter origin');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects alternate paths and query strings before calling fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const transport = new OpenRouterHttpPostTransport(fetchImpl);

    await expect(
      transport.post('https://openrouter.ai/api/v1/models', { method: 'POST' }),
    ).rejects.toThrow('fixed OpenRouter endpoint');
    await expect(
      transport.post(`${OPENROUTER_CHAT_COMPLETIONS_URL}?redirect=1`, { method: 'POST' }),
    ).rejects.toThrow('fixed OpenRouter endpoint');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('propagates fetch failures and caller abort signals', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, options?: RequestInit) => {
      expect(options?.signal).toBeDefined();
      throw new Error('network failure');
    });
    const transport = new OpenRouterHttpPostTransport(fetchImpl);
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.post(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        signal: controller.signal,
      }),
    ).rejects.toThrow('network failure');
  });
});
