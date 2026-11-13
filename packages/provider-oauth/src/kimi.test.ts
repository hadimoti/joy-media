import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from './http.js';
import {
  createKimiTokenKeeper,
  decodeKimiTokenRecord,
  encodeKimiTokenRecord,
  KIMI_CODE_BASE_URL,
  KIMI_CODE_CLIENT_ID,
  KIMI_CODE_OAUTH_HOST,
  refreshKimiCodeTokens,
  signInWithKimiCode,
  type KimiTokenRecord,
} from './kimi.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function formOf(init: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init.body));
}

const RECORD: KimiTokenRecord = {
  version: 1,
  clientId: KIMI_CODE_CLIENT_ID,
  accessToken: 'kimi-access-secret',
  refreshToken: 'kimi-refresh-secret',
  accessExpiresAt: Date.UTC(2026, 9, 30) + 3_600_000,
  scope: 'kimi-code',
};

describe('Kimi Code device OAuth', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the verified Kimi Code URL, polls the device grant, and returns a refreshable token record', async () => {
    const now = Date.UTC(2026, 9, 30);
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    let openedUrl = '';
    const presentations: {
      readonly url: string;
      readonly userCode?: string;
      readonly expiresAt?: number;
    }[] = [];
    let releaseOpen: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const fetch: FetchLike = async (url, init) => {
      requests.push({ url, init });
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`) {
        expect(init.method).toBe('POST');
        expect(formOf(init).get('client_id')).toBe(KIMI_CODE_CLIENT_ID);
        return json({
          user_code: 'KIMI-USER-CODE',
          device_code: 'private-device-code',
          verification_uri_complete:
            'https://www.kimi.ai/code/authorize_device?user_code=KIMI-USER-CODE',
          expires_in: 120,
          interval: 1,
        });
      }
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/token`) {
        expect(formOf(init)).toEqual(
          new URLSearchParams({
            client_id: KIMI_CODE_CLIENT_ID,
            device_code: 'private-device-code',
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        );
        return json({
          access_token: 'kimi-access-secret',
          refresh_token: 'kimi-refresh-secret',
          expires_in: 3600,
          scope: 'kimi-code',
          token_type: 'Bearer',
        });
      }
      throw new Error(`unexpected request to ${url}`);
    };

    const pending = signInWithKimiCode({
      openExternal: (url) => {
        openedUrl = url;
        releaseOpen();
      },
      fetch,
      now: () => now,
      pollIntervalMs: 1_000,
      onAuthorization: (presentation) => presentations.push(presentation),
    });
    await opened;
    const record = await pending;

    expect(openedUrl).toBe('https://www.kimi.ai/code/authorize_device?user_code=KIMI-USER-CODE');
    expect(presentations).toEqual([
      {
        url: openedUrl,
        userCode: 'KIMI-USER-CODE',
        expiresAt: now + 120_000,
      },
    ]);
    expect(record).toMatchObject({
      version: 1,
      clientId: KIMI_CODE_CLIENT_ID,
      accessToken: 'kimi-access-secret',
      refreshToken: 'kimi-refresh-secret',
      accessExpiresAt: now + 3_600_000,
      scope: 'kimi-code',
    });
    expect(JSON.stringify(record)).not.toContain('private-device-code');
    expect(requests.map((request) => request.url)).toEqual([
      `${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`,
      `${KIMI_CODE_OAUTH_HOST}/api/oauth/token`,
    ]);
    expect(KIMI_CODE_BASE_URL).toBe('https://api.kimi.ai/coding/v1');
  });

  it('cancels a pending device-code request without opening the approval page', async () => {
    const controller = new AbortController();
    const now = Date.UTC(2026, 9, 30);
    let deviceSignal: AbortSignal | undefined;
    let releaseDevice: (response: Response) => void = () => undefined;
    const deviceResponse = new Promise<Response>((resolve) => {
      releaseDevice = resolve;
    });
    const fetch: FetchLike = async (url, init) => {
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`) {
        deviceSignal = init.signal ?? undefined;
        return deviceResponse;
      }
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/token`) {
        return json({
          access_token: 'kimi-access-secret',
          refresh_token: 'kimi-refresh-secret',
          expires_in: 3600,
          scope: 'kimi-code',
        });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const openExternal = vi.fn();
    const pending = signInWithKimiCode({
      openExternal,
      fetch,
      now: () => now,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(deviceSignal).toBeDefined());

    controller.abort();
    releaseDevice(
      json({
        user_code: 'KIMI-USER-CODE',
        device_code: 'private-device-code',
        verification_uri_complete:
          'https://www.kimi.ai/code/authorize_device?user_code=KIMI-USER-CODE',
        expires_in: 120,
        interval: 1,
      }),
    );

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(deviceSignal?.aborted).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('does not open the approval page when cancelled after receiving the device code', async () => {
    const controller = new AbortController();
    let nowCalls = 0;
    const now = (): number => {
      nowCalls += 1;
      if (nowCalls === 3) controller.abort();
      return Date.UTC(2026, 9, 30);
    };
    const fetch: FetchLike = async (url) => {
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`) {
        return json({
          user_code: 'KIMI-USER-CODE',
          device_code: 'private-device-code',
          verification_uri_complete:
            'https://www.kimi.ai/code/authorize_device?user_code=KIMI-USER-CODE',
          expires_in: 120,
          interval: 1,
        });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const openExternal = vi.fn();

    await expect(
      signInWithKimiCode({ openExternal, fetch, now, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('polls immediately after opening the approval page, then waits between pending replies', async () => {
    const now = Date.UTC(2026, 9, 30);
    vi.useFakeTimers({ now });
    let tokenPolls = 0;
    const fetch: FetchLike = async (url) => {
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`) {
        return json({
          user_code: 'KIMI-USER-CODE',
          device_code: 'private-device-code',
          verification_uri_complete:
            'https://www.kimi.ai/code/authorize_device?user_code=KIMI-USER-CODE',
          expires_in: 120,
          interval: 1,
        });
      }
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/token`) {
        tokenPolls += 1;
        return tokenPolls === 1
          ? json({ error: 'authorization_pending' }, 400)
          : json({
              access_token: 'kimi-access-secret',
              refresh_token: 'kimi-refresh-secret',
              expires_in: 3600,
              scope: 'kimi-code',
            });
      }
      throw new Error(`unexpected request to ${url}`);
    };

    const pending = signInWithKimiCode({
      openExternal: () => undefined,
      fetch,
      now: Date.now,
      pollIntervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(tokenPolls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({
      accessToken: 'kimi-access-secret',
      refreshToken: 'kimi-refresh-secret',
    });
    expect(tokenPolls).toBe(2);
  });

  it('aborts an in-flight device-token poll when cancelled', async () => {
    const controller = new AbortController();
    let pollSignal: AbortSignal | undefined;
    let releasePoll: (response: Response) => void = () => undefined;
    const pollResponse = new Promise<Response>((resolve) => {
      releasePoll = resolve;
    });
    const fetch: FetchLike = async (url, init) => {
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`) {
        return json({
          user_code: 'KIMI-USER-CODE',
          device_code: 'private-device-code',
          verification_uri_complete:
            'https://www.kimi.ai/code/authorize_device?user_code=KIMI-USER-CODE',
          expires_in: 120,
          interval: 1,
        });
      }
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/token`) {
        pollSignal = init.signal ?? undefined;
        return pollResponse;
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const pending = signInWithKimiCode({
      openExternal: () => undefined,
      fetch,
      now: () => Date.UTC(2026, 9, 30),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(pollSignal).toBeDefined());

    controller.abort();
    releasePoll(
      json({
        access_token: 'kimi-access-secret',
        refresh_token: 'kimi-refresh-secret',
        expires_in: 3600,
        scope: 'kimi-code',
      }),
    );

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(pollSignal?.aborted).toBe(true);
  });

  it('refuses a device authorization URL outside the Kimi Code approval page', async () => {
    const fetch: FetchLike = async () =>
      json({
        user_code: 'KIMI-USER-CODE',
        device_code: 'private-device-code',
        verification_uri_complete: 'https://attacker.example/approve?user_code=KIMI-USER-CODE',
        expires_in: 120,
        interval: 1,
      });
    const openExternal = vi.fn();

    await expect(signInWithKimiCode({ openExternal, fetch, now: Date.now })).rejects.toMatchObject({
      code: 'REDIRECT_REFUSED',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('ends at the configured device deadline without sending an out-of-deadline poll', async () => {
    const requests: string[] = [];
    const fetch: FetchLike = async (url) => {
      requests.push(url);
      return json({
        user_code: 'KIMI-USER-CODE',
        device_code: 'private-device-code',
        verification_uri_complete:
          'https://www.kimi.ai/code/authorize_device?user_code=KIMI-USER-CODE',
        expires_in: 120,
        interval: 1,
      });
    };

    await expect(
      signInWithKimiCode({
        openExternal: () => undefined,
        fetch,
        now: Date.now,
        timeoutMs: 100,
        pollIntervalMs: 1_000,
      }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'Kimi device authorization timed out.',
    });
    expect(requests).toEqual([`${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`]);
  });

  it('stops polling at the three-minute limit even when the server allows fifteen minutes', async () => {
    const now = Date.UTC(2026, 9, 30);
    vi.useFakeTimers({ now });
    let tokenPolls = 0;
    const fetch: FetchLike = async (url) => {
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`) {
        return json({
          user_code: 'KIMI-USER-CODE',
          device_code: 'private-device-code',
          verification_uri_complete:
            'https://www.kimi.ai/code/authorize_device?user_code=KIMI-USER-CODE',
          expires_in: 900,
          interval: 1,
        });
      }
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/token`) {
        tokenPolls += 1;
        return json({ error: 'authorization_pending' }, 400);
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const outcome = signInWithKimiCode({
      openExternal: () => undefined,
      fetch,
      now: Date.now,
      pollIntervalMs: 60_000,
    }).catch((error: unknown) => error);

    // Polls at 0, 60 and 120 seconds; the limit is reached at 180 seconds.
    await vi.advanceTimersByTimeAsync(179_999);
    expect(tokenPolls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({
      code: 'TIMEOUT',
      message: 'Kimi device authorization timed out.',
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tokenPolls).toBe(3);
  });

  it('ignores an approval that arrives after the three-minute limit', async () => {
    const now = Date.UTC(2026, 9, 30);
    vi.useFakeTimers({ now });
    let tokenPolls = 0;
    const fetch: FetchLike = async (url) => {
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`) {
        return json({
          user_code: 'KIMI-USER-CODE',
          device_code: 'private-device-code',
          verification_uri_complete:
            'https://www.kimi.ai/code/authorize_device?user_code=KIMI-USER-CODE',
          expires_in: 900,
          interval: 1,
        });
      }
      if (url === `${KIMI_CODE_OAUTH_HOST}/api/oauth/token`) {
        tokenPolls += 1;
        if (tokenPolls === 1) return json({ error: 'authorization_pending' }, 400);
        // The second poll is sent at 170 seconds. Its reply lands at 185 seconds, after the limit, and ignores the
        // request's own abort, so the flow has to refuse it on the clock alone.
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        return json({
          access_token: 'kimi-access-secret',
          refresh_token: 'kimi-refresh-secret',
          expires_in: 3600,
          scope: 'kimi-code',
        });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const outcome = signInWithKimiCode({
      openExternal: () => undefined,
      fetch,
      now: Date.now,
      pollIntervalMs: 170_000,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(170_000);
    expect(tokenPolls).toBe(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await outcome).toMatchObject({ code: 'TIMEOUT' });
    expect(tokenPolls).toBe(2);
  });

  it('turns provider denial into a fixed, credential-safe sign-in error', async () => {
    const now = Date.UTC(2026, 9, 30);
    const fetch: FetchLike = async (url) =>
      url.endsWith('/device_authorization')
        ? json({
            user_code: 'KIMI-USER-CODE',
            device_code: 'private-device-code',
            verification_uri_complete:
              'https://www.kimi.ai/code/authorize_device?user_code=KIMI-USER-CODE',
            expires_in: 120,
            interval: 1,
          })
        : json({ error: 'access_denied', error_description: 'private token details' }, 403);
    let releaseOpen: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });

    const pending = signInWithKimiCode({
      openExternal: () => {
        releaseOpen();
      },
      fetch,
      now: () => now,
      pollIntervalMs: 1_000,
    });
    await opened;

    await expect(pending).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      message: 'Kimi sign-in was denied.',
    });
    await expect(pending).rejects.not.toThrow('private token details');
  });
});

describe('Kimi Code token records', () => {
  it('round-trips records for a configured public client and rejects malformed expiry', () => {
    expect(decodeKimiTokenRecord(encodeKimiTokenRecord(RECORD))).toEqual(RECORD);
    expect(
      decodeKimiTokenRecord(JSON.stringify({ ...RECORD, clientId: 'different-public-client' })),
    ).toMatchObject({ clientId: 'different-public-client' });
    expect(
      decodeKimiTokenRecord(JSON.stringify({ ...RECORD, accessExpiresAt: Infinity })),
    ).toBeUndefined();
  });

  it('rotates and saves the complete token record during refresh', async () => {
    const now = Date.UTC(2026, 9, 30);
    const fetch: FetchLike = async (url, init) => {
      expect(url).toBe(`${KIMI_CODE_OAUTH_HOST}/api/oauth/token`);
      expect(formOf(init)).toEqual(
        new URLSearchParams({
          client_id: KIMI_CODE_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: RECORD.refreshToken,
        }),
      );
      return json({
        access_token: 'kimi-rotated-access',
        refresh_token: 'kimi-rotated-refresh',
        expires_in: 1800,
        scope: 'kimi-code',
        token_type: 'Bearer',
      });
    };
    const save = vi.fn(async () => undefined);

    const refreshed = await refreshKimiCodeTokens({ record: RECORD, fetch, now: () => now, save });

    expect(refreshed).toMatchObject({
      ...RECORD,
      accessToken: 'kimi-rotated-access',
      refreshToken: 'kimi-rotated-refresh',
      accessExpiresAt: now + 1_800_000,
    });
    expect(save).toHaveBeenCalledWith(refreshed);
  });

  it('shares one refresh between concurrent broker requests for a profile', async () => {
    const now = Date.UTC(2026, 9, 30);
    const expired = { ...RECORD, accessExpiresAt: now + 1 };
    let finishRefresh: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      finishRefresh = resolve;
    });
    const fetch: FetchLike = vi.fn(async () => response);
    const save = vi.fn(async () => undefined);
    const keeper = createKimiTokenKeeper({ fetch, now: () => now, save });

    const first = keeper.current('profile', 'handle', expired);
    const second = keeper.current('profile', 'handle', expired);
    finishRefresh?.(
      json({
        access_token: 'kimi-rotated-access',
        refresh_token: 'kimi-rotated-refresh',
        expires_in: 1800,
        scope: 'kimi-code',
      }),
    );

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { accessToken: 'kimi-rotated-access' },
      { accessToken: 'kimi-rotated-access' },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
