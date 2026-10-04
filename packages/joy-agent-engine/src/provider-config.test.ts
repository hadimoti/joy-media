import { describe, expect, it } from 'vitest';
import {
  normalizeByokSessionConfig,
  normalizeCustomBaseUrl,
  OPENROUTER_BASE_URL,
  safeByokSessionStatus,
} from './provider-config.js';

const key = 'session-key';

describe('BYOK provider configuration', () => {
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

  it('accepts a custom HTTPS base URL but not a completion endpoint', () => {
    expect(normalizeCustomBaseUrl('https://provider.example/v1/')).toBe(
      'https://provider.example/v1',
    );
    expect(() => normalizeCustomBaseUrl('https://provider.example/v1/chat/completions')).toThrow(
      'JOY_AGENT_PROVIDER_CONFIG_INVALID',
    );
  });

  it.each([
    ['http://provider.example/v1', 'INSECURE_PROVIDER_URL'],
    ['https://user:pass@provider.example/v1', 'JOY_AGENT_PROVIDER_CONFIG_INVALID'],
    ['https://provider.example/v1?token=secret', 'JOY_AGENT_PROVIDER_CONFIG_INVALID'],
    ['https://provider.example/v1#fragment', 'JOY_AGENT_PROVIDER_CONFIG_INVALID'],
    ['https://localhost/v1', 'JOY_AGENT_PROVIDER_CONFIG_INVALID'],
    ['https://127.0.0.1/v1', 'JOY_AGENT_PROVIDER_CONFIG_INVALID'],
    ['https://[::ffff:7f00:1]/v1', 'JOY_AGENT_PROVIDER_CONFIG_INVALID'],
    ['https://[::1]/v1', 'JOY_AGENT_PROVIDER_CONFIG_INVALID'],
    ['https://169.254.169.254/v1', 'JOY_AGENT_PROVIDER_CONFIG_INVALID'],
    ['https://192.168.1.1/v1', 'JOY_AGENT_PROVIDER_CONFIG_INVALID'],
    ['https://10.0.0.4/v1', 'JOY_AGENT_PROVIDER_CONFIG_INVALID'],
  ])('rejects unsafe public-web URL %s', (url, code) => {
    expect(() => normalizeCustomBaseUrl(url)).toThrow(code);
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
