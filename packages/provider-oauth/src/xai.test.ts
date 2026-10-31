import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from './http.js';
import {
  createXaiTokenKeeper,
  decodeXaiTokenRecord,
  encodeXaiTokenRecord,
  refreshXaiTokens,
  signInWithXai,
  XAI_OAUTH_DEVICE_GRANT_TYPE,
  XAI_OAUTH_DISCOVERY_URL,
  XAI_OAUTH_INFERENCE_BASE_URL,
  XAI_OAUTH_SCOPE,
  type XaiTokenRecord,
} from './xai.js';

const DEVICE_ENDPOINT = 'https://auth.x.ai/oauth2/device/code';
const TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
const CLIENT_ID = 'joy-test-public-client';
const NOW = Date.UTC(2026, 9, 30);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function formOf(init: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init.body));
}

function discovery(
  deviceAuthorizationEndpoint = DEVICE_ENDPOINT,
  tokenEndpoint = TOKEN_ENDPOINT,
): Response {
  return json({
    issuer: 'https://auth.x.ai',
    device_authorization_endpoint: deviceAuthorizationEndpoint,
    token_endpoint: tokenEndpoint,
  });
}

function deviceReply(): Response {
  return json({
    device_code: 'test-device-code',
    user_code: 'TEST-CODE',
    verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=TEST-CODE',
    expires_in: 120,
    interval: 1,
  });
}

const RECORD: XaiTokenRecord = {
  version: 1,
  clientId: CLIENT_ID,
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  accessExpiresAt: NOW + 3_600_000,
  scope: XAI_OAUTH_SCOPE,
};

describe('xAI device OAuth', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('discovers trusted endpoints, opens the approval page, and polls with the configured public client', async () => {
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    let openedUrl = '';
    const presentations: {
      readonly url: string;
      readonly userCode?: string;
      readonly expiresAt?: number;
    }[] = [];
    const fetch: FetchLike = async (url, init) => {
      requests.push({ url, init });
      if (url === XAI_OAUTH_DISCOVERY_URL) return discovery();
      if (url === DEVICE_ENDPOINT) {
        expect(init.method).toBe('POST');
        expect(formOf(init)).toEqual(
          new URLSearchParams({ client_id: CLIENT_ID, scope: XAI_OAUTH_SCOPE }),
        );
        return deviceReply();
      }
      if (url === TOKEN_ENDPOINT) {
        expect(init.method).toBe('POST');
        expect(formOf(init)).toEqual(
          new URLSearchParams({
            client_id: CLIENT_ID,
            device_code: 'test-device-code',
            grant_type: XAI_OAUTH_DEVICE_GRANT_TYPE,
          }),
        );
        return json({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expires_in: 3600,
          scope: XAI_OAUTH_SCOPE,
        });
      }
      throw new Error(`unexpected request to ${url}`);
    };

    const record = await signInWithXai({
      clientId: CLIENT_ID,
      openExternal: (url) => {
        openedUrl = url;
      },
      fetch,
      now: () => NOW,
      pollIntervalMs: 1_000,
      onAuthorization: (presentation) => presentations.push(presentation),
    });

    expect(openedUrl).toBe('https://accounts.x.ai/oauth2/device?user_code=TEST-CODE');
    expect(presentations).toEqual([
      {
        url: openedUrl,
        userCode: 'TEST-CODE',
        expiresAt: NOW + 120_000,
      },
    ]);
    expect(record).toMatchObject({
      version: 1,
      clientId: CLIENT_ID,
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      accessExpiresAt: NOW + 3_600_000,
      scope: XAI_OAUTH_SCOPE,
    });
    expect(JSON.stringify(record)).not.toContain('test-device-code');
    expect(requests.map((request) => request.url)).toEqual([
      XAI_OAUTH_DISCOVERY_URL,
      DEVICE_ENDPOINT,
      TOKEN_ENDPOINT,
    ]);
    expect(XAI_OAUTH_INFERENCE_BASE_URL).toBe('https://api.x.ai/v1');
  });

  it.each([
    ['http://auth.x.ai/oauth2/device/code', TOKEN_ENDPOINT],
    ['https://auth.x.ai.attacker.example/device', TOKEN_ENDPOINT],
    [DEVICE_ENDPOINT, 'http://auth.x.ai/oauth2/token'],
    [DEVICE_ENDPOINT, 'https://attacker.example/oauth2/token'],
  ])('refuses discovery endpoints outside HTTPS x.ai hosts (%s, %s)', async (device, token) => {
    const fetch: FetchLike = async (url) => {
      expect(url).toBe(XAI_OAUTH_DISCOVERY_URL);
      return discovery(device, token);
    };

    await expect(
      signInWithXai({
        clientId: CLIENT_ID,
        openExternal: () => undefined,
        fetch,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'REDIRECT_REFUSED' });
  });

  it('refuses discovery metadata without the expected issuer', async () => {
    const fetch: FetchLike = async (url) => {
      expect(url).toBe(XAI_OAUTH_DISCOVERY_URL);
      return json({
        device_authorization_endpoint: DEVICE_ENDPOINT,
        token_endpoint: TOKEN_ENDPOINT,
      });
    };

    await expect(
      signInWithXai({
        clientId: CLIENT_ID,
        openExternal: () => undefined,
        fetch,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'REDIRECT_REFUSED' });
  });

  it('refuses an approval URL outside x.ai before opening a browser', async () => {
    const fetch: FetchLike = async (url) => {
      if (url === XAI_OAUTH_DISCOVERY_URL) return discovery();
      if (url === DEVICE_ENDPOINT) {
        return json({
          device_code: 'test-device-code',
          user_code: 'TEST-CODE',
          verification_uri: 'https://attacker.example/approve',
          expires_in: 120,
          interval: 1,
        });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const openExternal = vi.fn();

    await expect(
      signInWithXai({ clientId: CLIENT_ID, openExternal, fetch, now: () => NOW }),
    ).rejects.toMatchObject({ code: 'REDIRECT_REFUSED' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('continues polling after authorization_pending', async () => {
    vi.useFakeTimers({ now: NOW });
    let polls = 0;
    const fetch: FetchLike = async (url) => {
      if (url === XAI_OAUTH_DISCOVERY_URL) return discovery();
      if (url === DEVICE_ENDPOINT) return deviceReply();
      if (url === TOKEN_ENDPOINT) {
        polls += 1;
        return polls === 1
          ? json({ error: 'authorization_pending' }, 400)
          : json({
              access_token: 'test-access-token',
              refresh_token: 'test-refresh-token',
              expires_in: 3600,
            });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const pending = signInWithXai({
      clientId: CLIENT_ID,
      openExternal: () => undefined,
      fetch,
      now: Date.now,
      pollIntervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ accessToken: 'test-access-token' });
    expect(polls).toBe(2);
  });

  it('slows the poll interval after slow_down', async () => {
    vi.useFakeTimers({ now: NOW });
    let polls = 0;
    const onSlowDown = vi.fn();
    const fetch: FetchLike = async (url) => {
      if (url === XAI_OAUTH_DISCOVERY_URL) return discovery();
      if (url === DEVICE_ENDPOINT) return deviceReply();
      if (url === TOKEN_ENDPOINT) {
        polls += 1;
        return polls <= 2
          ? json({ error: 'slow_down' }, 400)
          : json({
              access_token: 'test-access-token',
              refresh_token: 'test-refresh-token',
              expires_in: 3600,
            });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const pending = signInWithXai({
      clientId: CLIENT_ID,
      openExternal: () => undefined,
      fetch,
      now: Date.now,
      pollIntervalMs: 1_000,
      onSlowDown,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toBe(2);
    expect(onSlowDown).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_999);
    expect(polls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ accessToken: 'test-access-token' });
    expect(polls).toBe(3);
    expect(onSlowDown).toHaveBeenCalledTimes(1);
  });

  it('turns an expired device code into a fixed timeout error', async () => {
    const fetch: FetchLike = async (url) => {
      if (url === XAI_OAUTH_DISCOVERY_URL) return discovery();
      if (url === DEVICE_ENDPOINT) return deviceReply();
      if (url === TOKEN_ENDPOINT) return json({ error: 'expired_token' }, 400);
      throw new Error(`unexpected request to ${url}`);
    };

    await expect(
      signInWithXai({ clientId: CLIENT_ID, openExternal: () => undefined, fetch, now: () => NOW }),
    ).rejects.toMatchObject({ code: 'TIMEOUT', message: 'xAI device authorization timed out.' });
  });

  it('turns access_denied into a fixed, credential-safe error', async () => {
    const fetch: FetchLike = async (url) => {
      if (url === XAI_OAUTH_DISCOVERY_URL) return discovery();
      if (url === DEVICE_ENDPOINT) return deviceReply();
      if (url === TOKEN_ENDPOINT) {
        return json({ error: 'access_denied', error_description: 'private response detail' }, 403);
      }
      throw new Error(`unexpected request to ${url}`);
    };

    await expect(
      signInWithXai({ clientId: CLIENT_ID, openExternal: () => undefined, fetch, now: () => NOW }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED', message: 'xAI sign-in was denied.' });
  });
});

describe('xAI OAuth token records', () => {
  it('round-trips a token record and rejects malformed data', () => {
    expect(decodeXaiTokenRecord(encodeXaiTokenRecord(RECORD))).toEqual(RECORD);
    expect(decodeXaiTokenRecord('{')).toBeUndefined();
    expect(
      decodeXaiTokenRecord(JSON.stringify({ ...RECORD, accessExpiresAt: Infinity })),
    ).toBeUndefined();
  });

  it('refreshes with the saved refresh token and keeps it when the server omits rotation', async () => {
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    const fetch: FetchLike = async (url, init) => {
      requests.push({ url, init });
      if (url === XAI_OAUTH_DISCOVERY_URL) return discovery();
      if (url === TOKEN_ENDPOINT) {
        expect(formOf(init)).toEqual(
          new URLSearchParams({
            client_id: CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: 'test-refresh-token',
          }),
        );
        return json({ access_token: 'test-rotated-access', expires_in: 1800 });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const save = vi.fn(async () => undefined);

    const refreshed = await refreshXaiTokens({ record: RECORD, fetch, now: () => NOW, save });

    expect(refreshed).toMatchObject({
      ...RECORD,
      accessToken: 'test-rotated-access',
      refreshToken: 'test-refresh-token',
      accessExpiresAt: NOW + 1_800_000,
    });
    expect(save).toHaveBeenCalledWith(refreshed);
    expect(requests.map(({ url }) => url)).toEqual([XAI_OAUTH_DISCOVERY_URL, TOKEN_ENDPOINT]);
  });

  it('shares one near-expiry refresh between concurrent requests for a profile', async () => {
    let finishDiscovery: ((response: Response) => void) | undefined;
    const discovered = new Promise<Response>((resolve) => {
      finishDiscovery = resolve;
    });
    let discoveryCalls = 0;
    const fetch: FetchLike = async (url) => {
      if (url === XAI_OAUTH_DISCOVERY_URL) {
        discoveryCalls += 1;
        return discovered;
      }
      if (url === TOKEN_ENDPOINT) {
        return json({
          access_token: 'test-rotated-access',
          refresh_token: 'test-rotated-refresh',
          expires_in: 1800,
        });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const save = vi.fn(async () => undefined);
    const keeper = createXaiTokenKeeper({ fetch, now: () => NOW, save });
    const expired = { ...RECORD, accessExpiresAt: NOW + 1 };

    const first = keeper.current('profile', 'handle', expired);
    const second = keeper.current('profile', 'handle', expired);
    expect(discoveryCalls).toBe(1);
    finishDiscovery?.(discovery());

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { accessToken: 'test-rotated-access', refreshToken: 'test-rotated-refresh' },
      { accessToken: 'test-rotated-access', refreshToken: 'test-rotated-refresh' },
    ]);
    expect(discoveryCalls).toBe(1);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
