import { describe, expect, it } from 'vitest';
import {
  normalizeByokSessionConfig,
  normalizeCustomBaseUrl,
  OPENROUTER_BASE_URL,
  safeByokSessionStatus,
} from './provider-config.js';

const key = 'session-key';

describe('BYOK provider configuration', () => {
  it.each(['joy-hosted', 'kilo'] as const)('refuses the retired %s profile', (provider) => {
    expect(() => normalizeByokSessionConfig({ provider, modelId: 'model', apiKey: key })).toThrow(
      'JOY_AGENT_PROVIDER_CONFIG_INVALID',
    );
  });

  it('normalizes the OpenRouter preset and returns secret-free status', () => {
    const config = normalizeByokSessionConfig({
      provider: 'openrouter',
      baseUrl: `${OPENROUTER_BASE_URL}/`,
      modelId: 'openai/model',
      apiKey: key,
    });
    expect(config.baseUrl).toBe(OPENROUTER_BASE_URL);
    expect(safeByokSessionStatus(config, 'tool-loop')).toEqual({
      provider: 'openrouter',
      modelId: 'openai/model',
      capability: 'tool-loop',
    });
    expect(JSON.stringify(safeByokSessionStatus(config))).not.toContain(key);
  });

  it('accepts a loopback endpoint for a local AI server, over http or https', () => {
    expect(normalizeCustomBaseUrl('http://127.0.0.1:1234/v1/')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeCustomBaseUrl('http://localhost:1234/v1')).toBe('http://localhost:1234/v1');
    expect(normalizeCustomBaseUrl('https://localhost/v1')).toBe('https://localhost/v1');
  });

  it('refuses a public endpoint until S8 is confirmed, and a completion endpoint', () => {
    expect(() => normalizeCustomBaseUrl('https://provider.example/v1')).toThrow(
      'JOY_AGENT_PROVIDER_CONFIG_INVALID',
    );
    expect(() => normalizeCustomBaseUrl('http://127.0.0.1:1234/v1/chat/completions')).toThrow(
      'JOY_AGENT_PROVIDER_CONFIG_INVALID',
    );
  });

  it.each([
    'http://provider.example/v1',
    'https://user:pass@provider.example/v1',
    'https://provider.example/v1?token=secret',
    'https://provider.example/v1#fragment',
    'https://169.254.169.254/v1',
    'https://192.168.1.1/v1',
    'https://10.0.0.4/v1',
    'http://[::1]:1234/v1',
    'https://[::ffff:7f00:1]/v1',
  ])('rejects unsafe custom URL %s', (url) => {
    expect(() => normalizeCustomBaseUrl(url)).toThrow('JOY_AGENT_PROVIDER_CONFIG_INVALID');
  });

  it('bounds model IDs and API keys', () => {
    expect(() =>
      normalizeByokSessionConfig({ provider: 'openrouter', modelId: '', apiKey: key }),
    ).toThrow();
    expect(() =>
      normalizeByokSessionConfig({ provider: 'openrouter', modelId: 'm', apiKey: 'x'.repeat(513) }),
    ).toThrow();
    expect(() =>
      normalizeByokSessionConfig({ provider: 'openrouter', modelId: 'm'.repeat(257), apiKey: key }),
    ).toThrow();
  });
});

describe('a public custom endpoint in the engine (S8)', () => {
  it('accepts a public https endpoint only with the owner consent', () => {
    expect(
      normalizeCustomBaseUrl('https://provider.example/v1/', { consentToPublicEndpoint: true }),
    ).toBe('https://provider.example/v1');
    expect(
      normalizeByokSessionConfig({
        provider: 'custom',
        baseUrl: 'https://provider.example/v1',
        modelId: 'model',
        apiKey: key,
        consentToPublicEndpoint: true,
      }).baseUrl,
    ).toBe('https://provider.example/v1');
  });

  it('refuses a private address even with the owner consent', () => {
    expect(() =>
      normalizeCustomBaseUrl('https://192.168.1.1/v1', { consentToPublicEndpoint: true }),
    ).toThrow('JOY_AGENT_PROVIDER_CONFIG_INVALID');
  });
});
