import { describe, expect, it } from 'vitest';
import { createMemorySecretStore } from '@joy-media/provider-sdk';
import {
  createProviderBroker,
  endpointBindingDigest,
  type BrokerProfile,
  type ProviderFetch,
} from './provider-broker.js';

const NOW = Date.UTC(2026, 9, 30);
const CHAT_BODY = { messages: [{ role: 'user', content: 'hi' }] };

function jsonReply(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function bound(baseUrl = 'https://api.minimax.io/v1'): BrokerProfile {
  const url = new URL(baseUrl);
  return {
    id: 'profile-1',
    provider: 'minimax',
    baseUrl,
    modelId: 'MiniMax-M3.1-Flash',
    secretHandleId: 'handle-1',
    bindingDigest: endpointBindingDigest('profile-1', url.origin, url.pathname),
    bindingSecretDigest: 'version-1',
  };
}

async function harness(secret: string, fetch: ProviderFetch) {
  const profile = bound();
  const secrets = createMemorySecretStore();
  await secrets.set(profile.secretHandleId, secret);
  const broker = createProviderBroker({
    store: {
      getProfile: (id) => (id === profile.id ? profile : undefined),
      isDisabledLegacy: () => false,
      markCredentialUnavailable: () => undefined,
      secretVersion: () => 'version-1',
    },
    secrets,
    fetch,
    resolveHost: async () => [],
    now: () => NOW,
  });
  return broker;
}

describe('provider broker: MiniMax OAuth removal', () => {
  it('refuses a stale OAuth record without sending it as a bearer', async () => {
    const staleRecord = {
      version: 1,
      clientId: 'test-client-id',
      region: 'global',
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      accessExpiresAt: NOW + 3_600_000,
    };
    let requests = 0;
    const fetch: ProviderFetch = async () => {
      requests += 1;
      return jsonReply({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    };
    const broker = await harness(JSON.stringify(staleRecord), fetch);

    const result = await broker.complete({ profileId: 'profile-1', body: CHAT_BODY });

    expect(result).toMatchObject({ ok: false, code: 'CREDENTIAL_UNAVAILABLE' });
    expect(JSON.stringify(result)).toMatch(/MiniMax OAuth.*D23.*API key/i);
    expect(requests).toBe(0);
    expect(JSON.stringify(result)).not.toContain(JSON.stringify(staleRecord));
  });

  it('keeps sending a plain MiniMax API key as the bearer credential', async () => {
    const apiKey = 'sk-cp-test-not-a-real-key';
    let authorization: string | null = null;
    let requestUrl = '';
    let requestBody: unknown;
    const fetch: ProviderFetch = async (url, init) => {
      requestUrl = url;
      authorization = new Headers(init.headers).get('authorization');
      requestBody = JSON.parse(String(init.body)) as unknown;
      return jsonReply({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    };
    const broker = await harness(apiKey, fetch);

    const result = await broker.complete({ profileId: 'profile-1', body: CHAT_BODY });

    expect(result.ok).toBe(true);
    expect(requestUrl).toBe('https://api.minimax.io/v1/chat/completions');
    expect(authorization).toBe(`Bearer ${apiKey}`);
    expect(requestBody).toMatchObject({ model: 'MiniMax-M3.1-Flash' });
  });
});
