import { createMemorySecretStore } from '@joy-media/provider-sdk';
import { describe, expect, it } from 'vitest';
import {
  createProviderBroker,
  endpointBindingDigest,
  type BrokerProfile,
  type ProviderFetch,
} from './provider-broker.js';

function jsonReply(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('provider broker: MiniMax API key', () => {
  it('uses a plain MiniMax API key at the OpenAI-compatible base', async () => {
    const baseUrl = 'https://api.minimax.io/v1';
    const url = new URL(baseUrl);
    const profile: BrokerProfile = {
      id: 'minimax-api-key',
      provider: 'minimax',
      baseUrl,
      modelId: 'MiniMax-M2.1',
      secretHandleId: 'handle-minimax-api-key',
      bindingDigest: endpointBindingDigest('minimax-api-key', url.origin, url.pathname),
      bindingSecretDigest: 'v-handle-minimax-api-key',
    };
    const secrets = createMemorySecretStore();
    await secrets.set(profile.secretHandleId, 'test-minimax-api-key');
    const sent: { readonly url: string; readonly init: RequestInit }[] = [];
    const fetch: ProviderFetch = async (requestUrl, init) => {
      sent.push({ url: requestUrl, init });
      return jsonReply({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
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
    });

    const result = await broker.complete({
      profileId: profile.id,
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`${baseUrl}/chat/completions`);
    expect(new Headers(sent[0]?.init.headers).get('authorization')).toBe(
      'Bearer test-minimax-api-key',
    );
  });
});
