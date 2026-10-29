import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { challengeFor } from './pkce.js';
import {
  type ChatGptTokenRecord,
  buildChatGptAuthUrl,
  CHATGPT_AUTHORIZE_URL,
  CHATGPT_CALLBACK_PATH,
  CHATGPT_ISSUER,
  CHATGPT_JWKS_URL,
  CHATGPT_REQUIRED_SCOPE,
  CHATGPT_SCOPE,
  CHATGPT_TOKEN_URL,
  createChatGptTokenKeeper,
  decodeTokenRecord,
  encodeTokenRecord,
  exchangeChatGptCode,
  isExtAgentHostId,
  newExtAgentHostId,
  refreshChatGptTokens,
  signInWithChatGpt,
  verifyIdToken,
} from './chatgpt.js';
import type { FetchLike } from './http.js';

const CLIENT_ID = 'test-client-id';
const HOST_ID = 'urn:uuid:550e8400-e29b-41d4-a716-446655440000';
const KID = 'test-kid';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

const now = (): number => Date.now();
const nowSeconds = (): number => Math.floor(now() / 1000);

function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** An RS256 ID token, signed with the test key. */
function signed(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT', kid: KID },
): string {
  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey, 'base64url');
  return `${signingInput}.${signature}`;
}

function claimsFor(
  nonce: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iss: CHATGPT_ISSUER,
    aud: [CLIENT_ID],
    sub: 'acct-1',
    nonce,
    exp: nowSeconds() + 600,
    ...overrides,
  };
}

/** A provider: the key set answers with the test key, and the token endpoint answers with `tokenReply`. */
function provider(tokenReply: (form: URLSearchParams) => Response | Promise<Response>): {
  readonly fetch: FetchLike;
  readonly tokenForms: URLSearchParams[];
} {
  const tokenForms: URLSearchParams[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url === CHATGPT_JWKS_URL) return jsonReply({ keys: [JWK] });
    if (url === CHATGPT_TOKEN_URL) {
      const form = new URLSearchParams(String(init.body));
      tokenForms.push(form);
      return tokenReply(form);
    }
    throw new Error(`unexpected request to ${url}`);
  };
  return { fetch, tokenForms };
}

/** Plays the browser: follows the redirect_uri of the authorization request with the given query. */
async function returnFromBrowser(authUrl: string, query: (state: string) => string): Promise<void> {
  const url = new URL(authUrl);
  const redirect = url.searchParams.get('redirect_uri') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const response = await fetch(`${redirect}?${query(state)}`);
  await response.text();
}

/** The error code of a rejected promise or a throwing call, or undefined when it does not fail. */
async function codeOf(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error && 'code' in error ? String(error.code) : 'other';
  }
  return undefined;
}

function recordAt(expiresInMs: number): ChatGptTokenRecord {
  return {
    version: 1,
    clientId: CLIENT_ID,
    accountId: 'acct-1',
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    accessExpiresAt: now() + expiresInMs,
  };
}

describe('buildChatGptAuthUrl', () => {
  it('builds the authorization request with PKCE, state, nonce and the install ID', () => {
    const url = new URL(
      buildChatGptAuthUrl({
        clientId: CLIENT_ID,
        redirectUri: `http://127.0.0.1:1455${CHATGPT_CALLBACK_PATH}`,
        state: 'state-1',
        nonce: 'nonce-1',
        codeChallenge: 'challenge-1',
        extAgentHostId: HOST_ID,
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(CHATGPT_AUTHORIZE_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'http://127.0.0.1:1455/auth/callback',
      scope: CHATGPT_SCOPE,
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
      state: 'state-1',
      nonce: 'nonce-1',
      ext_agent_host_id: HOST_ID,
      resource: 'https://api.openai.com/v1',
    });
  });

  it('never redirects to localhost, and refuses any other path', () => {
    const build = (redirectUri: string): (() => string) => {
      return () =>
        buildChatGptAuthUrl({
          clientId: CLIENT_ID,
          redirectUri,
          state: 's',
          nonce: 'n',
          codeChallenge: 'c',
          extAgentHostId: 'i',
        });
    };
    expect(() => build('http://localhost:1455/auth/callback')()).toThrow();
    expect(() => build('http://127.0.0.1:1455/other')()).toThrow();
    expect(() => build('https://127.0.0.1:1455/auth/callback')()).toThrow();
    expect(() => build('http://127.0.0.1:1455/auth/callback')()).not.toThrow();
  });
});

describe('ChatGPT host ID', () => {
  it.each([
    'urn:uuid:550e8400-e29b-41d4-a716-446655440000',
    'urn:uuid:6ba7b810-9dad-41d1-80b4-00c04fd430c8',
  ])('accepts %s, the urn:uuid form', (hostId) => {
    expect(isExtAgentHostId(hostId)).toBe(true);
  });

  it.each([
    ['a bare UUID, the form ChatGPT refused', '550e8400-e29b-41d4-a716-446655440000'],
    ['a name, as the tests used before', 'install-1'],
    ['an empty value', ''],
    ['the scheme with no ID', 'urn:uuid:'],
    ['a UUID without hyphens', 'urn:uuid:550e8400e29b41d4a716446655440000'],
    ['a UUID with a short group', 'urn:uuid:550e8400-e29b-41d4-a716-44665544000'],
    ['a UUID with a wrong variant', 'urn:uuid:550e8400-e29b-41d4-c716-446655440000'],
    ['a UUID with version 0', 'urn:uuid:550e8400-e29b-04d4-a716-446655440000'],
    ['a UUID with a trailing space', 'urn:uuid:550e8400-e29b-41d4-a716-446655440000 '],
    ['another scheme', 'uuid:550e8400-e29b-41d4-a716-446655440000'],
  ])('refuses %s', (_name, hostId) => {
    expect(isExtAgentHostId(hostId)).toBe(false);
  });

  it('creates a new urn:uuid ID each time, and each one is accepted', () => {
    const first = newExtAgentHostId();
    expect(isExtAgentHostId(first)).toBe(true);
    expect(newExtAgentHostId()).not.toBe(first);
  });

  it('refuses a host ID of the wrong form before any browser opens', async () => {
    const openExternal = vi.fn();
    const { fetch } = provider(() => jsonReply({}));
    const failure = await codeOf(() =>
      signInWithChatGpt({
        issuedClientId: undefined,
        extAgentHostId: 'install-1',
        openExternal,
        fetch,
        now,
        port: 0,
        timeoutMs: 5_000,
      }),
    );
    expect(failure).toBe('HOST_ID_INVALID');
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('ID token verification', () => {
  it('accepts a token signed by the issuer key for this client and nonce', async () => {
    const { fetch } = provider(() => jsonReply({}));
    await expect(
      verifyIdToken({
        idToken: signed(claimsFor('nonce-1')),
        clientId: CLIENT_ID,
        nonce: 'nonce-1',
        fetch,
        nowSeconds: nowSeconds(),
      }),
    ).resolves.toEqual({ sub: 'acct-1' });
  });

  it.each([
    ['an HS256 header', signed(claimsFor('nonce-1'), { alg: 'HS256', typ: 'JWT', kid: KID })],
    [
      'a tampered payload',
      (() => {
        const [header, , signature] = signed(claimsFor('nonce-1')).split('.');
        return `${header}.${base64url(claimsFor('nonce-1', { sub: 'attacker' }))}.${signature}`;
      })(),
    ],
    ['another issuer', signed(claimsFor('nonce-1', { iss: 'https://evil.example' }))],
    ['another audience', signed(claimsFor('nonce-1', { aud: ['other-client'] }))],
    ['an expired token', signed(claimsFor('nonce-1', { exp: nowSeconds() - 3600 }))],
    ['another nonce', signed(claimsFor('other-nonce'))],
    [
      'an unknown key id',
      signed(claimsFor('nonce-1'), { alg: 'RS256', typ: 'JWT', kid: 'unknown' }),
    ],
    ['no subject', signed(claimsFor('nonce-1', { sub: undefined }))],
  ])('refuses %s', async (_name, idToken) => {
    const { fetch } = provider(() => jsonReply({}));
    const code = await codeOf(() =>
      verifyIdToken({
        idToken,
        clientId: CLIENT_ID,
        nonce: 'nonce-1',
        fetch,
        nowSeconds: nowSeconds(),
      }),
    );
    expect(code).toBe('ID_TOKEN_INVALID');
  });
});

describe('exchangeChatGptCode', () => {
  const exchange = (fetch: FetchLike) =>
    exchangeChatGptCode({
      clientId: CLIENT_ID,
      code: 'the-code',
      codeVerifier: 'the-verifier',
      redirectUri: `http://127.0.0.1:1455${CHATGPT_CALLBACK_PATH}`,
      fetch,
    });

  it('returns the tokens when the required scope was granted', async () => {
    const { fetch, tokenForms } = provider(() =>
      jsonReply({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        id_token: 'id-1',
        expires_in: 3600,
        scope: CHATGPT_SCOPE,
      }),
    );
    await expect(exchange(fetch)).resolves.toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      idToken: 'id-1',
      expiresInSeconds: 3600,
    });
    expect(tokenForms[0]?.get('grant_type')).toBe('authorization_code');
    expect(tokenForms[0]?.get('code_verifier')).toBe('the-verifier');
  });

  it('refuses a sign-in that did not grant the required scope', async () => {
    const { fetch } = provider(() =>
      jsonReply({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        id_token: 'id-1',
        expires_in: 3600,
        scope: 'openid profile email offline_access',
      }),
    );
    await expect(exchange(fetch)).rejects.toMatchObject({ code: 'MISSING_SCOPE' });
    expect(CHATGPT_REQUIRED_SCOPE).toBe('chatgpt.tokens.use.direct');
  });

  it('asks for a new sign-in on invalid_grant', async () => {
    const { fetch } = provider(() => jsonReply({ error: 'invalid_grant' }, 400));
    await expect(exchange(fetch)).rejects.toMatchObject({ code: 'SIGN_IN_REQUIRED' });
  });

  it('fails on a reply that is not JSON, without its text', async () => {
    const { fetch } = provider(() => new Response('access_token=leaked', { status: 200 }));
    const error = await exchange(fetch).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EXCHANGE_FAILED' });
    expect(String(error)).not.toContain('leaked');
  });
});

describe('signInWithChatGpt', () => {
  it('registers a client when none is saved, and keeps the client ChatGPT names on the callback', async () => {
    const issued = 'oaiapp_issued-1';
    let authUrl = '';
    const { fetch, tokenForms } = provider(() => {
      // The nonce is the one the browser was sent with, and the ID token is for the client ChatGPT issued.
      const nonce = new URL(authUrl).searchParams.get('nonce') ?? '';
      return jsonReply({
        access_token: 'at-new',
        refresh_token: 'rt-new',
        id_token: signed(claimsFor(nonce, { aud: [issued] })),
        expires_in: 3600,
        scope: CHATGPT_SCOPE,
      });
    });

    const record = await signInWithChatGpt({
      issuedClientId: undefined,
      extAgentHostId: HOST_ID,
      openExternal: async (url) => {
        authUrl = url;
        await returnFromBrowser(url, (state) => `client_id=${issued}&code=the-code&state=${state}`);
      },
      fetch,
      now,
      port: 0,
      timeoutMs: 5_000,
    });

    const sent = new URL(authUrl).searchParams;
    expect(sent.get('client_id')).toBe('dynamic_agent_client');
    expect(sent.get('agent_name_hint')).toBe('JOY Media');
    expect(sent.get('ext_agent_host_id')).toBe(HOST_ID);
    expect(sent.get('resource')).toBe('https://api.openai.com/v1');
    expect(sent.get('scope')).toBe(CHATGPT_SCOPE);
    expect(record).toMatchObject({ clientId: issued, accountId: 'acct-1', accessToken: 'at-new' });
    expect(tokenForms[0]?.get('client_id')).toBe(issued);
    expect(tokenForms[0]?.get('resource')).toBe('https://api.openai.com/v1');
  });

  it('refuses a registration whose callback names no client, and exchanges no code', async () => {
    const { fetch, tokenForms } = provider(() => jsonReply({}));
    const failure = await codeOf(() =>
      signInWithChatGpt({
        issuedClientId: undefined,
        extAgentHostId: HOST_ID,
        openExternal: async (url) => {
          await returnFromBrowser(url, (state) => `code=the-code&state=${state}`);
        },
        fetch,
        now,
        port: 0,
        timeoutMs: 5_000,
      }),
    );
    expect(failure).toBe('REGISTRATION_FAILED');
    expect(tokenForms).toHaveLength(0);
  });

  it('refuses a sign-in to a saved account that comes back with another client', async () => {
    const { fetch, tokenForms } = provider(() => jsonReply({}));
    const failure = await codeOf(() =>
      signInWithChatGpt({
        issuedClientId: CLIENT_ID,
        extAgentHostId: HOST_ID,
        openExternal: async (url) => {
          await returnFromBrowser(
            url,
            (state) => `client_id=oaiapp_other&code=the-code&state=${state}`,
          );
        },
        fetch,
        now,
        port: 0,
        timeoutMs: 5_000,
      }),
    );
    expect(failure).toBe('REGISTRATION_FAILED');
    expect(tokenForms).toHaveLength(0);
  });

  it('signs in through the loopback callback and keeps the account and tokens in one record', async () => {
    let authUrl = '';
    const { fetch, tokenForms } = provider(() => {
      // The nonce is the one the browser was sent with, so the ID token must carry it.
      const nonce = new URL(authUrl).searchParams.get('nonce') ?? '';
      return jsonReply({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        id_token: signed(claimsFor(nonce)),
        expires_in: 3600,
        scope: CHATGPT_SCOPE,
      });
    });

    const record = await signInWithChatGpt({
      issuedClientId: CLIENT_ID,
      extAgentHostId: HOST_ID,
      openExternal: async (url) => {
        authUrl = url;
        await returnFromBrowser(url, (state) => `code=the-code&state=${state}`);
      },
      fetch,
      now,
      port: 0,
      timeoutMs: 5_000,
    });

    expect(record).toMatchObject({
      version: 1,
      clientId: CLIENT_ID,
      accountId: 'acct-1',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
    });
    expect(record.accessExpiresAt).toBeGreaterThan(now());
    const form = tokenForms[0];
    expect(challengeFor(String(form?.get('code_verifier')))).toBe(
      new URL(authUrl).searchParams.get('code_challenge'),
    );
    expect(form?.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  });

  it('refuses a state that does not match, and never exchanges a code', async () => {
    const { fetch, tokenForms } = provider(() => jsonReply({}));
    await expect(
      signInWithChatGpt({
        issuedClientId: CLIENT_ID,
        extAgentHostId: HOST_ID,
        openExternal: (url) => returnFromBrowser(url, () => 'code=the-code&state=other'),
        fetch,
        now,
        port: 0,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    expect(tokenForms).toHaveLength(0);
  });

  it('ends with ACCESS_DENIED when the person declines, and closes the listener', async () => {
    let redirect = '';
    const { fetch, tokenForms } = provider(() => jsonReply({}));
    await expect(
      signInWithChatGpt({
        issuedClientId: CLIENT_ID,
        extAgentHostId: HOST_ID,
        openExternal: async (url) => {
          redirect = new URL(url).searchParams.get('redirect_uri') ?? '';
          await returnFromBrowser(url, (state) => `error=access_denied&state=${state}`);
        },
        fetch,
        now,
        port: 0,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(tokenForms).toHaveLength(0);
    await expect(globalThis.fetch(redirect)).rejects.toThrow();
  });
});

describe('refreshChatGptTokens', () => {
  it('refreshes once and saves the record in one write, with the rotated refresh token', async () => {
    const saved: ChatGptTokenRecord[] = [];
    const { fetch, tokenForms } = provider(() =>
      jsonReply({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    );
    const next = await refreshChatGptTokens({
      record: recordAt(-1),
      fetch,
      now,
      save: async (record) => {
        saved.push(record);
      },
    });
    expect(saved).toEqual([next]);
    expect(next).toMatchObject({
      accountId: 'acct-1',
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });
    expect(tokenForms).toHaveLength(1);
    expect(tokenForms[0]?.get('grant_type')).toBe('refresh_token');
    expect(tokenForms[0]?.get('refresh_token')).toBe('old-refresh');
  });

  it('keeps the refresh token it already holds when the provider does not rotate it', async () => {
    const { fetch } = provider(() => jsonReply({ access_token: 'new-access', expires_in: 3600 }));
    const next = await refreshChatGptTokens({
      record: recordAt(-1),
      fetch,
      now,
      save: async () => undefined,
    });
    expect(next.refreshToken).toBe('old-refresh');
  });

  it('asks for a new sign-in on invalid_grant, and writes nothing', async () => {
    const save = vi.fn(async () => undefined);
    const { fetch } = provider(() => jsonReply({ error: 'invalid_grant' }, 400));
    await expect(
      refreshChatGptTokens({ record: recordAt(-1), fetch, now, save }),
    ).rejects.toMatchObject({ code: 'SIGN_IN_REQUIRED' });
    expect(save).not.toHaveBeenCalled();
  });

  it('makes one write, and when it fails nothing else is written', async () => {
    const save = vi.fn(async () => {
      throw new Error('disk full');
    });
    const { fetch } = provider(() =>
      jsonReply({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    );
    await expect(refreshChatGptTokens({ record: recordAt(-1), fetch, now, save })).rejects.toThrow(
      'disk full',
    );
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('createChatGptTokenKeeper', () => {
  it('sends a fresh token as it is, and refreshes only when it is close to expiry', async () => {
    const { fetch, tokenForms } = provider(() =>
      jsonReply({ access_token: 'new-access', expires_in: 3600 }),
    );
    const saved: string[] = [];
    const keeper = createChatGptTokenKeeper({
      fetch,
      now,
      save: async (profileId, handleId, record) => {
        saved.push(`${profileId}/${handleId}:${record.accessToken}`);
      },
    });
    const fresh = recordAt(10 * 60_000);
    await expect(keeper.current('profile-1', 'handle-1', fresh)).resolves.toBe(fresh);
    expect(tokenForms).toHaveLength(0);

    await keeper.current('profile-1', 'handle-1', recordAt(-1));
    expect(tokenForms).toHaveLength(1);
    expect(saved).toEqual(['profile-1/handle-1:new-access']);
  });

  it('shares one refresh between concurrent requests for the same profile', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetch, tokenForms } = provider(async () => {
      await gate;
      return jsonReply({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      });
    });
    const keeper = createChatGptTokenKeeper({ fetch, now, save: async () => undefined });
    const stale = recordAt(-1);
    const first = keeper.current('profile-1', 'handle-1', stale);
    const second = keeper.current('profile-1', 'handle-1', stale);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(tokenForms).toHaveLength(1);
  });
});

describe('token record', () => {
  it('round-trips a record and refuses anything that is not one', () => {
    const record = recordAt(1_000);
    expect(decodeTokenRecord(encodeTokenRecord(record))).toEqual(record);
    expect(decodeTokenRecord('not json')).toBeUndefined();
    expect(decodeTokenRecord(JSON.stringify({ version: 2 }))).toBeUndefined();
    expect(decodeTokenRecord(JSON.stringify({ ...record, accessToken: 5 }))).toBeUndefined();
  });
});

describe('the requests a ChatGPT sign-in makes', () => {
  it('sends the resource and the saved client on a refresh, and no scope', async () => {
    const { fetch, tokenForms } = provider(() =>
      jsonReply({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }),
    );
    const record = recordAt(-1_000);
    await refreshChatGptTokens({ record, fetch, now, save: async () => undefined });
    const form = tokenForms[0];
    expect(form?.get('grant_type')).toBe('refresh_token');
    expect(form?.get('client_id')).toBe(record.clientId);
    expect(form?.get('resource')).toBe('https://api.openai.com/v1');
    expect(form?.has('scope')).toBe(false);
  });
});
