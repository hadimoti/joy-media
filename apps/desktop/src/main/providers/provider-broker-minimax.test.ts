import { describe, expect, it } from 'vitest';
import { createMemorySecretStore } from '@joy-media/provider-sdk';
import {
  createProviderBroker,
  endpointBindingDigest,
  type BrokerProfile,
  type ProviderFetch,
} from './provider-broker.js';

const NOW = Date.UTC(2026, 9, 30);
const ACCESS_TOKEN = 'minimax-access-secret';
const REFRESH_TOKEN = 'minimax-refresh-secret';
const CHAT_BODY = { messages: [{ role: 'user', content: 'hi' }] };

function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bound(baseUrl = 'https://api.minimax.io/v1'): BrokerProfile {
  const url = new URL(baseUrl);
  return {
    id: 'profile-1',
    provider: 'minimax',
    baseUrl,
    modelId: 'MiniMax-M2.1',
    secretHandleId: 'handle-1',
    bindingDigest: endpointBindingDigest('profile-1', url.origin, url.pathname),
    bindingSecretDigest: 'version-1',
  };
}

async function harness(
  secret: string,
  fetch: ProviderFetch,
  options: { readonly profile?: BrokerProfile; readonly now?: () => number } = {},
) {
  let profile = options.profile ?? bound();
  let version = 'version-1';
  const secrets = createMemorySecretStore();
  await secrets.set(profile.secretHandleId, secret);
  const broker = createProviderBroker({
    store: {
      getProfile: (id) => (id === profile.id ? profile : undefined),
      isDisabledLegacy: () => false,
      markCredentialUnavailable: () => undefined,
      secretVersion: () => version,
      rebindSecretVersion: (_id, nextVersion) => {
        version = nextVersion;
        profile = { ...profile, bindingSecretDigest: nextVersion };
      },
    },
    secrets,
    fetch,
    resolveHost: async () => [],
    now: options.now ?? (() => NOW),
  });
  return { broker, secrets };
}

describe('provider broker: MiniMax sign-in credentials', () => {
  it('sends a token record access token as the bearer credential', async () => {
    const sent: { readonly url: string; readonly init: RequestInit }[] = [];
    const tokenRecord = {
      version: 1,
      clientId: 'joy-media-client',
      region: 'global',
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      accessExpiresAt: NOW + 3_600_000,
    };
    const fetch: ProviderFetch = async (url, init) => {
      sent.push({ url, init });
      return jsonReply({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    };
    const { broker } = await harness(JSON.stringify(tokenRecord), fetch);

    const result = await broker.complete({ profileId: 'profile-1', body: CHAT_BODY });

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://api.minimax.io/v1/chat/completions');
    expect(new Headers(sent[0]?.init.headers).get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(new Headers(sent[0]?.init.headers).get('authorization')).not.toContain(
      JSON.stringify(tokenRecord),
    );
  });

  it('keeps sending a plain MiniMax API key as the bearer credential', async () => {
    const apiKey = 'sk-cp-minimax-key-0123456789';
    let authorization: string | null = null;
    const fetch: ProviderFetch = async (_url, init) => {
      authorization = new Headers(init.headers).get('authorization');
      return jsonReply({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    };
    const { broker } = await harness(apiKey, fetch);

    const result = await broker.complete({ profileId: 'profile-1', body: CHAT_BODY });

    expect(result.ok).toBe(true);
    expect(authorization).toBe(`Bearer ${apiKey}`);
  });

  it('refreshes a near-expiry token before the call and refuses a reply containing the refresh token', async () => {
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    const tokenRecord = {
      version: 1,
      clientId: 'joy-media-client',
      region: 'global',
      accessToken: 'mini-access-old',
      refreshToken: REFRESH_TOKEN,
      accessExpiresAt: NOW + 1,
    };
    const fetch: ProviderFetch = async (url, init) => {
      requests.push({ url, init });
      if (url === 'https://account.minimax.io/oauth2/token') {
        return jsonReply({
          status: 'success',
          access_token: 'mini-access-new',
          refresh_token: 'mini-refresh-new',
          expired_in: 3_600,
        });
      }
      return jsonReply({
        choices: [
          {
            message: {
              role: 'assistant',
              content: `leaked ${REFRESH_TOKEN} ${tokenRecord.accessToken} mini-refresh-new mini-access-new`,
            },
          },
        ],
      });
    };
    const { broker } = await harness(JSON.stringify(tokenRecord), fetch);

    const result = await broker.complete({ profileId: 'profile-1', body: CHAT_BODY });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe('https://account.minimax.io/oauth2/token');
    expect(new Headers(requests[1]?.init.headers).get('authorization')).toBe(
      'Bearer mini-access-new',
    );
    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_INCOMPATIBLE' });
    expect(JSON.stringify(result)).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(result)).not.toContain('mini-refresh-new');
  });

  it('refuses a reply that carries only the access token the refresh replaced', async () => {
    const tokenRecord = {
      version: 1,
      clientId: 'joy-media-client',
      region: 'global',
      accessToken: 'mini-access-old',
      refreshToken: REFRESH_TOKEN,
      accessExpiresAt: NOW + 1,
    };
    const fetch: ProviderFetch = async (url, init) => {
      if (url === 'https://account.minimax.io/oauth2/token') {
        return jsonReply({
          status: 'success',
          access_token: 'mini-access-new',
          refresh_token: 'mini-refresh-new',
          expired_in: 3_600,
        });
      }
      return jsonReply({
        choices: [{ message: { role: 'assistant', content: 'leaked mini-access-old' } }],
      });
    };
    const { broker } = await harness(JSON.stringify(tokenRecord), fetch);

    const result = await broker.complete({ profileId: 'profile-1', body: CHAT_BODY });

    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_INCOMPATIBLE' });
    expect(JSON.stringify(result)).not.toContain('mini-access-old');
  });
});
