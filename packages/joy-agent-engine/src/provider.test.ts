import { describe, expect, it, vi } from 'vitest';
import { createHardenedFetch } from './provider.js';
import type { JoyFetch } from './provider.js';
import { normalizeByokSessionConfig } from './provider-config.js';

function response(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', ...init?.headers },
    ...init,
  });
}

describe('hardened provider fetch', () => {
  it('pins origin and safe request options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response('{}')) as unknown as JoyFetch;
    const fetcher = createHardenedFetch('https://provider.example/v1', fetchImpl);
    await fetcher('https://provider.example/v1/chat/completions', {
      headers: { Authorization: 'Bearer session-key' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://provider.example/v1/chat/completions',
      expect.objectContaining({
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      }),
    );
    await expect(fetcher('https://other.example/v1/chat/completions')).rejects.toThrow(
      'JOY_AGENT_CORS_OR_NETWORK',
    );
  });

  it.each(['http://localhost:1234/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:1234/v1'])(
    'accepts local HTTP provider URL %s',
    (baseUrl) => {
      expect(() =>
        normalizeByokSessionConfig({
          provider: 'openai-compatible',
          baseUrl,
          modelId: 'local-model',
          apiKey: 'local-no-key-required',
        }),
      ).not.toThrow();
    },
  );

  it('rejects non-loopback HTTP provider URLs with the stable configuration error', () => {
    expect(() =>
      normalizeByokSessionConfig({
        provider: 'openai-compatible',
        baseUrl: 'http://provider.example/v1',
        modelId: 'model',
        apiKey: 'fake',
      }),
    ).toThrow('INSECURE_PROVIDER_URL');
  });

  it('rejects a redirect response crossing the configured origin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response('{}', { status: 200 }));
    const fetcher = createHardenedFetch('https://provider.example/v1', fetchImpl);
    const redirectResponse = response('{}');
    Object.defineProperty(redirectResponse, 'url', {
      value: 'https://other.example/redirect',
      configurable: true,
    });
    fetchImpl.mockResolvedValue(redirectResponse);
    await expect(fetcher('https://provider.example/v1/chat/completions')).rejects.toThrow(
      'JOY_AGENT_CORS_OR_NETWORK',
    );
  });

  it('bounds content-length and streamed bodies without exposing the body', async () => {
    const tooLarge = response('x'.repeat(12), { headers: { 'content-length': '12' } });
    const fetcher = createHardenedFetch(
      'https://provider.example/v1',
      vi.fn().mockResolvedValue(tooLarge),
      8,
    );
    await expect(fetcher('https://provider.example/v1/chat/completions')).rejects.toThrow(
      'JOY_AGENT_RESPONSE_TOO_LARGE',
    );

    const streamed = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('123456789'));
          controller.close();
        },
      }),
    );
    const bounded = createHardenedFetch(
      'https://provider.example/v1',
      vi.fn().mockResolvedValue(streamed),
      8,
    );
    const result = await bounded('https://provider.example/v1/chat/completions');
    await expect(result.text()).rejects.toThrow();
  });
});
