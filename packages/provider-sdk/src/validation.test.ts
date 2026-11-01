import { describe, expect, it } from 'vitest';
import { validateProviderProfileInput } from './validation.js';

describe('validateProviderProfileInput', () => {
  it('accepts a registry provider at its exact base URL', () => {
    expect(
      validateProviderProfileInput({
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'openai/gpt-4o-mini',
      }),
    ).toEqual([]);
  });

  it('accepts the China region of a registry provider that offers one', () => {
    expect(
      validateProviderProfileInput({
        provider: 'kimi',
        baseUrl: 'https://api.moonshot.cn/v1/',
        modelId: 'moonshot-v1-8k',
      }),
    ).toEqual([]);
  });

  it('refuses a registry provider at a URL that is not one of its regions', () => {
    const issues = validateProviderProfileInput({
      provider: 'openrouter',
      baseUrl: 'https://example.com/v1',
      modelId: 'x',
    });
    expect(issues).toEqual([{ code: 'BASE_URL_REFUSED', message: expect.any(String) }]);
  });

  it('accepts a custom endpoint on a loopback host over http or https', () => {
    expect(
      validateProviderProfileInput({
        provider: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        modelId: 'llama3',
      }),
    ).toEqual([]);
    expect(
      validateProviderProfileInput({
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1234/v1',
        modelId: 'llama3',
      }),
    ).toEqual([]);
  });

  it('refuses IPv6 loopback for a custom endpoint (S4)', () => {
    const issues = validateProviderProfileInput({
      provider: 'openai-compatible',
      baseUrl: 'http://[::1]:11434/v1',
      modelId: 'llama3',
    });
    expect(issues).toEqual([{ code: 'BASE_URL_REFUSED', message: expect.any(String) }]);
  });

  it('refuses a public custom endpoint until the owner acknowledges it (S8)', () => {
    const input = {
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'gpt-4o-mini',
    };
    expect(validateProviderProfileInput(input)).toEqual([
      { code: 'CONSENT_REQUIRED', message: expect.any(String) },
    ]);
    expect(validateProviderProfileInput({ ...input, acknowledgedPublicEndpoint: true })).toEqual(
      [],
    );
  });

  it('refuses a loopback address for a registry provider', () => {
    const issues = validateProviderProfileInput({
      provider: 'openrouter',
      baseUrl: 'http://127.0.0.1:8080/api/v1',
      modelId: 'x',
    });
    expect(issues).toEqual([{ code: 'BASE_URL_REFUSED', message: expect.any(String) }]);
  });

  it('refuses a base URL that carries credentials, a query or a fragment', () => {
    for (const baseUrl of [
      'http://user:pass@localhost:1234/v1',
      'http://localhost:1234/v1?key=1',
      'http://localhost:1234/v1#x',
    ]) {
      const issues = validateProviderProfileInput({
        provider: 'openai-compatible',
        baseUrl,
        modelId: 'llama3',
      });
      expect(issues).toEqual([{ code: 'BASE_URL_REFUSED', message: expect.any(String) }]);
    }
  });

  it('rejects http:// to a non-loopback host', () => {
    const issues = validateProviderProfileInput({
      provider: 'openai-compatible',
      baseUrl: 'http://api.example.com/v1',
      modelId: 'gpt-4o-mini',
    });
    expect(issues).toEqual([{ code: 'BASE_URL_INSECURE', message: expect.any(String) }]);
  });

  it('rejects a malformed base URL', () => {
    const issues = validateProviderProfileInput({
      provider: 'openrouter',
      baseUrl: 'not-a-url',
      modelId: 'x',
    });
    expect(issues).toEqual([{ code: 'BASE_URL_INVALID', message: expect.any(String) }]);
  });

  it('rejects an unsupported provider', () => {
    const issues = validateProviderProfileInput({
      provider: 'some-other-provider',
      baseUrl: 'https://api.example.com',
      modelId: 'x',
    });
    expect(issues).toContainEqual({ code: 'PROVIDER_UNSUPPORTED', message: expect.any(String) });
  });

  it('rejects an empty model id', () => {
    const issues = validateProviderProfileInput({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: '   ',
    });
    expect(issues).toContainEqual({ code: 'MODEL_ID_REQUIRED', message: expect.any(String) });
  });

  it('reports every violated rule, not just the first', () => {
    const issues = validateProviderProfileInput({
      provider: 'unsupported',
      baseUrl: 'http://api.example.com',
      modelId: '',
    });
    const codes = issues.map((issue) => issue.code).sort();
    expect(codes).toEqual(['BASE_URL_INSECURE', 'MODEL_ID_REQUIRED', 'PROVIDER_UNSUPPORTED']);
  });
});
