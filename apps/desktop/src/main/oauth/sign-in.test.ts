import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHATGPT_RESPONSES_BASE_URL } from '../providers/adapters/chatgpt-responses.js';
import {
  CHATGPT_ISSUER,
  CHATGPT_JWKS_URL,
  CHATGPT_SCOPE,
  CHATGPT_TOKEN_URL,
  decodeTokenRecord,
  isExtAgentHostId,
} from './chatgpt.js';
import { decodeKimiTokenRecord, KIMI_CODE_BASE_URL } from './kimi.js';
import type { FetchLike } from './http.js';
import {
  createProviderSignIn,
  firstKimiCodeModel,
  firstXaiModel,
  INSTALL_ID_SETTING,
  loadOrCreateInstallId,
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
  parameter: 'redirect_uri',
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses OpenRouter, which is set up with an API key under D20, and never opens a browser', async () => {
    const openExternal = vi.fn();
    const fetchStub = vi.fn();
    const signIn = createProviderSignIn({
      openExternal,
      fetch: fetchStub,
      now: Date.now,
      chatGptClientId: undefined,
      installId: () => HOST_ID,
    });
    await expect(signIn('openrouter')).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      message: 'OpenRouter is set up with an API key and does not offer a sign-in.',
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('refuses MiniMax OAuth after D23 without making a token request', async () => {
    const openExternal = vi.fn();
    const fetch = vi.fn<FetchLike>();
    const signIn = createProviderSignIn({
      openExternal,
      fetch,
      now: Date.now,
      chatGptClientId: undefined,
      installId: () => HOST_ID,
    });

    await expect(signIn('minimax')).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      message: 'MiniMax is set up with an API key and does not offer a sign-in.',
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('signs in to Kimi Code and starts the profile on its first listed model', async () => {
    const now = Date.UTC(2026, 9, 30);
    let openedUrl = '';
    let releaseOpen: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    const fetch: FetchLike = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/api/oauth/device_authorization')) {
        return json({
          user_code: 'KIMI-USER-CODE',
          device_code: 'private-device-code',
          verification_uri_complete:
            'https://www.kimi.ai/code/authorize_device?user_code=KIMI-USER-CODE',
          expires_in: 120,
          interval: 1,
        });
      }
      if (url.endsWith('/api/oauth/token')) {
        const body = new URLSearchParams(String(init.body));
        expect(body.get('device_code')).toBe('private-device-code');
        return json({
          access_token: 'kimi-access-token',
          refresh_token: 'kimi-refresh-token',
          expires_in: 3600,
          scope: 'kimi-code',
          token_type: 'Bearer',
        });
      }
      if (url === `${KIMI_CODE_BASE_URL}/models`) {
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer kimi-access-token');
        return json({ data: [{ id: 'kimi-code-model' }, { id: 'kimi-code-model-2' }] });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const signIn = createProviderSignIn({
      openExternal: (url) => {
        openedUrl = url;
        releaseOpen();
      },
      fetch,
      now: () => now,
      chatGptClientId: undefined,
      installId: () => HOST_ID,
    });
    const pending = signIn('kimi');
    void pending.catch(releaseOpen);

    await opened;
    const result = await pending;

    expect(openedUrl).toBe('https://www.kimi.ai/code/authorize_device?user_code=KIMI-USER-CODE');
    expect(result).toMatchObject({
      provider: 'kimi',
      baseUrl: KIMI_CODE_BASE_URL,
      modelId: 'kimi-code-model',
    });
    expect(decodeKimiTokenRecord(result.secret)).toMatchObject({
      accessToken: 'kimi-access-token',
      refreshToken: 'kimi-refresh-token',
      scope: 'kimi-code',
    });
    expect(requests.map((request) => request.url)).toEqual([
      'https://auth.kimi.ai/api/oauth/device_authorization',
      'https://auth.kimi.ai/api/oauth/token',
      `${KIMI_CODE_BASE_URL}/models`,
    ]);
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

  it('gives up on a ChatGPT sign-in whose model list never answers, after 30 seconds', async () => {
    let authUrl = '';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
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
          // The clock runs 30 seconds while the list stays silent, as a stalled connection does.
          await vi.advanceTimersByTimeAsync(30_000);
          if (init.signal?.aborted)
            throw new DOMException('The request was aborted.', 'AbortError');
          return json({ models: [{ slug: 'gpt-late', visibility: 'list' }] });
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

      await expect(signIn('chatgpt')).rejects.toMatchObject({ code: 'EXCHANGE_FAILED' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reauthorizes a saved ChatGPT account with its client ID instead of registering another client', async () => {
    let authUrl = '';
    const fetch: FetchLike = async (url, init) => {
      if (url === CHATGPT_JWKS_URL) return json({ keys: [JWK] });
      if (url === CHATGPT_TOKEN_URL) {
        const nonce = new URL(authUrl).searchParams.get('nonce') ?? '';
        const form = new URLSearchParams(String(init.body));
        expect(form.get('client_id')).toBe(CLIENT_ID);
        return json({
          access_token: 'at-reauthorized',
          refresh_token: 'rt-reauthorized',
          id_token: signedIdToken(nonce),
          expires_in: 3600,
          scope: CHATGPT_SCOPE,
        });
      }
      if (url === `${CHATGPT_RESPONSES_BASE_URL}/models`) {
        return json({ models: [{ slug: 'gpt-reauthorized', visibility: 'list' }] });
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const signIn = createProviderSignIn({
      openExternal: async (url) => {
        authUrl = url;
        await returnFromBrowser(
          url,
          'redirect_uri',
          (state) => `code=reauthorize-code&state=${state}`,
        );
      },
      fetch,
      now: Date.now,
      chatGptClientId: undefined,
      installId: () => HOST_ID,
      chatGptPort: 0,
    });

    const result = await signIn('chatgpt', {
      savedChatGptAccount: { clientId: CLIENT_ID, accountId: 'acct-1' },
    });

    expect(new URL(authUrl).searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(result.modelId).toBe('gpt-reauthorized');
    expect(decodeTokenRecord(result.secret)).toMatchObject({
      clientId: CLIENT_ID,
      accountId: 'acct-1',
      refreshToken: 'rt-reauthorized',
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

/** A list send that answers only once its signal is aborted, as a stalled connection does. */
function stalledSend(models: unknown): (url: string, init: RequestInit) => Promise<Response> {
  return (_url, init) => {
    // Without a signal the list answers at once, so a list with no bound fails these tests instead of hanging.
    if (init.signal === undefined) return Promise.resolve(json(models));
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('The request was aborted.', 'AbortError')),
        { once: true },
      );
    });
  };
}

/** A list whose headers arrive at once and whose body stalls until the signal is aborted. */
function stalledBody(): (url: string, init: RequestInit) => Promise<Response> {
  return (_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const fail = (): void =>
          controller.error(new DOMException('The request was aborted.', 'AbortError'));
        if (init.signal?.aborted) fail();
        else init.signal?.addEventListener('abort', fail, { once: true });
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };
}

const MODEL_LISTS = [
  {
    name: 'xAI',
    list: firstXaiModel as (record: never, fetch: FetchLike) => Promise<string>,
    record: { accessToken: 'xai-access', refreshToken: 'xai-refresh' },
    reply: { data: [{ id: 'grok-first' }] },
    modelId: 'grok-first',
    failure: 'xAI lists no usable model for this account.',
  },
  {
    name: 'Kimi Code',
    list: firstKimiCodeModel as (record: never, fetch: FetchLike) => Promise<string>,
    record: { accessToken: 'kimi-access', refreshToken: 'kimi-refresh' },
    reply: { data: [{ id: 'kimi-code-model' }] },
    modelId: 'kimi-code-model',
    failure: 'Kimi lists no usable model for this account.',
  },
] as const;

describe('bounded provider model lists', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(MODEL_LISTS)(
    '$name: gives up on a list that never answers, after 30 seconds',
    async ({ list, record, reply, failure }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const outcome = list(record as never, stalledSend(reply)).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(outcome).resolves.toMatchObject({ code: 'EXCHANGE_FAILED', message: failure });
    },
  );

  it.each(MODEL_LISTS)(
    '$name: gives up on a list whose body never finishes, after 30 seconds',
    async ({ list, record, failure }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const outcome = list(record as never, stalledBody()).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(outcome).resolves.toMatchObject({ code: 'EXCHANGE_FAILED', message: failure });
    },
  );

  it.each(MODEL_LISTS)(
    '$name: refuses a list the provider does not accept, with its own message',
    async ({ list, record, failure }) => {
      const refused = async (): Promise<Response> => json({ error: 'nope' }, 403);
      await expect(list(record as never, refused)).rejects.toMatchObject({
        code: 'EXCHANGE_FAILED',
        message: failure,
      });
    },
  );

  it.each(MODEL_LISTS)(
    '$name: reads the first model, and clears its timer once the list arrives',
    async ({ list, record, reply, modelId }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let sendSignal: AbortSignal | undefined;
      const answered = async (_url: string, init: RequestInit): Promise<Response> => {
        sendSignal = init.signal ?? undefined;
        return json(reply);
      };
      await expect(list(record as never, answered)).resolves.toBe(modelId);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sendSignal).toBeDefined();
      expect(sendSignal?.aborted).toBe(false);
    },
  );

  it.each(MODEL_LISTS)(
    '$name: refuses a list larger than the catalog limit, with its own message',
    async ({ list, record, failure }) => {
      const oversized = async (): Promise<Response> =>
        new Response('x'.repeat(4 * 1024 * 1024 + 1), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      await expect(list(record as never, oversized)).rejects.toMatchObject({
        code: 'EXCHANGE_FAILED',
        message: failure,
      });
    },
  );
});

describe('ChatGPT model list branches', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Signs ChatGPT in with the given model-list reply, after a token exchange that succeeds. */
  function chatGptSignIn(list: (url: string, init: RequestInit) => Promise<Response>) {
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
      if (url === `${CHATGPT_RESPONSES_BASE_URL}/models`) return list(url, init);
      throw new Error(`unexpected request to ${url}`);
    };
    return createProviderSignIn({
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
  }

  it('gives up on a ChatGPT list whose body never finishes, after 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The list request starts its timer before it sends, so once it is reached the clock can run against it.
    let listReached: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      listReached = resolve;
    });
    const stalled = stalledBody();
    const signIn = chatGptSignIn(async (url, init) => {
      listReached();
      return stalled(url, init);
    });
    const outcome = signIn('chatgpt').catch((error: unknown) => error);
    await reached;
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(outcome).resolves.toMatchObject({
      code: 'EXCHANGE_FAILED',
      message: 'ChatGPT could not be reached.',
    });
  });

  it('refuses a ChatGPT list the provider does not accept, with its HTTP status', async () => {
    const refused = async (): Promise<Response> => json({ error: 'nope' }, 403);
    await expect(chatGptSignIn(refused)('chatgpt')).rejects.toMatchObject({
      code: 'EXCHANGE_FAILED',
      message: 'ChatGPT did not list models (HTTP 403).',
    });
  });

  it('refuses a ChatGPT list larger than the catalog limit, and returns no profile', async () => {
    const oversized = async (): Promise<Response> =>
      new Response('x'.repeat(4 * 1024 * 1024 + 1), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(chatGptSignIn(oversized)('chatgpt')).rejects.toMatchObject({
      code: 'EXCHANGE_FAILED',
      message: 'The provider reply was too large.',
    });
  });
});
