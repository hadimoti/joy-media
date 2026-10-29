import { describe, expect, it } from 'vitest';
import type { SecretStore } from '@joy-media/provider-sdk';
import {
  CHATGPT_TOKEN_URL,
  decodeTokenRecord,
  encodeTokenRecord,
  type ChatGptTokenRecord,
} from '../oauth/chatgpt.js';
import { CHATGPT_RESPONSES_BASE_URL } from './adapters/chatgpt-responses.js';
import {
  createProviderBroker,
  endpointBindingDigest,
  type BrokerProfile,
  type ProviderFetch,
} from './provider-broker.js';

const NOW = 1_800_000_000_000;
const PROFILE_ID = 'chatgpt-1';
const HANDLE = 'handle-chatgpt-1';
const NEW_HANDLE = 'handle-chatgpt-2';
const RESPONSES_URL = `${CHATGPT_RESPONSES_BASE_URL}/responses`;
const MODELS_URL = `${CHATGPT_RESPONSES_BASE_URL}/models`;
const CHAT = { messages: [{ role: 'user', content: 'hi' }] };

/** The model list the account lists by default: the saved model is among them. */
const LISTED = [{ slug: 'gpt-first', visibility: 'list' }];

function recordFor(expiresInMs: number): ChatGptTokenRecord {
  return {
    version: 1,
    clientId: 'client-1',
    accountId: 'acct-1',
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    accessExpiresAt: NOW + expiresInMs,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A Responses stream: one event per object, each named by its type. */
function sse(...events: Record<string, unknown>[]): Response {
  const text = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function completedWith(text: string): Response {
  return sse(
    { type: 'response.output_text.delta', delta: text },
    {
      type: 'response.completed',
      response: {
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      },
    },
  );
}

/**
 * A broker over one ChatGPT profile. The record is stored under one handle, and each write to it changes the version
 * the binding is checked against, as the real store does. The model list is answered from `models`, unless the test
 * replies to it itself.
 */
function harness(
  initial: ChatGptTokenRecord | 'unreadable',
  reply: (url: string, init: RequestInit) => Response | Promise<Response>,
  models: readonly unknown[] = LISTED,
) {
  const values = new Map<string, string>();
  const versions = new Map<string, number>();
  const sent: { url: string; init: RequestInit }[] = [];
  const unavailable: string[] = [];
  let failWrites = false;
  let currentModels: readonly unknown[] = models;
  let nextWriteHook: (() => void) | undefined;

  values.set(HANDLE, initial === 'unreadable' ? 'not a token record' : encodeTokenRecord(initial));
  versions.set(HANDLE, 1);
  let profile: BrokerProfile = {
    id: PROFILE_ID,
    provider: 'chatgpt',
    baseUrl: CHATGPT_RESPONSES_BASE_URL,
    modelId: 'gpt-first',
    secretHandleId: HANDLE,
    bindingDigest: endpointBindingDigest(PROFILE_ID, 'https://api.openai.com', '/v1'),
    bindingSecretDigest: 'v1',
  };

  const secrets: SecretStore = {
    async set(handleId, value) {
      if (failWrites) throw new Error('disk full');
      values.set(handleId, value);
      versions.set(handleId, (versions.get(handleId) ?? 0) + 1);
      // The hook runs after the write, as a later sign-in could while the broker awaits the write's settlement.
      const hook = nextWriteHook;
      nextWriteHook = undefined;
      hook?.();
    },
    async get(handleId) {
      return values.get(handleId) ?? null;
    },
    async delete(handleId) {
      values.delete(handleId);
    },
    redact(logLine) {
      return logLine;
    },
  };
  const fetch: ProviderFetch = async (url, init) => {
    sent.push({ url, init });
    if (url === MODELS_URL) return json({ models: currentModels });
    return reply(url, init);
  };
  const broker = createProviderBroker({
    store: {
      getProfile: (id) => (id === PROFILE_ID ? profile : undefined),
      isDisabledLegacy: () => false,
      markCredentialUnavailable: (id) => {
        unavailable.push(id);
      },
      secretVersion: (handleId) => `v${versions.get(handleId) ?? 0}`,
      rebindSecretVersion: (id, version) => {
        if (id === PROFILE_ID) profile = { ...profile, bindingSecretDigest: version };
      },
    },
    secrets,
    fetch,
    now: () => NOW,
  });
  return {
    broker,
    sent,
    unavailable,
    profile: () => profile,
    stored: (handleId: string) => values.get(handleId),
    failWrites: (on: boolean) => {
      failWrites = on;
    },
    /** Runs `hook` right after the next secret write. */
    onNextWrite: (hook: () => void) => {
      nextWriteHook = hook;
    },
    /** The model list the account now lists, as the server answers it. */
    setModels: (list: readonly unknown[]) => {
      currentModels = list;
    },
    /** A later sign-in: it stores its record under a new handle and points the profile at it, as the save route does. */
    replaceSignIn: (record: ChatGptTokenRecord) => {
      values.set(NEW_HANDLE, encodeTokenRecord(record));
      versions.set(NEW_HANDLE, 1);
      profile = { ...profile, secretHandleId: NEW_HANDLE, bindingSecretDigest: 'v1' };
    },
  };
}

function authorizationOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('authorization');
}

describe('provider broker: other providers keep their own failures', () => {
  it('does not read a usage-limit code in a failed status as a ChatGPT plan limit', async () => {
    const profile: BrokerProfile = {
      id: 'or-1',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openai/gpt-x',
      secretHandleId: 'handle-or',
      bindingDigest: endpointBindingDigest('or-1', 'https://openrouter.ai', '/api/v1'),
      bindingSecretDigest: 'v1',
    };
    const values = new Map([['handle-or', 'sk-or-v1-test-key']]);
    const broker = createProviderBroker({
      store: {
        getProfile: (id) => (id === profile.id ? profile : undefined),
        isDisabledLegacy: () => false,
        markCredentialUnavailable: () => undefined,
        secretVersion: () => 'v1',
      },
      secrets: {
        set: async () => undefined,
        get: async (handleId) => values.get(handleId) ?? null,
        delete: async () => undefined,
        redact: (logLine) => logLine,
      },
      fetch: async () =>
        json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, 429),
      resolveHost: async () => [],
      now: () => NOW,
    });
    const result = await broker.complete({ profileId: profile.id, body: CHAT });
    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_HTTP_ERROR' });
  });
});

describe('provider broker: ChatGPT sign-in', () => {
  it('sends a fresh token as the bearer and returns the completed reply as chat JSON', async () => {
    const h = harness(recordFor(60 * 60_000), (url) =>
      url === RESPONSES_URL ? completedWith('Hello') : json({}),
    );
    const result = await h.broker.complete({ profileId: PROFILE_ID, body: CHAT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.data.text).choices[0].message.content).toBe('Hello');
    expect(h.sent.map((request) => request.url)).toEqual([MODELS_URL, RESPONSES_URL]);
    expect(authorizationOf(h.sent[1]?.init)).toBe('Bearer access-old');
  });

  it('refreshes just before a request, writes the record once, and keeps the binding', async () => {
    const h = harness(recordFor(-1), (url) =>
      url === CHATGPT_TOKEN_URL
        ? json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 })
        : completedWith('Hi'),
    );
    const first = await h.broker.complete({ profileId: PROFILE_ID, body: CHAT });
    expect(first.ok).toBe(true);
    expect(h.sent.map((request) => request.url)).toEqual([
      CHATGPT_TOKEN_URL,
      MODELS_URL,
      RESPONSES_URL,
    ]);
    expect(authorizationOf(h.sent[2]?.init)).toBe('Bearer access-new');
    expect(decodeTokenRecord(h.stored(HANDLE) ?? '')).toMatchObject({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
    });
    expect(h.profile().bindingSecretDigest).toBe('v2');

    // The binding follows the write, so the next request is not refused as a changed key. The model list is cached.
    const second = await h.broker.complete({ profileId: PROFILE_ID, body: CHAT });
    expect(second.ok).toBe(true);
    expect(h.sent.map((request) => request.url)).toEqual([
      CHATGPT_TOKEN_URL,
      MODELS_URL,
      RESPONSES_URL,
      RESPONSES_URL,
    ]);
  });

  it('asks for a new sign-in when the grant is invalid, and sends no request', async () => {
    const h = harness(recordFor(-1), (url) =>
      url === CHATGPT_TOKEN_URL ? json({ error: 'invalid_grant' }, 400) : completedWith('x'),
    );
    const result = await h.broker.complete({ profileId: PROFILE_ID, body: CHAT });
    expect(result).toMatchObject({ ok: false, code: 'SIGN_IN_REQUIRED' });
    expect(h.unavailable).toEqual([PROFILE_ID]);
    expect(h.sent.map((request) => request.url)).toEqual([CHATGPT_TOKEN_URL]);
  });

  it('asks for a new sign-in when the refreshed record cannot be saved, and keeps the old binding', async () => {
    const h = harness(recordFor(-1), (url) =>
      url === CHATGPT_TOKEN_URL
        ? json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 })
        : completedWith('x'),
    );
    h.failWrites(true);
    const result = await h.broker.complete({ profileId: PROFILE_ID, body: CHAT });
    expect(result).toMatchObject({ ok: false, code: 'SIGN_IN_REQUIRED' });
    expect(h.unavailable).toEqual([PROFILE_ID]);
    expect(h.profile().bindingSecretDigest).toBe('v1');
    expect(decodeTokenRecord(h.stored(HANDLE) ?? '')).toMatchObject({
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
    });
    expect(h.sent.map((request) => request.url)).toEqual([CHATGPT_TOKEN_URL]);
  });

  it('drops a refreshed record when a later sign-in replaced the key during the refresh', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let tokenRequested: () => void = () => undefined;
    const requested = new Promise<void>((resolve) => {
      tokenRequested = resolve;
    });
    const h = harness(recordFor(-1), async (url) => {
      if (url === CHATGPT_TOKEN_URL) {
        tokenRequested();
        await gate;
        return json({
          access_token: 'access-refreshed',
          refresh_token: 'refresh-refreshed',
          expires_in: 3600,
        });
      }
      return completedWith('x');
    });

    const pending = h.broker.complete({ profileId: PROFILE_ID, body: CHAT });
    await requested;
    h.replaceSignIn({
      ...recordFor(60 * 60_000),
      accessToken: 'access-signed-in',
      refreshToken: 'refresh-signed-in',
    });
    release();

    expect(await pending).toMatchObject({ ok: false, code: 'CREDENTIAL_UNAVAILABLE' });
    expect(decodeTokenRecord(h.stored(NEW_HANDLE) ?? '')).toMatchObject({
      accessToken: 'access-signed-in',
      refreshToken: 'refresh-signed-in',
    });
  });

  it('refuses an incomplete stream and an interrupted one as their own failures', async () => {
    const incomplete = harness(recordFor(60 * 60_000), () =>
      sse(
        { type: 'response.output_text.delta', delta: 'Hel' },
        {
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'max_output_tokens' } },
        },
      ),
    );
    expect(await incomplete.broker.complete({ profileId: PROFILE_ID, body: CHAT })).toMatchObject({
      ok: false,
      code: 'RESPONSE_INCOMPLETE',
    });

    const interrupted = harness(recordFor(60 * 60_000), () =>
      sse({ type: 'response.output_text.delta', delta: 'Hel' }),
    );
    expect(await interrupted.broker.complete({ profileId: PROFILE_ID, body: CHAT })).toMatchObject({
      ok: false,
      code: 'RESPONSE_INTERRUPTED',
    });
  });

  it('refuses a usage limit that arrives mid-stream, and never returns its partial text', async () => {
    const h = harness(recordFor(60 * 60_000), () =>
      sse(
        { type: 'response.output_text.delta', delta: 'Partial' },
        {
          type: 'response.failed',
          response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
        },
      ),
    );
    const result = await h.broker.complete({ profileId: PROFILE_ID, body: CHAT });
    expect(result).toMatchObject({ ok: false, code: 'PLAN_LIMIT_REACHED' });
    expect(JSON.stringify(result)).not.toContain('Partial');
  });

  it('reads a usage limit named in a failed status, and keeps no part of the body', async () => {
    const h = harness(recordFor(60 * 60_000), () =>
      json(
        { error: { code: 'subscription_sharing_usage_unavailable', message: 'secret detail' } },
        429,
      ),
    );
    const result = await h.broker.complete({ profileId: PROFILE_ID, body: CHAT });
    expect(result).toMatchObject({ ok: false, code: 'PLAN_LIMIT_REACHED' });
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });

  it('refuses a saved model the account no longer lists, before sending a request', async () => {
    const h = harness(recordFor(60 * 60_000), () => completedWith('x'), [
      { slug: 'gpt-other', visibility: 'list' },
    ]);
    const result = await h.broker.complete({ profileId: PROFILE_ID, body: CHAT });
    expect(result).toMatchObject({ ok: false, code: 'MODEL_CHOICE_REQUIRED' });
    expect(h.sent.map((request) => request.url)).toEqual([MODELS_URL]);
  });

  it('refuses a reply that carries the access token', async () => {
    const h = harness(recordFor(60 * 60_000), () => completedWith('leak access-old here'));
    const result = await h.broker.complete({ profileId: PROFILE_ID, body: CHAT });
    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_INCOMPATIBLE' });
    expect(JSON.stringify(result)).not.toContain('access-old');
  });

  it('refuses a reply that carries the refresh token', async () => {
    const h = harness(recordFor(60 * 60_000), () => completedWith('leak refresh-old here'));
    const result = await h.broker.complete({ profileId: PROFILE_ID, body: CHAT });
    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_INCOMPATIBLE' });
    expect(JSON.stringify(result)).not.toContain('refresh-old');
  });

  it('refuses a top-level programmatic_tool_calling field before refreshing or sending anything', async () => {
    const h = harness(recordFor(-1), () => completedWith('x'));
    const result = await h.broker.complete({
      profileId: PROFILE_ID,
      body: { ...CHAT, programmatic_tool_calling: true },
    });
    expect(result).toMatchObject({ ok: false, code: 'REQUEST_INVALID' });
    expect(h.sent).toHaveLength(0);
  });

  it('does not rebind the profile when a later sign-in took it while the refreshed record was written', async () => {
    const h = harness(recordFor(-1), (url) =>
      url === CHATGPT_TOKEN_URL
        ? json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 })
        : completedWith('x'),
    );
    h.onNextWrite(() =>
      h.replaceSignIn({
        ...recordFor(60 * 60_000),
        accessToken: 'access-signed-in',
        refreshToken: 'refresh-signed-in',
      }),
    );

    const result = await h.broker.complete({ profileId: PROFILE_ID, body: CHAT });
    expect(result).toMatchObject({ ok: false, code: 'CREDENTIAL_UNAVAILABLE' });
    expect(h.profile()).toMatchObject({ secretHandleId: NEW_HANDLE, bindingSecretDigest: 'v1' });
    expect(h.sent.map((request) => request.url)).toEqual([CHATGPT_TOKEN_URL]);
  });

  it('refuses a redirect whose target carries the refresh token, and names no target', async () => {
    const h = harness(
      recordFor(60 * 60_000),
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://redirect.example/path/refresh-old' },
        }),
    );
    const result = await h.broker.complete({ profileId: PROFILE_ID, body: CHAT });
    expect(result).toMatchObject({ ok: false, code: 'REDIRECT_REFUSED' });
    expect(JSON.stringify(result)).not.toContain('refresh-old');
  });

  it('reloads the model list when the person reloads it, so a removed model is refused', async () => {
    const h = harness(recordFor(60 * 60_000), () => completedWith('x'));
    expect((await h.broker.complete({ profileId: PROFILE_ID, body: CHAT })).ok).toBe(true);

    h.setModels([{ slug: 'gpt-other', visibility: 'list' }]);
    // Within its time-to-live, the list held before the reload still stands.
    expect((await h.broker.complete({ profileId: PROFILE_ID, body: CHAT })).ok).toBe(true);

    expect(await h.broker.listModels({ profileId: PROFILE_ID })).toMatchObject({ ok: true });
    expect(await h.broker.complete({ profileId: PROFILE_ID, body: CHAT })).toMatchObject({
      ok: false,
      code: 'MODEL_CHOICE_REQUIRED',
    });
    // A model the reloaded list names is accepted.
    expect(
      (await h.broker.complete({ profileId: PROFILE_ID, body: CHAT, modelId: 'gpt-other' })).ok,
    ).toBe(true);
  });

  it('lists the visible models of a signed-in profile, and refuses a draft', async () => {
    const h = harness(recordFor(60 * 60_000), () => json({}), [
      { slug: 'gpt-b', visibility: 'list' },
      { slug: 'hidden', visibility: 'hide' },
    ]);
    expect(await h.broker.listModels({ profileId: PROFILE_ID })).toEqual({
      ok: true,
      data: [{ id: 'gpt-b', name: 'gpt-b' }],
    });
    expect(
      await h.broker.listModels({
        draft: { provider: 'chatgpt', baseUrl: CHATGPT_RESPONSES_BASE_URL, apiKey: 'x' },
      }),
    ).toMatchObject({ ok: false, code: 'REQUEST_INVALID' });
  });
});
