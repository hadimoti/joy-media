import { createMemorySecretStore } from '@joy-media/provider-sdk';
import { describe, expect, it } from 'vitest';
import {
  XAI_OAUTH_DISCOVERY_URL,
  XAI_OAUTH_INFERENCE_BASE_URL,
  XAI_OAUTH_ISSUER,
  XAI_OAUTH_CLIENT_ID,
  encodeXaiTokenRecord,
  type XaiTokenRecord,
} from '../oauth/xai.js';
import {
  createProviderBroker,
  endpointBindingDigest,
  type BrokerProfile,
  type ProviderFetch,
} from './provider-broker.js';

const NOW = Date.UTC(2026, 9, 30);
const TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
const CHAT_BODY = { messages: [{ role: 'user', content: 'hi' }] };

function bound(id: string, provider: string, baseUrl: string, modelId = 'grok-test-model'): BrokerProfile {
  const url = new URL(baseUrl);
  return {
    id,
    provider,
    baseUrl,
    modelId,
    secretHandleId: `handle-${id}`,
    bindingDigest: endpointBindingDigest(id, url.origin, url.pathname.replace(/\/+$/, '')),
    bindingSecretDigest: `v-handle-${id}`,
  };
}

function jsonReply(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('provider broker: xAI credentials', () => {
  it('refreshes and uses xAI OAuth at its registered inference base', async () => {
    const profile = bound('xai-oauth', 'xai', XAI_OAUTH_INFERENCE_BASE_URL);
    const record: XaiTokenRecord = {
      version: 1,
      clientId: XAI_OAUTH_CLIENT_ID,
      accessToken: 'test-old-access-token',
      refreshToken: 'test-old-refresh-token',
      accessExpiresAt: NOW + 1,
      scope: 'openid profile email offline_access grok-cli:access api:access',
    };
    const secrets = createMemorySecretStore();
    await secrets.set(profile.secretHandleId, encodeXaiTokenRecord(record));
    const sent: { readonly url: string; readonly init: RequestInit }[] = [];
    const fetch: ProviderFetch = async (url, init) => {
      sent.push({ url, init });
      if (url === XAI_OAUTH_DISCOVERY_URL) {
        return jsonReply({
          issuer: XAI_OAUTH_ISSUER,
          device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code',
          token_endpoint: TOKEN_ENDPOINT,
        });
      }
      if (url === TOKEN_ENDPOINT) {
        expect(new URLSearchParams(String(init.body)).get('grant_type')).toBe('refresh_token');
        expect(new URLSearchParams(String(init.body)).get('refresh_token')).toBe('test-old-refresh-token');
        return jsonReply({
          access_token: 'test-new-access-token',
          refresh_token: 'test-new-refresh-token',
          expires_in: 3600,
          scope: 'openid profile email offline_access grok-cli:access api:access',
        });
      }
      if (url === `${XAI_OAUTH_INFERENCE_BASE_URL}/chat/completions`) {
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-new-access-token');
        return jsonReply({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const broker = createProviderBroker({
      store: {
        getProfile: (id) => (id === profile.id ? profile : undefined),
        isDisabledLegacy: () => false,
        markCredentialUnavailable: () => undefined,
        secretVersion: (handleId) => `v-${handleId}`,
      },
      secrets,
      fetch,
      resolveHost: async () => ['8.8.8.8'],
      now: () => NOW,
    });

    const result = await broker.complete({ profileId: profile.id, body: CHAT_BODY });

    expect(result.ok).toBe(true);
    expect(sent.map(({ url }) => url)).toEqual([
      XAI_OAUTH_DISCOVERY_URL,
      TOKEN_ENDPOINT,
      `${XAI_OAUTH_INFERENCE_BASE_URL}/chat/completions`,
    ]);
    expect(await secrets.get(profile.secretHandleId)).toContain('test-new-refresh-token');
    expect(JSON.stringify(result)).not.toContain('test-new-access-token');
    if (!result.ok) throw new Error(result.message);
    expect(JSON.parse(result.data.text)).toMatchObject({
      choices: [{ message: { content: 'ok' } }],
    });
  });

  it('keeps an xAI API key as a plain key at the API-key base', async () => {
    const profile = bound('xai-api-key', 'xai', 'https://api.x.ai/v1');
    const secrets = createMemorySecretStore();
    await secrets.set(profile.secretHandleId, 'test-xai-api-key');
    const sent: { readonly url: string; readonly init: RequestInit }[] = [];
    const broker = createProviderBroker({
      store: {
        getProfile: (id) => (id === profile.id ? profile : undefined),
        isDisabledLegacy: () => false,
        markCredentialUnavailable: () => undefined,
        secretVersion: (handleId) => `v-${handleId}`,
      },
      secrets,
      fetch: async (url, init) => {
        sent.push({ url, init });
        return jsonReply({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
      },
      resolveHost: async () => ['8.8.8.8'],
      now: () => NOW,
    });

    const result = await broker.complete({ profileId: profile.id, body: CHAT_BODY });

    expect(result.ok).toBe(true);
    expect(sent[0]?.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(new Headers(sent[0]?.init.headers).get('authorization')).toBe('Bearer test-xai-api-key');
    if (!result.ok) throw new Error(result.message);
    expect(JSON.parse(result.data.text)).toMatchObject({
      choices: [{ message: { content: 'ok' } }],
    });
  });
});
