import { describe, expect, it, vi } from 'vitest';
import { MINIMAX_OAUTH_ENDPOINTS } from '@joy-media/provider-sdk';
import { decodeMiniMaxTokenRecord } from './minimax.js';
import { createProviderSignIn } from './sign-in.js';
import { XAI_OAUTH_DISCOVERY_URL, XAI_OAUTH_INFERENCE_BASE_URL, XAI_OAUTH_SCOPE } from './xai.js';
import type { FetchLike } from './http.js';

const CLIENT_ID = 'joy-registered-public-client';
const HOST_ID = 'urn:uuid:550e8400-e29b-41d4-a716-446655440000';
const NOW = Date.UTC(2026, 9, 30);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('D22 OAuth client settings', () => {
  it('uses MiniMax public client default when no app setting override is saved', async () => {
    vi.useFakeTimers({ now: NOW });
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    let opened = false;
    const fetch: FetchLike = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/oauth2/device/code')) {
        expect(new URLSearchParams(String(init.body)).get('client_id')).toBe(
          '78257093-7e40-4613-99e0-527b14b39113',
        );
        const state = new URLSearchParams(String(init.body)).get('state');
        return json({
          user_code: 'TEST-CODE',
          verification_uri: 'https://platform.minimax.io/oauth-authorize',
          expired_in: NOW + 60_000,
          state,
        });
      }
      if (url.endsWith('/oauth2/token')) {
        return json({
          status: 'success',
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expired_in: 3600,
        });
      }
      if (url === `${MINIMAX_OAUTH_ENDPOINTS.global.inferenceBase}/models`) {
        return json({ data: [{ id: 'MiniMax-M2.1' }] });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const signIn = createProviderSignIn({
      openExternal: () => {
        opened = true;
      },
      fetch,
      now: Date.now,
      chatGptClientId: undefined,
      minimaxClientId: undefined,
      getSetting: () => undefined,
      installId: () => HOST_ID,
    });
    const pending = signIn('minimax');

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(opened).toBe(true);
    expect(decodeMiniMaxTokenRecord(result.secret)?.clientId).toBe(
      '78257093-7e40-4613-99e0-527b14b39113',
    );
  });

  it('uses the MiniMax settings override before its public default', async () => {
    vi.useFakeTimers({ now: NOW });
    let deviceClientId = '';
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith('/oauth2/device/code')) {
        deviceClientId = new URLSearchParams(String(init.body)).get('client_id') ?? '';
        const state = new URLSearchParams(String(init.body)).get('state');
        return json({
          user_code: 'TEST-CODE',
          verification_uri: 'https://platform.minimax.io/oauth-authorize',
          expired_in: NOW + 60_000,
          state,
        });
      }
      if (url.endsWith('/oauth2/token')) {
        return json({
          status: 'success',
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expired_in: 3600,
        });
      }
      if (url === `${MINIMAX_OAUTH_ENDPOINTS.global.inferenceBase}/models`) {
        return json({ data: [{ id: 'MiniMax-M2.1' }] });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const signIn = createProviderSignIn({
      openExternal: () => undefined,
      fetch,
      now: Date.now,
      chatGptClientId: undefined,
      minimaxClientId: undefined,
      getSetting: (key) => (key === 'oauth.client_id.minimax' ? ` ${CLIENT_ID} ` : undefined),
      installId: () => HOST_ID,
    });
    const pending = signIn('minimax');

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(deviceClientId).toBe(CLIENT_ID);
    expect(decodeMiniMaxTokenRecord(result.secret)?.clientId).toBe(CLIENT_ID);
  });

  it('uses the xAI settings override for sign-in and returns the xAI OAuth base', async () => {
    const requests: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      requests.push(url);
      if (url === XAI_OAUTH_DISCOVERY_URL) {
        return json({
          issuer: 'https://auth.x.ai',
          device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code',
          token_endpoint: 'https://auth.x.ai/oauth2/token',
        });
      }
      if (url.endsWith('/oauth2/device/code')) {
        expect(new URLSearchParams(String(init.body)).get('client_id')).toBe(CLIENT_ID);
        return json({
          device_code: 'test-device-code',
          user_code: 'TEST-CODE',
          verification_uri: 'https://accounts.x.ai/oauth2/device',
          expires_in: 120,
          interval: 1,
        });
      }
      if (url.endsWith('/oauth2/token')) {
        return json({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expires_in: 3600,
          scope: XAI_OAUTH_SCOPE,
        });
      }
      if (url === `${XAI_OAUTH_INFERENCE_BASE_URL}/models`) {
        return json({ data: [{ id: 'grok-test-model' }] });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const signIn = createProviderSignIn({
      openExternal: () => undefined,
      fetch,
      now: () => NOW,
      chatGptClientId: undefined,
      minimaxClientId: undefined,
      getSetting: (key) => (key === 'oauth.client_id.xai' ? CLIENT_ID : undefined),
      installId: () => HOST_ID,
    });

    const result = await signIn('xai');

    expect(result).toMatchObject({
      provider: 'xai',
      baseUrl: XAI_OAUTH_INFERENCE_BASE_URL,
      modelId: 'grok-test-model',
    });
    expect(requests).toContain(`${XAI_OAUTH_INFERENCE_BASE_URL}/models`);
  });
});
