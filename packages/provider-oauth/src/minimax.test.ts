import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MINIMAX_ACCESS_TOKEN_REFRESH_MARGIN_MS,
  MINIMAX_POLL_INTERVAL_MS,
  MINIMAX_SCOPE,
  MINIMAX_TOKEN_GRANT_TYPE,
  createMiniMaxTokenKeeper,
  decodeMiniMaxTokenRecord,
  encodeMiniMaxTokenRecord,
  refreshMiniMaxTokens,
  requestMiniMaxDeviceCode,
  signInWithMiniMax,
  type MiniMaxSignInOptions,
  type MiniMaxTokenRecord,
} from './minimax.js';
import type { FetchLike } from './http.js';

const NOW = Date.UTC(2026, 9, 30);
const CLIENT_ID = 'joy-media-client';
const USER_CODE = 'USER-CODE-42';
const ACCESS_TOKEN = 'mini-access-secret';
const REFRESH_TOKEN = 'mini-refresh-secret';
const VERIFICATION_URI = 'https://platform.minimax.io/oauth-authorize?from=server';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function record(overrides: Partial<MiniMaxTokenRecord> = {}): MiniMaxTokenRecord {
  return {
    version: 1,
    clientId: CLIENT_ID,
    region: 'global',
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    accessExpiresAt: NOW + 3_600_000,
    ...overrides,
  };
}

function deviceReply(state: string, overrides: Record<string, unknown> = {}): Response {
  return json({
    user_code: USER_CODE,
    verification_uri: VERIFICATION_URI,
    expired_in: NOW + 60_000,
    interval: 2,
    state,
    ...overrides,
  });
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: (value: T) => void = () => {
    throw new Error('The deferred promise was not initialized.');
  };
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise(value) };
}

function openedGate(): {
  readonly promise: Promise<string>;
  open(url: string): void;
} {
  const opened = deferred<string>();
  return { promise: opened.promise, open: (url) => opened.resolve(url) };
}

function signInOptions(
  fetch: FetchLike,
  openExternal: (url: string) => void | Promise<void>,
  overrides: Partial<MiniMaxSignInOptions> = {},
): MiniMaxSignInOptions {
  return {
    clientId: CLIENT_ID,
    region: 'global',
    openExternal,
    fetch,
    now: () => Date.now(),
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MiniMax device-code sign-in', () => {
  it('sends the RFC 8628 fields and returns the server code and verification URI', async () => {
    const sent: { readonly url: string; readonly init: RequestInit }[] = [];
    const fetch: FetchLike = async (url, init) => {
      sent.push({ url, init });
      const form = new URLSearchParams(String(init.body));
      return deviceReply(form.get('state') ?? '');
    };

    const result = await requestMiniMaxDeviceCode({
      clientId: CLIENT_ID,
      region: 'global',
      fetch,
      now: () => NOW,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://account.minimax.io/oauth2/device/code');
    expect(sent[0]?.init.method).toBe('POST');
    expect(new Headers(sent[0]?.init.headers).get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    );
    const form = new URLSearchParams(String(sent[0]?.init.body));
    expect(form.get('response_type')).toBe('code');
    expect(form.get('client_id')).toBe(CLIENT_ID);
    expect(form.get('scope')).toBe('openid profile coding_plan');
    expect(form.get('code_challenge_method')).toBe('S256');
    expect(form.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result).toMatchObject({
      userCode: USER_CODE,
      verificationUri: VERIFICATION_URI,
      expiresAtMs: NOW + 60_000,
      intervalMs: MINIMAX_POLL_INTERVAL_MS,
    });
    // The handle carries what is needed to redeem the code, and nothing that leaves the app.
    expect(result.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.state).toBe(form.get('state'));
    expect(MINIMAX_SCOPE).toBe('openid profile coding_plan');
  });

  it('refuses a returned state mismatch before opening the browser', async () => {
    vi.useFakeTimers({ now: NOW });
    const openExternal = vi.fn();
    const fetch: FetchLike = async (_url, init) => {
      const sentState = new URLSearchParams(String(init.body)).get('state');
      return deviceReply(`${sentState ?? ''}-wrong`);
    };

    await expect(signInWithMiniMax(signInOptions(fetch, openExternal))).rejects.toMatchObject({
      code: 'STATE_MISMATCH',
      message: 'MiniMax returned a different device authorization state.',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('refuses an approve page on another host before opening the browser', async () => {
    vi.useFakeTimers({ now: NOW });
    const openExternal = vi.fn();
    const fetch: FetchLike = async (_url, init) => {
      const state = new URLSearchParams(String(init.body)).get('state') ?? '';
      return deviceReply(state, {
        verification_uri: 'https://example.invalid/oauth-authorize',
      });
    };

    await expect(signInWithMiniMax(signInOptions(fetch, openExternal))).rejects.toMatchObject({
      code: 'REDIRECT_REFUSED',
      message: 'MiniMax returned an approve page on another host.',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('refuses an incomplete device-code reply without opening the browser', async () => {
    vi.useFakeTimers({ now: NOW });
    const openExternal = vi.fn();
    const fetch: FetchLike = async (_url, init) => {
      const state = new URLSearchParams(String(init.body)).get('state') ?? '';
      return deviceReply(state, { user_code: undefined });
    };

    await expect(signInWithMiniMax(signInOptions(fetch, openExternal))).rejects.toMatchObject({
      code: 'EXCHANGE_FAILED',
      message: 'MiniMax returned an incomplete device-code reply.',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens the exact server URI once, uses its user code, and returns the issued token record', async () => {
    vi.useFakeTimers({ now: NOW });
    const gate = openedGate();
    const openExternal = vi.fn((url: string) => gate.open(url));
    const sent: { readonly url: string; readonly init: RequestInit }[] = [];
    const fetch: FetchLike = async (url, init) => {
      sent.push({ url, init });
      if (url.endsWith('/device/code')) {
        const state = new URLSearchParams(String(init.body)).get('state') ?? '';
        return deviceReply(state);
      }
      return json({
        status: 'success',
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expired_in: 3_600,
        resource_url: 'https://api.minimax.io/v1',
      });
    };
    const pending = signInWithMiniMax(signInOptions(fetch, openExternal));

    await gate.promise;
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(MINIMAX_POLL_INTERVAL_MS);
    const result = await pending;

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(
      'https://platform.minimax.io/oauth-authorize?from=server&user_code=USER-CODE-42',
    );
    expect(sent).toHaveLength(2);
    const tokenRequest = sent[1];
    expect(tokenRequest?.url).toBe('https://account.minimax.io/oauth2/token');
    expect(tokenRequest?.init.method).toBe('POST');
    const form = new URLSearchParams(String(tokenRequest?.init.body));
    expect(form.get('grant_type')).toBe(MINIMAX_TOKEN_GRANT_TYPE);
    expect(form.get('client_id')).toBe(CLIENT_ID);
    expect(form.get('user_code')).toBe(USER_CODE);
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result).toEqual({
      version: 1,
      clientId: CLIENT_ID,
      region: 'global',
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      accessExpiresAt: NOW + MINIMAX_POLL_INTERVAL_MS + 3_600_000,
      resourceUrl: 'https://api.minimax.io/v1',
    });
  });

  it('puts the one-time code on the approve URL even when the server sends a bare URI', async () => {
    vi.useFakeTimers({ now: NOW });
    const gate = openedGate();
    const openExternal = vi.fn((url: string) => gate.open(url));
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith('/device/code')) {
        const state = new URLSearchParams(String(init.body)).get('state') ?? '';
        return deviceReply(state, {
          verification_uri: 'https://platform.minimax.io/oauth-authorize',
        });
      }
      return json({
        status: 'success',
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expired_in: 3_600,
      });
    };
    const pending = signInWithMiniMax(signInOptions(fetch, openExternal));

    await gate.promise;
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(MINIMAX_POLL_INTERVAL_MS);
    await pending;

    expect(openExternal).toHaveBeenCalledWith(
      `https://platform.minimax.io/oauth-authorize?user_code=${USER_CODE}`,
    );
  });

  it.each([
    { serverIntervalMs: 3_000, expectedPollIntervalMs: 3_000 },
    { serverIntervalMs: 3, expectedPollIntervalMs: MINIMAX_POLL_INTERVAL_MS },
  ])(
    'polls after $expectedPollIntervalMs ms when MiniMax returns interval $serverIntervalMs ms',
    async ({ serverIntervalMs, expectedPollIntervalMs }) => {
      vi.useFakeTimers({ now: NOW });
      const gate = openedGate();
      let pollCount = 0;
      const fetch: FetchLike = async (url, init) => {
        if (url.endsWith('/device/code')) {
          const state = new URLSearchParams(String(init.body)).get('state') ?? '';
          return deviceReply(state, { interval: serverIntervalMs });
        }
        pollCount += 1;
        return json({
          status: 'success',
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          expired_in: 3_600,
        });
      };
      const pending = signInWithMiniMax(signInOptions(fetch, (url) => gate.open(url)));
      const outcome = pending.then(
        (result) => result,
        (error: unknown) => error,
      );

      await gate.promise;
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(expectedPollIntervalMs - 1);
      expect(pollCount).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(pollCount).toBe(1);

      await expect(outcome).resolves.toMatchObject({ accessToken: ACCESS_TOKEN });
    },
  );

  it('reads an absolute expiry as an epoch and a relative one as seconds', async () => {
    vi.useFakeTimers({ now: NOW });
    const gate = openedGate();
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith('/device/code')) {
        const state = new URLSearchParams(String(init.body)).get('state') ?? '';
        return deviceReply(state);
      }
      return json({
        status: 'success',
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expired_in: NOW + 7_200_000,
      });
    };
    const pending = signInWithMiniMax(signInOptions(fetch, (url) => gate.open(url)));

    await gate.promise;
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(MINIMAX_POLL_INTERVAL_MS);

    await expect(pending).resolves.toMatchObject({
      accessExpiresAt: NOW + 7_200_000,
    });
  });

  it('reads an absolute expiry expressed as epoch seconds', async () => {
    vi.useFakeTimers({ now: NOW });
    const gate = openedGate();
    const accessExpiresAt = Math.floor((NOW + 7_200_000) / 1000) * 1000;
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith('/device/code')) {
        const state = new URLSearchParams(String(init.body)).get('state') ?? '';
        return deviceReply(state);
      }
      return json({
        status: 'success',
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expired_in: accessExpiresAt / 1000,
      });
    };
    const pending = signInWithMiniMax(signInOptions(fetch, (url) => gate.open(url)));

    await gate.promise;
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(MINIMAX_POLL_INTERVAL_MS);

    await expect(pending).resolves.toMatchObject({ accessExpiresAt });
  });

  it('refuses an unreadable token reply', async () => {
    vi.useFakeTimers({ now: NOW });
    const gate = openedGate();
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith('/device/code')) {
        const state = new URLSearchParams(String(init.body)).get('state') ?? '';
        return deviceReply(state);
      }
      return new Response('not json', { status: 200 });
    };
    const pending = signInWithMiniMax(signInOptions(fetch, (url) => gate.open(url)));
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    await gate.promise;
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(MINIMAX_POLL_INTERVAL_MS);

    expect(await outcome).toMatchObject({
      code: 'EXCHANGE_FAILED',
      message: 'MiniMax returned an unreadable token reply.',
    });
  });

  it('keeps polling after a refused pending reply and waits at least two seconds between polls', async () => {
    vi.useFakeTimers({ now: NOW });
    const gate = openedGate();
    let pollCount = 0;
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith('/device/code')) {
        const state = new URLSearchParams(String(init.body)).get('state') ?? '';
        return deviceReply(state, { interval: 0.25 });
      }
      pollCount += 1;
      if (pollCount === 1) return json({ status: 'pending' }, 403);
      return json({
        status: 'success',
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expired_in: 3_600,
      });
    };
    const pending = signInWithMiniMax(
      signInOptions(fetch, (url) => gate.open(url), { pollIntervalMs: 1 }),
    );

    await gate.promise;
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(MINIMAX_POLL_INTERVAL_MS - 1);
    expect(pollCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pollCount).toBe(1);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(MINIMAX_POLL_INTERVAL_MS);

    await expect(pending).resolves.toMatchObject({ accessToken: ACCESS_TOKEN });
    expect(pollCount).toBe(2);
  });

  it('reports CANCELLED when a pending reply says the approval page was closed', async () => {
    vi.useFakeTimers({ now: NOW });
    const gate = openedGate();
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith('/device/code')) {
        const state = new URLSearchParams(String(init.body)).get('state') ?? '';
        return deviceReply(state);
      }
      return json({ status: 'pending', notification_message: 'The user closed the approval page.' }, 403);
    };
    const pending = signInWithMiniMax(signInOptions(fetch, (url) => gate.open(url)));
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    await gate.promise;
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(MINIMAX_POLL_INTERVAL_MS);

    expect(await outcome).toMatchObject({
      code: 'CANCELLED',
      message: 'MiniMax sign-in was cancelled.',
    });
  });

  it('refuses an error reply with a fixed message and never repeats the server text or a token', async () => {
    vi.useFakeTimers({ now: NOW });
    const gate = openedGate();
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith('/device/code')) {
        const state = new URLSearchParams(String(init.body)).get('state') ?? '';
        return deviceReply(state);
      }
      return json(
        {
          status: 'error',
          access_token: ACCESS_TOKEN,
          base_resp: { status_msg: `Approval rejected with ${ACCESS_TOKEN} ${USER_CODE}` },
        },
        400,
      );
    };
    const pending = signInWithMiniMax(signInOptions(fetch, (url) => gate.open(url)));
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    await gate.promise;
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(MINIMAX_POLL_INTERVAL_MS);
    const error = await outcome;
    expect(error).toMatchObject({
      code: 'EXCHANGE_FAILED',
      message: 'MiniMax reported an error while signing in.',
    });
    const message = error instanceof Error ? error.message : '';
    expect(message).not.toContain('Approval rejected');
    expect(message).not.toContain(ACCESS_TOKEN);
    expect(message).not.toContain(REFRESH_TOKEN);
    expect(message).not.toContain(USER_CODE);
  });

  it('returns TIMEOUT when the deadline passes before the next poll', async () => {
    vi.useFakeTimers({ now: NOW });
    const gate = openedGate();
    let requestCount = 0;
    const fetch: FetchLike = async (url, init) => {
      requestCount += 1;
      if (url.endsWith('/device/code')) {
        const state = new URLSearchParams(String(init.body)).get('state') ?? '';
        return deviceReply(state);
      }
      return json({ status: 'pending' }, 403);
    };
    const pending = signInWithMiniMax(
      signInOptions(fetch, (url) => gate.open(url), { timeoutMs: 1_000 }),
    );
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    await gate.promise;
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toMatchObject({
      code: 'TIMEOUT',
      message: 'MiniMax device authorization timed out.',
    });
    expect(requestCount).toBe(1);
  });
});

describe('MiniMax token refresh', () => {
  it('rotates the refresh token and saves the complete record in one call', async () => {
    let sentBody = '';
    const saved: MiniMaxTokenRecord[] = [];
    const result = await refreshMiniMaxTokens({
      record: record(),
      fetch: async (_url, init) => {
        sentBody = String(init.body);
        return json({
          status: 'success',
          access_token: 'mini-access-next',
          refresh_token: 'mini-refresh-next',
          expired_in: 1_800,
        });
      },
      now: () => NOW,
      save: async (next) => {
        saved.push(next);
      },
    });

    expect(new URLSearchParams(sentBody)).toEqual(
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: REFRESH_TOKEN,
      }),
    );
    expect(result).toMatchObject({
      accessToken: 'mini-access-next',
      refreshToken: 'mini-refresh-next',
      accessExpiresAt: NOW + 1_800_000,
    });
    expect(saved).toEqual([result]);
  });

  it('keeps the old refresh token when the server does not rotate it', async () => {
    const result = await refreshMiniMaxTokens({
      record: record(),
      fetch: async () =>
        json({ status: 'success', access_token: 'mini-access-next', expired_in: 1_800 }),
      now: () => NOW,
      save: async () => undefined,
    });

    expect(result.refreshToken).toBe(REFRESH_TOKEN);
  });

  it('refreshes only within the margin and shares one refresh in flight for the profile', async () => {
    const response = deferred<Response>();
    const fetch = vi.fn<FetchLike>(() => response.promise);
    const save = vi.fn(async () => undefined);
    const keeper = createMiniMaxTokenKeeper({
      fetch,
      now: () => NOW,
      save,
    });
    const outside = record({ accessExpiresAt: NOW + MINIMAX_ACCESS_TOKEN_REFRESH_MARGIN_MS + 1 });
    const inside = record({ accessExpiresAt: NOW + MINIMAX_ACCESS_TOKEN_REFRESH_MARGIN_MS });

    await expect(keeper.current('profile-1', 'handle-1', outside)).resolves.toBe(outside);
    expect(fetch).not.toHaveBeenCalled();
    const first = keeper.current('profile-1', 'handle-1', inside);
    const second = keeper.current('profile-1', 'handle-1', inside);
    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    response.resolve(
      json({
        status: 'success',
        access_token: 'mini-access-next',
        refresh_token: 'mini-refresh-next',
        expired_in: 1_800,
      }),
    );

    await expect(first).resolves.toMatchObject({ accessToken: 'mini-access-next' });
    await expect(second).resolves.toMatchObject({ accessToken: 'mini-access-next' });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('MiniMax token record encoding', () => {
  it('round-trips a version-one token record', () => {
    expect(decodeMiniMaxTokenRecord(encodeMiniMaxTokenRecord(record()))).toEqual(record());
  });

  it.each([
    'sk-cp-plain-api-key',
    JSON.stringify({ version: 1, clientId: CLIENT_ID }),
    JSON.stringify({ ...record(), version: 2 }),
  ])('returns undefined for a non-token-record secret: %s', (secret) => {
    expect(decodeMiniMaxTokenRecord(secret)).toBeUndefined();
  });
});
