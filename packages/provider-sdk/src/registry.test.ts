import { describe, expect, it } from 'vitest';
import {
  CUSTOM_PROVIDER_ID,
  PROVIDER_REGISTRY,
  REGISTRY_PROVIDER_IDS,
  endpointUrl,
  evaluateEndpoint,
  findRegistryProvider,
  findRegistryRegion,
} from './registry.js';

describe('provider registry', () => {
  it('lists each provider id once, with a fixed API style and at least one region', () => {
    expect(PROVIDER_REGISTRY.map((provider) => provider.id)).toEqual([...REGISTRY_PROVIDER_IDS]);
    for (const provider of PROVIDER_REGISTRY) {
      expect(provider.regions.length).toBeGreaterThan(0);
      expect(['chat-completions', 'anthropic-messages', 'chatgpt-responses']).toContain(
        provider.api,
      );
    }
  });

  it('speaks Anthropic Messages only for Claude', () => {
    const apis = Object.fromEntries(PROVIDER_REGISTRY.map((p) => [p.id, p.api]));
    expect(apis.claude).toBe('anthropic-messages');
    expect(apis.openai).toBe('chat-completions');
    expect(apis.kimi).toBe('chat-completions');
  });

  it('offers ChatGPT for sign-in only, over the Responses API at its own origin', () => {
    const chatgpt = findRegistryProvider('chatgpt');
    expect(chatgpt?.api).toBe('chatgpt-responses');
    expect(chatgpt?.signInOnly).toBe(true);
    expect(evaluateEndpoint('chatgpt', 'https://api.openai.com/v1')).toMatchObject({
      allowed: true,
      kind: 'registry',
    });
    expect(evaluateEndpoint('chatgpt', 'http://127.0.0.1:1234/v1').allowed).toBe(false);
  });

  it('finds a region by its exact base URL, ignoring a trailing slash', () => {
    expect(findRegistryRegion('kimi', 'https://api.moonshot.cn/v1/')?.id).toBe('china');
    expect(findRegistryRegion('kimi', 'https://api.moonshot.ai/v1')?.id).toBe('international');
    expect(findRegistryRegion('kimi', 'https://api.moonshot.ai/v2')).toBeUndefined();
  });

  it('joins an endpoint path without a double slash', () => {
    expect(endpointUrl('https://openrouter.ai/api/v1/', 'chat/completions')).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
  });
});

describe('evaluateEndpoint', () => {
  it('allows a registry region and reports its origin and base path', () => {
    expect(evaluateEndpoint('openrouter', 'https://openrouter.ai/api/v1')).toEqual({
      allowed: true,
      kind: 'registry',
      origin: 'https://openrouter.ai',
      basePath: '/api/v1',
    });
  });

  it('allows a loopback custom endpoint and reports it as loopback', () => {
    expect(evaluateEndpoint(CUSTOM_PROVIDER_ID, 'http://127.0.0.1:1234/v1')).toEqual({
      allowed: true,
      kind: 'loopback',
      origin: 'http://127.0.0.1:1234',
      basePath: '/v1',
    });
  });

  it('refuses a public custom endpoint, a foreign origin and a local address for a provider', () => {
    expect(evaluateEndpoint(CUSTOM_PROVIDER_ID, 'https://api.example.com/v1').allowed).toBe(false);
    expect(evaluateEndpoint('grok', 'https://api.example.com/v1').allowed).toBe(false);
    expect(evaluateEndpoint('grok', 'http://localhost:8080/v1').allowed).toBe(false);
  });

  it('refuses http for every remote host, even a registry origin', () => {
    expect(evaluateEndpoint('grok', 'http://api.x.ai/v1')).toMatchObject({
      allowed: false,
      code: 'BASE_URL_INSECURE',
    });
  });

  it('refuses an unparseable URL and any URL with credentials', () => {
    expect(evaluateEndpoint(CUSTOM_PROVIDER_ID, 'localhost:1234')).toMatchObject({
      allowed: false,
      code: 'BASE_URL_REFUSED',
    });
    expect(evaluateEndpoint(CUSTOM_PROVIDER_ID, 'http://a:b@127.0.0.1/v1').allowed).toBe(false);
  });
});
