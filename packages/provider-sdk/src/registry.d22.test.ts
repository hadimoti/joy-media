import { describe, expect, it } from 'vitest';
import {
  XAI_OAUTH_INFERENCE_BASE_URL,
  evaluateEndpoint,
  findRegistryProvider,
  findRegistryRegion,
  signInProviders,
} from './registry.js';

describe('D22 provider routes', () => {
  it('marks OAuth-only bases separately from API-key regions', () => {
    expect(
      findRegistryProvider('kimi')?.regions.find((region) => region.id === 'code-international')?.route,
    ).toBe('oauth');
    expect(
      findRegistryProvider('xai')?.regions.find((region) => region.id === 'oauth-international')?.route,
    ).toBe('oauth');
    expect(findRegistryRegion('kimi', 'https://api.moonshot.ai/v1')?.route).toBeUndefined();
    expect(findRegistryRegion('xai', 'https://api.x.ai/v1')?.route).toBeUndefined();
  });

  it('registers xAI API-key and OAuth bases as exact accepted regions', () => {
    for (const baseUrl of ['https://api.x.ai/v1', XAI_OAUTH_INFERENCE_BASE_URL]) {
      expect(findRegistryRegion('xai', baseUrl)?.baseUrl).toBe(baseUrl);
      expect(evaluateEndpoint('xai', baseUrl)).toMatchObject({ allowed: true, kind: 'registry' });
    }
    expect(findRegistryProvider('xai')?.auth.methods).toEqual([
      'api-key',
      'subscription-sign-in',
    ]);
    expect(findRegistryProvider('xai')?.auth).toMatchObject({ gated: true, unverified: true });
    expect(signInProviders()).toEqual(['minimax', 'kimi', 'chatgpt', 'xai']);
  });

  it('registers DeepSeek and Kilo as API-key-only provider routes', () => {
    const routes = [
      ['deepseek', 'https://api.deepseek.com'],
      ['kilo', 'https://ai-gateway.kilo.ai/api/v1'],
    ] as const;
    for (const [provider, baseUrl] of routes) {
      expect(findRegistryRegion(provider, baseUrl)?.baseUrl).toBe(baseUrl);
      expect(evaluateEndpoint(provider, baseUrl)).toMatchObject({ allowed: true, kind: 'registry' });
      expect(findRegistryProvider(provider)?.auth.methods).toEqual(['api-key']);
      expect(signInProviders()).not.toContain(provider);
    }
    for (const provider of ['openrouter', 'claude', 'gemini']) {
      expect(signInProviders()).not.toContain(provider);
    }
    expect(findRegistryProvider('claude')?.api).toBe('anthropic-messages');
  });
});
