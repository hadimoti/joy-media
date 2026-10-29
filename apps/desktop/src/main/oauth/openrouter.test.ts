import { describe, expect, it, vi } from 'vitest';
import { challengeFor } from './pkce.js';
import {
  buildOpenRouterAuthUrl,
  exchangeOpenRouterCode,
  OPENROUTER_AUTH_URL,
  OPENROUTER_KEY_EXCHANGE_URL,
  signInWithOpenRouter,
} from './openrouter.js';

function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Plays the browser: follows the callback_url of the sign-in page with the given query. */
async function returnFromBrowser(authUrl: string, query: (state: string) => string): Promise<void> {
  const url = new URL(authUrl);
  const callback = url.searchParams.get('callback_url') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const response = await fetch(`${callback}?${query(state)}`);
  await response.text();
}

/** The error code of a rejected promise, or undefined when it resolves. */
async function codeOfRejection(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error && 'code' in error ? String(error.code) : 'other';
  }
  return undefined;
}

const unusedFetch = vi.fn(async () => jsonReply({}));

describe('buildOpenRouterAuthUrl', () => {
  it('sends the callback, the S256 challenge and the state to the sign-in page', () => {
    const url = new URL(
      buildOpenRouterAuthUrl({
        callbackUrl: 'http://127.0.0.1:53412/callback',
        codeChallenge: 'challenge-1',
        state: 'state-1',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(OPENROUTER_AUTH_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      callback_url: 'http://127.0.0.1:53412/callback',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
      state: 'state-1',
    });
  });
});

describe('exchangeOpenRouterCode', () => {
  it('posts the code and the verifier to the key endpoint and returns the key', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const key = await exchangeOpenRouterCode({
      code: 'the-code',
      codeVerifier: 'the-verifier',
      fetch: async (url, init) => {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        return jsonReply({ key: 'sk-or-v1-test' });
      },
    });
    expect(key).toBe('sk-or-v1-test');
    expect(sent).toEqual([
      {
        url: OPENROUTER_KEY_EXCHANGE_URL,
        body: { code: 'the-code', code_verifier: 'the-verifier', code_challenge_method: 'S256' },
      },
    ]);
  });

  it('fails without the reply text when OpenRouter refuses the exchange', async () => {
    const error = await exchangeOpenRouterCode({
      code: 'c',
      codeVerifier: 'v',
      fetch: async () => new Response('sk-leaked-in-reply', { status: 401 }),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EXCHANGE_FAILED' });
    expect(String(error)).not.toContain('sk-leaked-in-reply');
  });

  it('fails when the reply holds no key', async () => {
    await expect(
      exchangeOpenRouterCode({ code: 'c', codeVerifier: 'v', fetch: async () => jsonReply({}) }),
    ).rejects.toMatchObject({ code: 'EXCHANGE_FAILED' });
  });

  it('fails with a fixed message when OpenRouter cannot be reached', async () => {
    await expect(
      exchangeOpenRouterCode({
        code: 'c',
        codeVerifier: 'v',
        fetch: async () => {
          throw new Error('getaddrinfo ENOTFOUND openrouter.ai');
        },
      }),
    ).rejects.toMatchObject({
      code: 'EXCHANGE_FAILED',
      message: 'OpenRouter could not be reached.',
    });
  });
});

describe('signInWithOpenRouter', () => {
  it('returns the key, with a verifier that matches the challenge the browser was sent', async () => {
    let authUrl = '';
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const key = await signInWithOpenRouter({
      openExternal: async (url) => {
        authUrl = url;
        await returnFromBrowser(url, (state) => `code=the-code&state=${state}`);
      },
      fetch: async (url, init) => {
        sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return jsonReply({ key: 'sk-or-v1-test' });
      },
      timeoutMs: 5_000,
    });

    expect(key).toBe('sk-or-v1-test');
    const exchange = sent[0];
    expect(exchange?.url).toBe(OPENROUTER_KEY_EXCHANGE_URL);
    expect(challengeFor(String(exchange?.body.code_verifier))).toBe(
      new URL(authUrl).searchParams.get('code_challenge'),
    );
    const callback = new URL(new URL(authUrl).searchParams.get('callback_url') ?? '');
    expect(callback.hostname).toBe('127.0.0.1');
    expect(callback.pathname).toBe('/callback');
  });

  it('refuses a state that does not match, and never exchanges a code', async () => {
    const exchange = vi.fn(async () => jsonReply({ key: 'sk-or-v1-test' }));
    await expect(
      signInWithOpenRouter({
        openExternal: (url) => returnFromBrowser(url, () => 'code=the-code&state=other'),
        fetch: exchange,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('ends with ACCESS_DENIED when the person declines, and never exchanges a code', async () => {
    const exchange = vi.fn(async () => jsonReply({ key: 'sk-or-v1-test' }));
    await expect(
      signInWithOpenRouter({
        openExternal: (url) =>
          returnFromBrowser(url, (state) => `error=access_denied&state=${state}`),
        fetch: exchange,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('times out when the browser never returns, and never exchanges a code', async () => {
    const exchange = vi.fn(async () => jsonReply({ key: 'sk-or-v1-test' }));
    const code = await codeOfRejection(
      signInWithOpenRouter({ openExternal: () => undefined, fetch: exchange, timeoutMs: 30 }),
    );
    expect(code).toBe('TIMEOUT');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('closes the listener when the browser cannot be opened', async () => {
    let callbackUrl = '';
    await expect(
      signInWithOpenRouter({
        openExternal: (url) => {
          callbackUrl = new URL(url).searchParams.get('callback_url') ?? '';
          throw new Error('no browser');
        },
        fetch: unusedFetch,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow('no browser');
    await expect(fetch(callbackUrl)).rejects.toThrow();
  });
});
