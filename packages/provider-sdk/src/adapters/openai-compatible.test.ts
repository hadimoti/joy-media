import { describe, expect, it, vi } from 'vitest';
import { probeOpenAiCompatibleProvider } from './openai-compatible.js';
import type { FetchLike, FetchResponseLike } from './openai-compatible.js';

function fakeFetch(response: FetchResponseLike): FetchLike {
  return vi.fn(async () => response);
}

describe('probeOpenAiCompatibleProvider', () => {
  it('reports ok on a healthy 200 response', async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200, text: async () => '{"choices":[]}' });
    const report = await probeOpenAiCompatibleProvider(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', modelId: 'gpt-4o-mini' },
      fetchImpl,
    );
    expect(report).toEqual({ ok: true, modelId: 'gpt-4o-mini' });
  });

  it('posts to <baseUrl>/chat/completions with a Bearer header and the given model', async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200, text: async () => '{}' });
    await probeOpenAiCompatibleProvider(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', modelId: 'gpt-4o-mini' },
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer sk-secret' }),
      }),
    );
    const [, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(JSON.parse(init.body)).toMatchObject({ model: 'gpt-4o-mini' });
  });

  it('maps a 401 to AUTH_FAILED without leaking the response body', async () => {
    const fetchImpl = fakeFetch({
      ok: false,
      status: 401,
      text: async () => 'secret-leaking-body',
    });
    const report = await probeOpenAiCompatibleProvider(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', modelId: 'gpt-4o-mini' },
      fetchImpl,
    );
    expect(report.ok).toBe(false);
    expect(report.errorCode).toBe('AUTH_FAILED');
    expect(JSON.stringify(report)).not.toContain('secret-leaking-body');
    expect(JSON.stringify(report)).not.toContain('sk-secret');
  });

  it('maps a non-401/403 error status to PROVIDER_INCOMPATIBLE', async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 500, text: async () => 'oops' });
    const report = await probeOpenAiCompatibleProvider(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'k', modelId: 'm' },
      fetchImpl,
    );
    expect(report.errorCode).toBe('PROVIDER_INCOMPATIBLE');
  });

  it('maps an oversized response to RESPONSE_TOO_LARGE', async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200, text: async () => 'x'.repeat(5000) });
    const report = await probeOpenAiCompatibleProvider(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'k', modelId: 'm' },
      fetchImpl,
    );
    expect(report.errorCode).toBe('RESPONSE_TOO_LARGE');
  });

  it('maps a rejected fetch to NETWORK_ERROR', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const report = await probeOpenAiCompatibleProvider(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'k', modelId: 'm' },
      fetchImpl,
    );
    expect(report.errorCode).toBe('NETWORK_ERROR');
  });

  it('maps an AbortError (timeout) to TIMEOUT', async () => {
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw abortError;
    });
    const report = await probeOpenAiCompatibleProvider(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'k', modelId: 'm' },
      fetchImpl,
      { timeoutMs: 5 },
    );
    expect(report.errorCode).toBe('TIMEOUT');
  });

  it('reports PROVIDER_INCOMPATIBLE for an unresolvable base URL without calling fetch', async () => {
    const fetchImpl: FetchLike = vi.fn();
    const report = await probeOpenAiCompatibleProvider(
      { baseUrl: 'not a url', apiKey: 'k', modelId: 'm' },
      fetchImpl,
    );
    expect(report.errorCode).toBe('PROVIDER_INCOMPATIBLE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
