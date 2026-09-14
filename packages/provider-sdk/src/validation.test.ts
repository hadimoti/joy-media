import { describe, expect, it } from 'vitest';
import { validateProviderProfileInput } from './validation.js';

describe('validateProviderProfileInput', () => {
  it('accepts a well-formed openai-compatible https profile', () => {
    expect(
      validateProviderProfileInput({
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'gpt-4o-mini',
      }),
    ).toEqual([]);
  });

  it('accepts http:// only to a loopback host (local OpenAI-compatible servers)', () => {
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
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelId: 'llama3',
      }),
    ).toEqual([]);
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
