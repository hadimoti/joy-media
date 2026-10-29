import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CHATGPT_RESPONSES_BASE_URL } from '../providers/adapters/chatgpt-responses.js';
import {
  CHATGPT_ISSUER,
  CHATGPT_JWKS_URL,
  CHATGPT_SCOPE,
  CHATGPT_TOKEN_URL,
  decodeTokenRecord,
  isExtAgentHostId,
} from './chatgpt.js';
import type { FetchLike } from './http.js';
import { OPENROUTER_BASE_URL } from './openrouter.js';
import {
  createProviderSignIn,
  INSTALL_ID_SETTING,
  loadOrCreateInstallId,
  OPENROUTER_DEFAULT_MODEL,
} from './sign-in.js';

const CLIENT_ID = 'test-client-id';
const HOST_ID = 'urn:uuid:550e8400-e29b-41d4-a716-446655440000';
const KID = 'test-kid';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function signedIdToken(nonce: string): string {
  const base64url = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = base64url({ alg: 'RS256', typ: 'JWT', kid: KID });
  const payload = base64url({
    iss: CHATGPT_ISSUER,
    aud: [CLIENT_ID],
    sub: 'acct-1',
    nonce,
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey, 'base64url');
  return `${header}.${payload}.${signature}`;
}

/** Plays the browser: follows the redirect_uri of the authorization request with the given query. */
async function returnFromBrowser(
  authUrl: string,
  parameter: 'callback_url' | 'redirect_uri',
  query: (state: string) => string,
): Promise<void> {
  const url = new URL(authUrl);
  const redirect = url.searchParams.get(parameter) ?? '';
  const state = url.searchParams.get('state') ?? '';
  const response = await fetch(`${redirect}?${query(state)}`);
  await response.text();
}

describe('loadOrCreateInstallId', () => {
  const settingsWith = (saved: Map<string, string>) => ({
    getSetting: (key: string) => saved.get(key),
    setSetting: (key: string, value: string) => {
      saved.set(key, value);
    },
  });

  it('creates the install ID once and keeps it after', () => {
    const saved = new Map<string, string>();
    const newId = vi.fn(() => HOST_ID);
    expect(loadOrCreateInstallId(settingsWith(saved), newId)).toBe(HOST_ID);
    expect(loadOrCreateInstallId(settingsWith(saved), newId)).toBe(HOST_ID);
    expect(newId).toHaveBeenCalledTimes(1);
    expect(saved.get(INSTALL_ID_SETTING)).toBe(HOST_ID);
  });

  it('creates a urn:uuid host ID when none is saved, and saves it', () => {
    const saved = new Map<string, string>();
    const created = loadOrCreateInstallId(settingsWith(saved));
    expect(isExtAgentHostId(created)).toBe(true);
    expect(saved.get(INSTALL_ID_SETTING)).toBe(created);
  });

  it('keeps a saved host ID in the form ChatGPT accepts, and creates nothing', () => {
    const saved = new Map<string, string>([[INSTALL_ID_SETTING, HOST_ID]]);
    const newId = vi.fn(() => HOST_ID);
    expect(loadOrCreateInstallId(settingsWith(saved), newId)).toBe(HOST_ID);
    expect(newId).not.toHaveBeenCalled();
  });

  it('replaces a saved bare UUID, which ChatGPT refuses, and saves the replacement', () => {
    const saved = new Map<string, string>([
      [INSTALL_ID_SETTING, '550e8400-e29b-41d4-a716-446655440000'],
    ]);
    expect(loadOrCreateInstallId(settingsWith(saved), () => HOST_ID)).toBe(HOST_ID);
    expect(saved.get(INSTALL_ID_SETTING)).toBe(HOST_ID);
  });

  it('refuses a new ID that is not in the form ChatGPT accepts, and saves nothing', () => {
    const saved = new Map<string, string>();
    expect(() => loadOrCreateInstallId(settingsWith(saved), () => 'install-new')).toThrow(
      /valid ChatGPT host ID/,
    );
    expect(saved.has(INSTALL_ID_SETTING)).toBe(false);
  });
});

describe('createProviderSignIn', () => {
  it('returns the OpenRouter key as a profile to save, on the default model', async () => {
    const signIn = createProviderSignIn({
      openExternal: (url) =>
        returnFromBrowser(url, 'callback_url', (state) => `code=the-code&state=${state}`),
      fetch: async () => json({ key: 'sk-or-v1-test' }),
      now: Date.now,
      chatGptClientId: undefined,
      installId: () => HOST_ID,
    });
    await expect(signIn('openrouter')).resolves.toEqual({
      provider: 'openrouter',
      baseUrl: OPENROUTER_BASE_URL,
      modelId: OPENROUTER_DEFAULT_MODEL,
      secret: 'sk-or-v1-test',
    });
  });

  it('starts a ChatGPT registration when no client is saved, and ends when the person declines', async () => {
    let authUrl = '';
    const openExternal = vi.fn(async (url: string) => {
      authUrl = url;
      // The person declines in the browser, so the flow ends here, and its listener is closed.
      const sent = new URL(url).searchParams;
      await fetch(
        `${sent.get('redirect_uri') ?? ''}?error=access_denied&state=${sent.get('state') ?? ''}`,
      );
    });
    const signIn = createProviderSignIn({
      openExternal,
      fetch: vi.fn(),
      now: Date.now,
      chatGptClientId: undefined,
      installId: () => HOST_ID,
      chatGptPort: 0,
    });
    await expect(signIn('chatgpt')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(new URL(authUrl).searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(new URL(authUrl).searchParams.get('agent_name_hint')).toBe('JOY Media');
  });

  it('signs ChatGPT in and starts the profile on the first model the account lists', async () => {
    let authUrl = '';
    const fetchStub: FetchLike = async (url, init) => {
      if (url === CHATGPT_JWKS_URL) return json({ keys: [JWK] });
      if (url === CHATGPT_TOKEN_URL) {
        const nonce = new URL(authUrl).searchParams.get('nonce') ?? '';
        return json({
          access_token: 'at-1',
          refresh_token: 'rt-1',
          id_token: signedIdToken(nonce),
          expires_in: 3600,
          scope: CHATGPT_SCOPE,
        });
      }
      if (url === `${CHATGPT_RESPONSES_BASE_URL}/models`) {
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer at-1');
        return json({
          models: [
            { slug: 'gpt-first', display_name: 'First', visibility: 'list' },
            { slug: 'gpt-second', visibility: 'list' },
          ],
        });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const signIn = createProviderSignIn({
      openExternal: async (url) => {
        authUrl = url;
        await returnFromBrowser(url, 'redirect_uri', (state) => `code=the-code&state=${state}`);
      },
      fetch: fetchStub,
      now: Date.now,
      chatGptClientId: CLIENT_ID,
      installId: () => HOST_ID,
      chatGptPort: 0,
    });

    const result = await signIn('chatgpt');
    expect(result).toMatchObject({
      provider: 'chatgpt',
      baseUrl: CHATGPT_RESPONSES_BASE_URL,
      modelId: 'gpt-first',
    });
    expect(decodeTokenRecord(result.secret)).toMatchObject({
      accountId: 'acct-1',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
    });
  });

  it('reads a model catalog longer than a token reply, and starts on its first model', async () => {
    let authUrl = '';
    const fetchStub: FetchLike = async (url) => {
      if (url === CHATGPT_JWKS_URL) return json({ keys: [JWK] });
      if (url === CHATGPT_TOKEN_URL) {
        const nonce = new URL(authUrl).searchParams.get('nonce') ?? '';
        return json({
          access_token: 'at-1',
          refresh_token: 'rt-1',
          id_token: signedIdToken(nonce),
          expires_in: 3600,
          scope: CHATGPT_SCOPE,
        });
      }
      // The first entry is longer than a token reply, so the catalog runs past the token bound.
      return json({
        models: [{ slug: 'gpt-first', display_name: 'x'.repeat(200 * 1024), visibility: 'list' }],
      });
    };
    const signIn = createProviderSignIn({
      openExternal: async (url) => {
        authUrl = url;
        await returnFromBrowser(url, 'redirect_uri', (state) => `code=the-code&state=${state}`);
      },
      fetch: fetchStub,
      now: Date.now,
      chatGptClientId: CLIENT_ID,
      installId: () => HOST_ID,
      chatGptPort: 0,
    });
    await expect(signIn('chatgpt')).resolves.toMatchObject({ modelId: 'gpt-first' });
  });

  it('saves nothing when the account lists no model', async () => {
    let authUrl = '';
    const fetchStub: FetchLike = async (url) => {
      if (url === CHATGPT_JWKS_URL) return json({ keys: [JWK] });
      if (url === CHATGPT_TOKEN_URL) {
        const nonce = new URL(authUrl).searchParams.get('nonce') ?? '';
        return json({
          access_token: 'at-1',
          refresh_token: 'rt-1',
          id_token: signedIdToken(nonce),
          expires_in: 3600,
          scope: CHATGPT_SCOPE,
        });
      }
      return json({ models: [{ slug: 'hidden', visibility: 'hide' }] });
    };
    const signIn = createProviderSignIn({
      openExternal: async (url) => {
        authUrl = url;
        await returnFromBrowser(url, 'redirect_uri', (state) => `code=the-code&state=${state}`);
      },
      fetch: fetchStub,
      now: Date.now,
      chatGptClientId: CLIENT_ID,
      installId: () => HOST_ID,
      chatGptPort: 0,
    });
    await expect(signIn('chatgpt')).rejects.toMatchObject({ code: 'EXCHANGE_FAILED' });
  });

  it.each(['at-1', 'rt-1'])(
    'refuses a first model whose id is the token %s, and returns no profile',
    async (token) => {
      let authUrl = '';
      const fetchStub: FetchLike = async (url) => {
        if (url === CHATGPT_JWKS_URL) return json({ keys: [JWK] });
        if (url === CHATGPT_TOKEN_URL) {
          const nonce = new URL(authUrl).searchParams.get('nonce') ?? '';
          return json({
            access_token: 'at-1',
            refresh_token: 'rt-1',
            id_token: signedIdToken(nonce),
            expires_in: 3600,
            scope: CHATGPT_SCOPE,
          });
        }
        return json({ models: [{ slug: token, visibility: 'list' }] });
      };
      const signIn = createProviderSignIn({
        openExternal: async (url) => {
          authUrl = url;
          await returnFromBrowser(url, 'redirect_uri', (state) => `code=the-code&state=${state}`);
        },
        fetch: fetchStub,
        now: Date.now,
        chatGptClientId: CLIENT_ID,
        installId: () => HOST_ID,
        chatGptPort: 0,
      });
      await expect(signIn('chatgpt')).rejects.toMatchObject({
        code: 'EXCHANGE_FAILED',
        message: 'ChatGPT lists no usable model for this account.',
      });
    },
  );

  it.each([{ models: {} }, { models: [{ slug: '   ', visibility: 'list' }] }])(
    'refuses a model list this app cannot read, with its own message, and returns no profile: %j',
    async (listing) => {
      let authUrl = '';
      const fetchStub: FetchLike = async (url) => {
        if (url === CHATGPT_JWKS_URL) return json({ keys: [JWK] });
        if (url === CHATGPT_TOKEN_URL) {
          const nonce = new URL(authUrl).searchParams.get('nonce') ?? '';
          return json({
            access_token: 'at-1',
            refresh_token: 'rt-1',
            id_token: signedIdToken(nonce),
            expires_in: 3600,
            scope: CHATGPT_SCOPE,
          });
        }
        return json(listing);
      };
      const signIn = createProviderSignIn({
        openExternal: async (url) => {
          authUrl = url;
          await returnFromBrowser(url, 'redirect_uri', (state) => `code=the-code&state=${state}`);
        },
        fetch: fetchStub,
        now: Date.now,
        chatGptClientId: CLIENT_ID,
        installId: () => HOST_ID,
        chatGptPort: 0,
      });
      await expect(signIn('chatgpt')).rejects.toMatchObject({
        code: 'EXCHANGE_FAILED',
        message: 'ChatGPT returned a model list this app cannot read.',
      });
    },
  );
});
