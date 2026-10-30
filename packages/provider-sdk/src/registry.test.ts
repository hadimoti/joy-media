import { describe, expect, it } from 'vitest';
import {
  CUSTOM_PROVIDER_AUTH,
  CUSTOM_PROVIDER_ID,
  PROVIDER_REGISTRY,
  REGISTRY_PROVIDER_IDS,
  XAI_OAUTH_INFERENCE_BASE_URL,
  defaultBaseUrl,
  endpointUrl,
  evaluateEndpoint,
  findRegistryProvider,
  findRegistryRegion,
  isAuthGated,
  isAuthMethodPermitted,
  isSignInProvider,
  offeredAuthMethods,
  permittedAuthMethods,
  signInProviders,
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

  it('keeps the ChatGPT API and sign-in routes while adding xAI, DeepSeek, and Kilo', () => {
    expect(REGISTRY_PROVIDER_IDS).toEqual([
      'openai',
      'grok',
      'claude',
      'minimax',
      'gemini',
      'kimi',
      'openrouter',
      'chatgpt',
      'xai',
      'deepseek',
      'kilo',
    ]);
    expect(findRegistryProvider('openai')?.auth.methods).toEqual(['api-key']);
    expect(findRegistryProvider('chatgpt')?.auth.methods).toEqual(['subscription-sign-in']);
    expect(findRegistryProvider('chatgpt')?.signInOnly).toBe(true);
    expect(findRegistryProvider('claude')?.api).toBe('anthropic-messages');
    expect(findRegistryProvider('minimax')?.auth).toMatchObject({ gated: true, unverified: true });
    expect(findRegistryProvider('kimi')?.auth).toMatchObject({ gated: true, unverified: true });
  });

  it('registers exact D22 API and OAuth bases that pass the endpoint policy', () => {
    const bases = [
      ['openai', 'https://api.openai.com/v1'],
      ['kimi', 'https://api.moonshot.ai/v1'],
      ['minimax', 'https://api.minimax.io/v1'],
      ['xai', 'https://api.x.ai/v1'],
      ['kimi', 'https://api.kimi.ai/coding/v1'],
      ['deepseek', 'https://api.deepseek.com'],
      ['kilo', 'https://ai-gateway.kilo.ai/api/v1'],
    ] as const;
    for (const [provider, baseUrl] of bases) {
      expect(findRegistryRegion(provider, baseUrl)?.baseUrl).toBe(baseUrl);
      expect(evaluateEndpoint(provider, baseUrl)).toMatchObject({
        allowed: true,
        kind: 'registry',
      });
    }
    expect(defaultBaseUrl('xai')).toBe('https://api.x.ai/v1');
    expect(defaultBaseUrl('deepseek')).toBe('https://api.deepseek.com');
    expect(defaultBaseUrl('kilo')).toBe('https://ai-gateway.kilo.ai/api/v1');
  });

  it('uses the verified xAI base for both routes and resolves the API-key region first', () => {
    const xai = findRegistryProvider('xai');
    expect(XAI_OAUTH_INFERENCE_BASE_URL).toBe('https://api.x.ai/v1');
    expect(xai?.regions.map(({ id, baseUrl }) => [id, baseUrl])).toEqual([
      ['international', 'https://api.x.ai/v1'],
      ['oauth-international', 'https://api.x.ai/v1'],
    ]);
    expect(xai?.regions[1]).toMatchObject({
      label: 'OAuth inference (xAI API)',
      docsUrl: 'https://docs.x.ai/docs/api-reference',
      route: 'oauth',
    });
    expect(findRegistryRegion('xai', 'https://api.x.ai/v1')?.id).toBe('international');
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
    expect(findRegistryRegion('kimi', 'https://api.kimi.ai/coding/v1')?.id).toBe('code-international');
    expect(evaluateEndpoint('kimi', 'https://api.kimi.ai/coding/v1')).toMatchObject({
      allowed: true,
      kind: 'registry',
    });
  });

  it('gives a registry provider its first region as the default, and no default to any other id', () => {
    expect(defaultBaseUrl('openrouter')).toBe('https://openrouter.ai/api/v1');
    expect(defaultBaseUrl('minimax')).toBe('https://api.minimax.io/v1');
    expect(defaultBaseUrl('kilo')).toBe('https://ai-gateway.kilo.ai/api/v1');
    expect(defaultBaseUrl(CUSTOM_PROVIDER_ID)).toBeUndefined();
  });

  it('joins an endpoint path without a double slash', () => {
    expect(endpointUrl('https://openrouter.ai/api/v1/', 'chat/completions')).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
  });
});

describe('permitted authentication (PLAN-v4 §6d-1)', () => {
  it('gives every provider a permitted authentication, with its source and a date', () => {
    for (const provider of PROVIDER_REGISTRY) {
      expect(provider.auth.methods.length, provider.id).toBeGreaterThan(0);
      expect(provider.auth.source, provider.id).not.toBe('');
      expect(provider.auth.sourceDate, provider.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(provider.auth.note, provider.id).not.toBe('');
    }
  });

  it('keeps permitted sign-in methods separate from gated generic auth methods', () => {
    const withSignIn = PROVIDER_REGISTRY.filter((provider) =>
      provider.auth.methods.includes('subscription-sign-in'),
    ).map((provider) => provider.id);
    expect(withSignIn).toEqual(['minimax', 'kimi', 'chatgpt', 'xai']);
    expect(permittedAuthMethods('chatgpt')).toEqual(['subscription-sign-in']);
    expect(isAuthGated('chatgpt')).toBe(true);
    expect(offeredAuthMethods('chatgpt')).toEqual([]);
    expect(permittedAuthMethods('minimax')).toEqual(['api-key', 'subscription-sign-in']);
    expect(isAuthGated('minimax')).toBe(true);
    expect(offeredAuthMethods('minimax')).toEqual([]);
    expect(permittedAuthMethods('kimi')).toEqual(['api-key', 'subscription-sign-in']);
    expect(isAuthGated('kimi')).toBe(true);
    expect(offeredAuthMethods('kimi')).toEqual([]);
    expect(permittedAuthMethods('xai')).toEqual(['api-key', 'subscription-sign-in']);
    expect(isSignInProvider('xai')).toBe(true);
    const xaiAuth = findRegistryProvider('xai')?.auth;
    expect(xaiAuth?.gated).toBeUndefined();
    expect(xaiAuth?.unverified).toBeUndefined();
    expect(xaiAuth?.note).toMatch(/base.*entitlement.*model access/i);
    expect(offeredAuthMethods('xai')).toEqual(['api-key', 'subscription-sign-in']);
  });

  it('lists the four owner-selected OAuth providers on the sign-in surface', () => {
    // The registry lists them in its own order; the settings panel decides the order of its buttons.
    expect(signInProviders()).toEqual(['minimax', 'kimi', 'chatgpt', 'xai']);
    expect(isSignInProvider('chatgpt')).toBe(true);
    expect(isSignInProvider('kimi')).toBe(true);
    expect(isSignInProvider('minimax')).toBe(true);
    expect(isSignInProvider('xai')).toBe(true);
  });

  it('never offers a sign-in for a provider that is set up with an API key', () => {
    for (const provider of PROVIDER_REGISTRY) {
      if (
        provider.id === 'chatgpt' ||
        provider.id === 'kimi' ||
        provider.id === 'minimax' ||
        provider.id === 'xai'
      )
        continue;
      expect(isSignInProvider(provider.id), provider.id).toBe(false);
    }
    expect(isSignInProvider('openrouter')).toBe(false);
    expect(isSignInProvider('claude')).toBe(false);
    expect(isSignInProvider('gemini')).toBe(false);
    expect(isSignInProvider('deepseek')).toBe(false);
    expect(isSignInProvider(CUSTOM_PROVIDER_ID)).toBe(false);
    expect(isSignInProvider('kilo')).toBe(false);
  });

  it('offers an API key to all providers that use APIs, including Kimi alongside OAuth', () => {
    for (const provider of PROVIDER_REGISTRY) {
      const expected = provider.id !== 'chatgpt';
      expect(provider.auth.methods.includes('api-key'), provider.id).toBe(expected);
      expect(isAuthMethodPermitted(provider.id, 'api-key'), provider.id).toBe(expected);
    }
  });

  it('keeps MiniMax API-key eligibility separate from its unverified Coding Plan key question', () => {
    const minimax = PROVIDER_REGISTRY.find((provider) => provider.id === 'minimax');
    expect(minimax?.auth.methods).toEqual(['api-key', 'subscription-sign-in']);
    expect(minimax?.auth.gated).toBe(true);
    expect(minimax?.auth.unverified).toBe(true);
    expect(minimax?.auth.note).toContain('JOY Media');
    expect(minimax?.auth.note).toContain('sk-cp-');
  });

  it('marks the rows the plan leaves unverified as unverified', () => {
    const unverified = PROVIDER_REGISTRY.filter(
      (provider) => provider.auth.unverified === true,
    ).map((provider) => provider.id);
    expect(unverified).toEqual(['minimax', 'kimi']);
  });

  it('permits a key or nothing for a custom endpoint, and nothing for an unknown provider', () => {
    expect(CUSTOM_PROVIDER_AUTH.methods).toEqual(['api-key', 'none']);
    expect(permittedAuthMethods(CUSTOM_PROVIDER_ID)).toEqual(['api-key', 'none']);
    expect(offeredAuthMethods(CUSTOM_PROVIDER_ID)).toEqual(['api-key', 'none']);
    expect(permittedAuthMethods('not-a-provider')).toEqual([]);
    expect(offeredAuthMethods('not-a-provider')).toEqual([]);
    expect(isAuthMethodPermitted('not-a-provider', 'api-key')).toBe(false);
    expect(permittedAuthMethods('deepseek')).toEqual(['api-key']);
    expect(permittedAuthMethods('kilo')).toEqual(['api-key']);
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
