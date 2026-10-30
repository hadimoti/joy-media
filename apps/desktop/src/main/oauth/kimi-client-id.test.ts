import { describe, expect, it } from 'vitest';
import type { FetchLike } from './http.js';
import { createProviderSignIn } from './sign-in.js';
import {
  decodeKimiTokenRecord,
  encodeKimiTokenRecord,
  signInWithKimiCode,
  KIMI_CODE_BASE_URL,
  type KimiTokenRecord,
} from './kimi.js';

const CLIENT_ID = 'joy-kimi-registered-client';
const NOW = Date.UTC(2026, 9, 30);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Kimi Code configurable client ID', () => {
  it('uses the configured client for device and token requests and retains it in the record', async () => {
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    const fetch: FetchLike = async (url, init) => {
      requests.push({ url, init });
      if (url === 'https://auth.kimi.ai/api/oauth/device_authorization') {
        expect(new URLSearchParams(String(init.body)).get('client_id')).toBe(CLIENT_ID);
        return json({
          user_code: 'TEST-CODE',
          device_code: 'test-device-code',
          verification_uri_complete: 'https://www.kimi.ai/code/authorize_device?user_code=TEST-CODE',
          expires_in: 120,
          interval: 1,
        });
      }
      if (url === 'https://auth.kimi.ai/api/oauth/token') {
        expect(new URLSearchParams(String(init.body)).get('client_id')).toBe(CLIENT_ID);
        return json({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expires_in: 3600,
          scope: 'kimi-code',
        });
      }
      throw new Error(`unexpected request to ${url}`);
    };

    const record = await signInWithKimiCode({
      clientId: CLIENT_ID,
      openExternal: () => undefined,
      fetch,
      now: () => NOW,
    });

    expect(record.clientId).toBe(CLIENT_ID);
    expect(requests).toHaveLength(2);
    expect(decodeKimiTokenRecord(encodeKimiTokenRecord(record))).toEqual(record);
  });

  it('keeps the Kimi Code API base independent from the configured OAuth client', () => {
    const record: KimiTokenRecord = {
      version: 1,
      clientId: CLIENT_ID,
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      accessExpiresAt: NOW + 3_600_000,
      scope: 'kimi-code',
    };

    expect(decodeKimiTokenRecord(encodeKimiTokenRecord(record))?.clientId).toBe(CLIENT_ID);
    expect(KIMI_CODE_BASE_URL).toBe('https://api.kimi.ai/coding/v1');
  });

  it('resolves the Kimi client ID from app settings in the normal sign-in flow', async () => {
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    const fetch: FetchLike = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/api/oauth/device_authorization')) {
        expect(new URLSearchParams(String(init.body)).get('client_id')).toBe(CLIENT_ID);
        return json({
          user_code: 'TEST-CODE',
          device_code: 'test-device-code',
          verification_uri_complete: 'https://www.kimi.ai/code/authorize_device?user_code=TEST-CODE',
          expires_in: 120,
          interval: 1,
        });
      }
      if (url.endsWith('/api/oauth/token')) {
        expect(new URLSearchParams(String(init.body)).get('client_id')).toBe(CLIENT_ID);
        return json({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expires_in: 3600,
          scope: 'kimi-code',
        });
      }
      if (url === `${KIMI_CODE_BASE_URL}/models`) return json({ data: [{ id: 'kimi-code-model' }] });
      throw new Error(`unexpected request to ${url}`);
    };
    const signIn = createProviderSignIn({
      openExternal: () => undefined,
      fetch,
      now: () => NOW,
      chatGptClientId: undefined,
      minimaxClientId: undefined,
      getSetting: (key) => (key === 'oauth.client_id.kimi' ? ` ${CLIENT_ID} ` : undefined),
      installId: () => 'urn:uuid:550e8400-e29b-41d4-a716-446655440000',
    });

    const result = await signIn('kimi');

    expect(result.modelId).toBe('kimi-code-model');
    expect(decodeKimiTokenRecord(result.secret)?.clientId).toBe(CLIENT_ID);
    expect(requests).toHaveLength(3);
  });
});
