import { describe, expect, it } from 'vitest';
import {
  XAI_OAUTH_INFERENCE_BASE_URL,
  defaultBaseUrl,
  evaluateEndpoint,
  findRegistryProvider,
  findRegistryRegion,
  permittedAuthMethods,
  signInProviders,
} from './registry.js';

describe('D22 provider routes', () => {
  it('marks OAuth-only bases separately from API-key regions', () => {
    expect(
      findRegistryProvider('kimi')?.regions.find((region) => region.id === 'code-international')
        ?.route,
    ).toBe('oauth');
    expect(
      findRegistryProvider('xai')?.regions.find((region) => region.id === 'oauth-international')
        ?.route,
    ).toBe('oauth');
    expect(findRegistryRegion('kimi', 'https://api.moonshot.ai/v1')?.route).toBeUndefined();
    expect(findRegistryRegion('xai', 'https://api.x.ai/v1')?.route).toBeUndefined();
  });

  it('registers xAI API-key and OAuth bases as exact accepted regions', () => {
    for (const baseUrl of ['https://api.x.ai/v1', XAI_OAUTH_INFERENCE_BASE_URL]) {
      expect(findRegistryRegion('xai', baseUrl)?.baseUrl).toBe(baseUrl);
      expect(evaluateEndpoint('xai', baseUrl)).toMatchObject({ allowed: true, kind: 'registry' });
    }
    expect(findRegistryProvider('xai')?.auth.methods).toEqual(['api-key', 'subscription-sign-in']);
    expect(findRegistryProvider('xai')?.auth.gated).toBeUndefined();
    expect(findRegistryProvider('xai')?.auth.unverified).toBeUndefined();
    expect(signInProviders()).toEqual(['kimi', 'chatgpt', 'xai']);
  });

  it('registers DeepSeek and leaves Kilo unregistered until its fixed integration is verified', () => {
    const routes = [['deepseek', 'https://api.deepseek.com']] as const;
    for (const [provider, baseUrl] of routes) {
      expect(findRegistryRegion(provider, baseUrl)?.baseUrl).toBe(baseUrl);
      expect(evaluateEndpoint(provider, baseUrl)).toMatchObject({
        allowed: true,
        kind: 'registry',
      });
      expect(findRegistryProvider(provider)?.auth.methods).toEqual(['api-key']);
      expect(signInProviders()).not.toContain(provider);
    }
    expect(findRegistryProvider('kilo')).toBeUndefined();
    expect(findRegistryRegion('kilo', 'https://ai-gateway.kilo.ai/api/v1')).toBeUndefined();
    expect(defaultBaseUrl('kilo')).toBeUndefined();
    expect(permittedAuthMethods('kilo')).toEqual([]);
    expect(signInProviders()).not.toContain('kilo');
    for (const provider of ['openrouter', 'claude', 'gemini']) {
      expect(signInProviders()).not.toContain(provider);
    }
    expect(findRegistryProvider('claude')?.api).toBe('anthropic-messages');
  });
});
