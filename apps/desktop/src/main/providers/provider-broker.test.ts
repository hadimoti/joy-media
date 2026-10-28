import { describe, expect, it } from 'vitest';
import { createMemorySecretStore } from '@joy-media/provider-sdk';
import {
  createProviderBroker,
  endpointBindingDigest,
  MAX_AGENT_REQUEST_BYTES,
  MAX_WORKER_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  type BrokerProfile,
  type ProviderFetch,
} from './provider-broker.js';

const KEY = 'sk-test-0123456789abcdef';

function bound(id: string, provider: string, baseUrl: string, modelId = 'model-x'): BrokerProfile {
  const url = new URL(baseUrl);
  return {
    id,
    provider,
    baseUrl,
    modelId,
    secretHandleId: `handle-${id}`,
    bindingDigest: endpointBindingDigest(id, url.origin, url.pathname.replace(/\/+$/, '')),
    bindingSecretDigest: `v-handle-${id}`,
  };
}

function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function harness(
  options: {
    profiles?: readonly BrokerProfile[];
    disabled?: readonly string[];
    reply?: (url: string, init: RequestInit) => Response | Promise<Response>;
    keys?: Record<string, string>;
    resolveHost?: (host: string) => Promise<readonly string[]>;
    timeoutMs?: { complete?: number; control?: number };
  } = {},
) {
  const sent: { url: string; init: RequestInit }[] = [];
  const unavailable: string[] = [];
  const secrets = createMemorySecretStore();
  for (const [handle, value] of Object.entries(options.keys ?? {})) {
    void secrets.set(handle, value);
  }
  const profiles = options.profiles ?? [];
  const fetch: ProviderFetch = async (url, init) => {
    sent.push({ url, init });
    return options.reply === undefined ? jsonReply({ choices: [] }) : options.reply(url, init);
  };
  const broker = createProviderBroker({
    store: {
      getProfile: (id) => profiles.find((p) => p.id === id),
      isDisabledLegacy: (id) => (options.disabled ?? []).includes(id),
      markCredentialUnavailable: (id) => unavailable.push(id),
      secretVersion: (handleId) => `v-${handleId}`,
    },
    secrets,
    fetch,
    resolveHost:
      options.resolveHost ?? (async (host) => (host === 'localhost' ? ['127.0.0.1'] : [])),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { broker, sent, unavailable };
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

const CHAT_BODY = { messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 };

describe('provider broker: profile checks', () => {
  it('sends a chat request to the registry origin with the key, X-Title and the stored model', async () => {
    const p = bound('p1', 'openrouter', 'https://openrouter.ai/api/v1', 'openai/gpt-4o-mini');
    const { broker, sent } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () => jsonReply({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(headerOf(sent[0]!.init, 'authorization')).toBe(`Bearer ${KEY}`);
    expect(headerOf(sent[0]!.init, 'x-title')).toBe('JOY Media');
    expect(headerOf(sent[0]!.init, 'http-referer')).toBeNull();
    expect(sent[0]?.init.redirect).toBe('manual');
    const body = JSON.parse(String(sent[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'openai/gpt-4o-mini', stream: false, temperature: 0.2 });
  });

  it('drops every field the caller is not allowed to choose', async () => {
    const p = bound('p1', 'openai', 'https://api.openai.com/v1', 'gpt-4o-mini');
    const { broker, sent } = harness({ profiles: [p], keys: { [p.secretHandleId]: KEY } });

    await broker.complete({
      profileId: 'p1',
      body: {
        ...CHAT_BODY,
        model: 'attacker-model',
        stream: true,
        url: 'https://evil.example',
        headers: { authorization: 'x' },
        profileId: 'other',
      },
    });

    const body = JSON.parse(String(sent[0]?.init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['messages', 'model', 'stream', 'temperature']);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.stream).toBe(false);
  });

  it('refuses a profile whose saved key is not bound to its current endpoint', async () => {
    const good = bound('p1', 'openrouter', 'https://openrouter.ai/api/v1');
    const moved = {
      ...good,
      bindingDigest: endpointBindingDigest('p1', 'https://openrouter.ai', '/v9'),
    };
    const { broker, sent } = harness({ profiles: [moved], keys: { [good.secretHandleId]: KEY } });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result).toMatchObject({ ok: false, code: 'BINDING_MISMATCH' });
    expect(sent).toHaveLength(0);
  });

  it('refuses a profile that was never bound, so an old row must be saved again', async () => {
    const legacy: BrokerProfile = { ...bound('p1', 'openrouter', 'https://openrouter.ai/api/v1') };
    const { bindingDigest: _omit, ...unbound } = legacy;
    const { broker } = harness({ profiles: [unbound], keys: { [legacy.secretHandleId]: KEY } });

    expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'BINDING_MISMATCH',
    });
  });

  it('refuses a disabled legacy profile and an unknown profile before any request', async () => {
    const p = bound('p1', 'kilo', 'https://api.kilo.ai/api/gateway');
    const { broker, sent } = harness({ profiles: [p], disabled: ['p1'] });

    expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'PROFILE_DISABLED',
    });
    expect(await broker.complete({ profileId: 'missing', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'PROFILE_NOT_FOUND',
    });
    expect(sent).toHaveLength(0);
  });

  it('marks the profile when its key cannot be read, and never deletes it', async () => {
    const p = bound('p1', 'openrouter', 'https://openrouter.ai/api/v1');
    const { broker, sent, unavailable } = harness({ profiles: [p] });
    const throwing = createProviderBroker({
      store: {
        getProfile: () => p,
        isDisabledLegacy: () => false,
        markCredentialUnavailable: (id) => unavailable.push(id),
        secretVersion: (handleId) => `v-${handleId}`,
      },
      secrets: {
        set: async () => undefined,
        delete: async () => undefined,
        get: async () => {
          throw new Error('DPAPI failure');
        },
        redact: (line: string) => line,
      },
      fetch: async (url, init) => {
        sent.push({ url, init });
        return jsonReply({});
      },
    });

    const result = await throwing.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result).toMatchObject({ ok: false, code: 'CREDENTIAL_UNAVAILABLE' });
    expect(unavailable).toEqual(['p1']);
    expect(sent).toHaveLength(0);
  });

  it('refuses a registry profile whose key is missing', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker, sent } = harness({ profiles: [p] });

    expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'CREDENTIAL_UNAVAILABLE',
    });
    expect(sent).toHaveLength(0);
  });
});

describe('provider broker: replies never carry a credential', () => {
  it('refuses a provider reply that echoes the key, and returns no part of it', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () => jsonReply({ choices: [{ message: { content: `your key is ${KEY}` } }] }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_INCOMPATIBLE' });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe('provider broker: the URL the user saw', () => {
  it('refuses a call whose base URL differs from the saved profile, with no request', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker, sent } = harness({ profiles: [p], keys: { [p.secretHandleId]: KEY } });

    expect(
      await broker.complete({ profileId: 'p1', body: CHAT_BODY, baseUrl: 'https://api.x.ai/v2' }),
    ).toMatchObject({ ok: false, code: 'ENDPOINT_REFUSED' });
    expect(sent).toHaveLength(0);
    expect(
      (await broker.complete({ profileId: 'p1', body: CHAT_BODY, baseUrl: 'https://api.x.ai/v1/' }))
        .ok,
    ).toBe(true);
  });
});

describe('provider broker: the session model', () => {
  it('uses the model the session chose, and refuses an unsafe model id', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1', 'grok-3');
    const { broker, sent } = harness({ profiles: [p], keys: { [p.secretHandleId]: KEY } });

    expect(
      (await broker.complete({ profileId: 'p1', body: CHAT_BODY, modelId: 'grok-4' })).ok,
    ).toBe(true);
    expect(JSON.parse(String(sent[0]?.init.body))).toMatchObject({ model: 'grok-4' });

    expect(
      await broker.complete({ profileId: 'p1', body: CHAT_BODY, modelId: 'grok 4\n' }),
    ).toMatchObject({ ok: false, code: 'REQUEST_INVALID' });
    expect(sent).toHaveLength(1);
  });
});

describe('provider broker: local models (D8)', () => {
  it('sends a loopback custom request with no authorization header when no key is stored', async () => {
    const p = bound('p1', 'openai-compatible', 'http://127.0.0.1:1234/v1', 'local-model');
    const { broker, sent } = harness({ profiles: [p] });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result.ok).toBe(true);
    expect(sent[0]?.url).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(headerOf(sent[0]!.init, 'authorization')).toBeNull();
  });

  it('accepts localhost only when every address it resolves to is this computer', async () => {
    const p = bound('p1', 'openai-compatible', 'http://localhost:11434/v1', 'llama3');
    const { broker, sent } = harness({
      profiles: [p],
      resolveHost: async () => ['::1', '127.0.0.1'],
    });
    expect((await broker.complete({ profileId: 'p1', body: CHAT_BODY })).ok).toBe(true);

    const hostile = harness({
      profiles: [p],
      resolveHost: async () => ['203.0.113.7'],
    });
    expect(await hostile.broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'ENDPOINT_REFUSED',
    });
    expect(hostile.sent).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it('refuses IPv6 loopback even when the profile is bound to it', async () => {
    const url = 'http://[::1]:11434/v1';
    const p: BrokerProfile = {
      ...bound('p1', 'openai-compatible', 'http://127.0.0.1:11434/v1'),
      baseUrl: url,
    };
    const { broker, sent } = harness({ profiles: [p] });

    expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'ENDPOINT_REFUSED',
    });
    expect(sent).toHaveLength(0);
  });
});

describe('provider broker: replies and failures', () => {
  it('names the target of a redirect and does not follow it', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker, sent } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result).toMatchObject({ ok: false, code: 'REDIRECT_REFUSED' });
    expect(result.ok === false && result.message).toContain('https://evil.example/steal');
    expect(sent).toHaveLength(1);
  });

  it('reports an auth failure and never echoes the key or the provider body', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () => new Response(`bad key ${KEY}`, { status: 401 }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result).toMatchObject({ ok: false, code: 'AUTH_FAILED' });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('reports other HTTP errors by status only', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () => new Response('upstream body', { status: 503 }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result).toEqual({
      ok: false,
      code: 'PROVIDER_HTTP_ERROR',
      message: 'The provider returned HTTP 503.',
    });
  });

  it('refuses a reply larger than the limit, announced or streamed', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const announced = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        new Response('x', {
          status: 200,
          headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
        }),
    });
    expect(await announced.broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });

    const streamed = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    });
    expect(await streamed.broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });
  });

  it('times out a request that never answers', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      timeoutMs: { complete: 20 },
      reply: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    });

    expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'TIMEOUT',
    });
  });

  it('refuses a request body over the limit and an invalid body before any request', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker, sent } = harness({ profiles: [p], keys: { [p.secretHandleId]: KEY } });

    expect(
      await broker.complete({
        profileId: 'p1',
        body: { messages: [{ role: 'user', content: 'x'.repeat(MAX_WORKER_REQUEST_BYTES) }] },
        maxRequestBytes: MAX_WORKER_REQUEST_BYTES,
      }),
    ).toMatchObject({ ok: false, code: 'REQUEST_TOO_LARGE' });
    expect(await broker.complete({ profileId: 'p1', body: { messages: [] } })).toMatchObject({
      ok: false,
      code: 'REQUEST_INVALID',
    });
    expect(sent).toHaveLength(0);
  });

  it('refuses a chat reply that is not JSON', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () => new Response('<html>', { status: 200 }),
    });

    expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'PROVIDER_INCOMPATIBLE',
    });
  });
});

describe('provider broker: Anthropic Messages (Claude)', () => {
  it('converts the request and the reply, so the engine reads one shape', async () => {
    const p = bound('p1', 'claude', 'https://api.anthropic.com/v1', 'claude-sonnet-5-5');
    const { broker, sent } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        jsonReply({
          id: 'msg_1',
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'Checking. ' },
            { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
          ],
          usage: { input_tokens: 3, output_tokens: 5 },
        }),
    });

    const result = await broker.complete({
      profileId: 'p1',
      body: {
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'find x' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'toolu_0',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"y"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'toolu_0', content: 'found y' },
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'lookup', description: 'Find', parameters: { type: 'object' } },
          },
        ],
        tool_choice: 'required',
        max_tokens: 256,
      },
    });

    expect(sent[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(headerOf(sent[0]!.init, 'x-api-key')).toBe(KEY);
    expect(headerOf(sent[0]!.init, 'anthropic-version')).toBe('2023-06-01');
    expect(headerOf(sent[0]!.init, 'authorization')).toBeNull();
    const sentBody = JSON.parse(String(sent[0]?.init.body)) as Record<string, unknown>;
    expect(sentBody).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 256,
      system: 'Be brief.',
      tool_choice: { type: 'any' },
      tools: [{ name: 'lookup', description: 'Find', input_schema: { type: 'object' } }],
    });
    expect(sentBody.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'find x' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_0', name: 'lookup', input: { q: 'y' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: 'found y' }],
      },
    ]);

    expect(result.ok).toBe(true);
    const reply = JSON.parse(result.ok ? result.data.text : '') as {
      choices: { message: Record<string, unknown>; finish_reason: string }[];
    };
    expect(reply.choices[0]?.finish_reason).toBe('tool_calls');
    expect(reply.choices[0]?.message).toEqual({
      role: 'assistant',
      content: 'Checking. ',
      tool_calls: [
        { id: 'toolu_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
      ],
    });
  });

  it('sends only inline images to Claude and refuses a remote image URL', async () => {
    const p = bound('p1', 'claude', 'https://api.anthropic.com/v1', 'claude-sonnet-5-5');
    const { broker, sent } = harness({ profiles: [p], keys: { [p.secretHandleId]: KEY } });

    const remote = await broker.complete({
      profileId: 'p1',
      body: {
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }],
          },
        ],
      },
    });
    expect(remote).toMatchObject({ ok: false, code: 'REQUEST_INVALID' });
    expect(sent).toHaveLength(0);
  });

  it('refuses a reply with no content list', async () => {
    const p = bound('p1', 'claude', 'https://api.anthropic.com/v1', 'claude-sonnet-5-5');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () => jsonReply({ type: 'error' }),
    });

    expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'PROVIDER_INCOMPATIBLE',
    });
  });
});

describe('provider broker: probe and model lists', () => {
  it('probes a saved profile and reports success without any credential', async () => {
    const p = bound('p1', 'openai', 'https://api.openai.com/v1', 'gpt-4o-mini');
    const { broker, sent } = harness({ profiles: [p], keys: { [p.secretHandleId]: KEY } });

    const report = await broker.probe('p1');

    expect(report).toEqual({ ok: true, modelId: 'gpt-4o-mini' });
    expect(JSON.parse(String(sent[0]?.init.body))).toMatchObject({ max_completion_tokens: 1 });
  });

  it('maps a rejected key to AUTH_FAILED and an unknown profile to a redacted report', async () => {
    const p = bound('p1', 'openai', 'https://api.openai.com/v1', 'gpt-4o-mini');
    const rejected = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () => new Response('no', { status: 403 }),
    });
    expect(await rejected.broker.probe('p1')).toMatchObject({
      ok: false,
      modelId: 'gpt-4o-mini',
      errorCode: 'AUTH_FAILED',
    });

    const unknown = harness();
    expect(await unknown.broker.probe('missing')).toMatchObject({
      ok: false,
      modelId: '',
      errorCode: 'PROVIDER_INCOMPATIBLE',
    });
  });

  it('lists models for an unsaved draft, sent once and never returned', async () => {
    const { broker, sent } = harness({
      reply: () => jsonReply({ data: [{ id: 'gpt-4o-mini' }, { id: '' }, { id: 'o3' }] }),
    });

    const result = await broker.listModels({
      draft: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: KEY },
    });

    expect(result).toEqual({
      ok: true,
      data: [
        { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
        { id: 'o3', name: 'o3' },
      ],
    });
    expect(sent[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(headerOf(sent[0]!.init, 'authorization')).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('refuses a draft pointing at a public custom endpoint, with no request', async () => {
    const { broker, sent } = harness();

    expect(
      await broker.listModels({
        draft: {
          provider: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKey: KEY,
        },
      }),
    ).toMatchObject({ ok: false, code: 'ENDPOINT_REFUSED' });
    expect(sent).toHaveLength(0);
  });

  it('lists Claude models with the x-api-key header and their display names', async () => {
    const { broker, sent } = harness({
      reply: () =>
        jsonReply({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }] }),
    });

    const result = await broker.listModels({
      draft: { provider: 'claude', baseUrl: 'https://api.anthropic.com/v1', apiKey: KEY },
    });

    expect(result).toEqual({
      ok: true,
      data: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }],
    });
    expect(headerOf(sent[0]!.init, 'x-api-key')).toBe(KEY);
  });

  it('asks for a key before listing Claude models without one', async () => {
    const { broker, sent } = harness();

    expect(
      await broker.listModels({
        draft: {
          provider: 'claude',
          baseUrl: 'https://api.anthropic.com/v1',
          apiKey: 'not-provided',
        },
      }),
    ).toMatchObject({ ok: false, code: 'CREDENTIAL_UNAVAILABLE' });
    expect(sent).toHaveLength(0);
  });
});

describe('endpointBindingDigest', () => {
  it('changes when the profile, the origin or the base path changes', () => {
    const base = endpointBindingDigest('p1', 'https://api.x.ai', '/v1');
    expect(endpointBindingDigest('p1', 'https://api.x.ai', '/v1')).toBe(base);
    expect(endpointBindingDigest('p2', 'https://api.x.ai', '/v1')).not.toBe(base);
    expect(endpointBindingDigest('p1', 'https://api.x.ai', '/v2')).not.toBe(base);
    expect(endpointBindingDigest('p1', 'https://api.example.com', '/v1')).not.toBe(base);
  });
});

describe('provider broker: request and reply rules', () => {
  it('sends OpenAI its completion limit under max_completion_tokens, and other providers max_tokens', async () => {
    const openai = bound('p-openai', 'openai', 'https://api.openai.com/v1', 'gpt-4o-mini');
    const grok = bound('p-grok', 'grok', 'https://api.x.ai/v1', 'grok-3');
    const { broker, sent } = harness({
      profiles: [openai, grok],
      keys: { [openai.secretHandleId]: KEY, [grok.secretHandleId]: KEY },
    });

    await broker.complete({
      profileId: 'p-openai',
      body: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 },
    });
    await broker.complete({
      profileId: 'p-grok',
      body: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 },
    });

    const openaiBody = JSON.parse(String(sent[0]?.init.body)) as Record<string, unknown>;
    expect(openaiBody).toMatchObject({ max_completion_tokens: 64 });
    expect(openaiBody).not.toHaveProperty('max_tokens');
    expect(JSON.parse(String(sent[1]?.init.body))).toMatchObject({ max_tokens: 64 });
  });

  it('refuses a reply whose key is written with JSON escapes', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        new Response('{"choices":[{"message":{"content":"\\u0073k-test-0123456789abcdef"}}]}', {
          status: 200,
        }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_INCOMPATIBLE' });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('names a redirect target without its query, and never names the key', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://evil.example/steal?k=${KEY}` },
        }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result).toMatchObject({ ok: false, code: 'REDIRECT_REFUSED' });
    expect(result.ok === false && result.message).toContain('https://evil.example/steal');
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain('?k=');
  });

  it('accepts a model id with spaces and brackets, and refuses one with a control character', async () => {
    const p = bound('p1', 'openai-compatible', 'http://127.0.0.1:1234/v1', 'local');
    const { broker, sent } = harness({ profiles: [p] });

    expect(
      (await broker.complete({ profileId: 'p1', body: CHAT_BODY, modelId: 'Llama 3 (8B) q4' })).ok,
    ).toBe(true);
    expect(JSON.parse(String(sent[0]?.init.body))).toMatchObject({ model: 'Llama 3 (8B) q4' });
    expect(
      await broker.complete({ profileId: 'p1', body: CHAT_BODY, modelId: 'llama\u0007' }),
    ).toMatchObject({ ok: false, code: 'REQUEST_INVALID' });
  });

  it('asks Anthropic for its first page of 1000 models, and refuses a refusal rather than passing it on as an answer', async () => {
    const p = bound('p1', 'claude', 'https://api.anthropic.com/v1', 'claude-sonnet-5-5');
    const { broker, sent } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        jsonReply({
          id: 'msg_2',
          stop_reason: 'refusal',
          content: [{ type: 'text', text: 'No.' }],
        }),
    });

    await broker.listModels({ profileId: 'p1' });
    expect(sent[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000');

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });
    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_INCOMPATIBLE' });
  });

  it('accepts a request body up to the agent limit by default, and refuses past it', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({ profiles: [p], keys: { [p.secretHandleId]: KEY } });
    const twoMiB = 'x'.repeat(2 * 1024 * 1024);

    expect(
      (
        await broker.complete({
          profileId: 'p1',
          body: { messages: [{ role: 'user', content: twoMiB }] },
        })
      ).ok,
    ).toBe(true);
    expect(
      await broker.complete({
        profileId: 'p1',
        body: { messages: [{ role: 'user', content: 'x'.repeat(MAX_AGENT_REQUEST_BYTES) }] },
      }),
    ).toMatchObject({ ok: false, code: 'REQUEST_TOO_LARGE' });
  });
});

describe('provider broker: the reply that leaves the broker', () => {
  it('refuses an Anthropic key split across two text blocks, which the join would rejoin', async () => {
    const p = bound('p1', 'claude', 'https://api.anthropic.com/v1', 'claude-sonnet-5-5');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        jsonReply({
          id: 'msg_3',
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: 'sk-test-0123' },
            { type: 'text', text: '456789abcdef' },
          ],
        }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_INCOMPATIBLE' });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('refuses a key written as a JSON property name with escapes', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () => new Response('{"\\u0073k-test-0123456789abcdef":1}', { status: 200 }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_INCOMPATIBLE' });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('refuses a model list that names the key, however it is escaped', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        new Response('{"data":[{"id":"\\u0073k-test-0123456789abcdef"}]}', { status: 200 }),
    });

    const result = await broker.listModels({ profileId: 'p1' });

    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_INCOMPATIBLE' });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('never names a redirect target that holds the key in percent-encoded form', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/x/%73k-test-0123456789abcdef' },
        }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result).toMatchObject({ ok: false, code: 'REDIRECT_REFUSED' });
    expect(JSON.stringify(result)).not.toContain('%73k');
    expect(JSON.stringify(result)).not.toContain('evil.example');
  });

  it('refuses an Anthropic reply that paused its turn, rather than passing it on as complete', async () => {
    const p = bound('p1', 'claude', 'https://api.anthropic.com/v1', 'claude-sonnet-5-5');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        jsonReply({
          id: 'msg_4',
          stop_reason: 'pause_turn',
          content: [{ type: 'text', text: 'Let me' }],
        }),
    });

    expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'PROVIDER_INCOMPATIBLE',
      message: expect.stringContaining('paused'),
    });
  });

  it('refuses a chat reply the model refused, rather than passing an empty answer on', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        jsonReply({
          choices: [
            { finish_reason: 'content_filter', message: { role: 'assistant', content: null } },
          ],
        }),
    });

    expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'PROVIDER_INCOMPATIBLE',
      message: expect.stringContaining('refused'),
    });
  });

  it('forwards the completion fields the engine reads, and drops provider metadata such as a base URL', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        jsonReply({
          id: 'c1',
          base_url: 'http://127.0.0.1:1234/v1',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              provider_note: 'http://127.0.0.1:1234/v1',
              message: {
                role: 'assistant',
                content: 'Point the client at http://127.0.0.1:1234/v1 for the local server.',
                annotations: ['http://127.0.0.1:1234/v1'],
              },
            },
          ],
        }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a reply');
    expect(result.data.text).not.toContain('base_url');
    expect(result.data.text).not.toContain('provider_note');
    expect(result.data.text).not.toContain('annotations');
    expect(JSON.parse(result.data.text)).toEqual({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'Point the client at http://127.0.0.1:1234/v1 for the local server.',
          },
        },
      ],
    });
  });

  it('drops metadata nested in the usage and tool-call fields, which the engine does not read', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        jsonReply({
          id: 'c2',
          usage: { prompt_tokens: 3, base_url: 'http://127.0.0.1:1234/v1' },
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    provider: { base_url: 'http://127.0.0.1:1234/v1' },
                    function: {
                      name: 'read_file',
                      arguments: '{"path":"notes.md"}',
                      endpoint: 'http://127.0.0.1:1234/v1',
                    },
                  },
                ],
              },
            },
          ],
        }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a reply');
    expect(result.data.text).not.toContain('base_url');
    expect(result.data.text).not.toContain('endpoint');
    expect(JSON.parse(result.data.text)).toEqual({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"notes.md"}' },
              },
            ],
          },
        },
      ],
    });
  });

  it('drops the envelope the engine never reads, including a model string that holds a URL', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        jsonReply({
          id: 'chat-1',
          object: 'chat.completion',
          created: 1,
          model: 'http://127.0.0.1:1234/v1',
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'answer' } }],
        }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a reply');
    expect(result.data.text).not.toContain('127.0.0.1');
    expect(JSON.parse(result.data.text)).toEqual({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'answer' } }],
    });
  });

  it('refuses a tool call id that is not an id, such as a URL, and keeps an id with dots and colons', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    let callId = 'http://127.0.0.1:1234/v1';
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        jsonReply({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: callId,
                    type: 'function',
                    function: { name: 'read_file', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
    });

    expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'PROVIDER_INCOMPATIBLE',
    });

    callId = 'functions.read_file:0';
    const kept = await broker.complete({ profileId: 'p1', body: CHAT_BODY });
    expect(kept.ok).toBe(true);
    if (!kept.ok) throw new Error('expected a reply');
    expect(JSON.parse(kept.data.text).choices[0].message.tool_calls[0]).toEqual({
      id: 'functions.read_file:0',
      type: 'function',
      function: { name: 'read_file', arguments: '{}' },
    });
  });

  it.each([null, 'user'])(
    'refuses a message whose role is %s, which the engine would read as absent',
    async (role) => {
      const p = bound('p1', 'grok', 'https://api.x.ai/v1');
      const { broker } = harness({
        profiles: [p],
        keys: { [p.secretHandleId]: KEY },
        reply: () => jsonReply({ choices: [{ message: { role, content: 'a probe answer' } }] }),
      });

      expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
        ok: false,
        code: 'PROVIDER_INCOMPATIBLE',
      });
    },
  );

  it('drops the id and usage of a Claude reply, which the engine never reads', async () => {
    const p = bound('p1', 'claude', 'https://api.anthropic.com/v1', 'claude-sonnet-5-5');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        jsonReply({
          id: 'http://127.0.0.1:1234/v1',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a reply');
    expect(result.data.text).not.toContain('127.0.0.1');
    expect(JSON.parse(result.data.text)).toEqual({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
    });
  });

  it('refuses a reply with a malformed choice, rather than promoting the next choice to first', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        jsonReply({
          choices: [null, { message: { role: 'assistant', content: 'second choice' } }],
        }),
    });

    expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'PROVIDER_INCOMPATIBLE',
    });
  });

  it('refuses a message whose content is not text, which the engine cannot read', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        jsonReply({
          choices: [
            {
              message: { role: 'assistant', content: [{ type: 'text', text: 'parts, not text' }] },
            },
          ],
        }),
    });

    expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'PROVIDER_INCOMPATIBLE',
    });
  });

  it('refuses a chat reply with a refusal message, even when its finish reason is stop', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        jsonReply({
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' },
            },
          ],
        }),
    });

    expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'PROVIDER_INCOMPATIBLE',
      message: expect.stringContaining('refused'),
    });
  });
});

describe('provider broker: the key in nested JSON, redirects and cancellation', () => {
  it('refuses a key hidden in tool call arguments, which are JSON inside a JSON string', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const arguments_ = '{"k":"\\u0073k-test-0123456789abcdef"}';
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        jsonReply({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'f', arguments: arguments_ } },
                ],
              },
            },
          ],
        }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_INCOMPATIBLE' });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('refuses a key hidden in a property name that is itself JSON text', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    // The property name decodes to the JSON text "sk-test-0123456789abcdef", which parses to the key.
    const reply = '{"\\"\\\\u0073k-test-0123456789abcdef\\"":1}';
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () => new Response(reply, { status: 200 }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_INCOMPATIBLE' });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('names no redirect target whose percent escapes cannot be read', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/x/%73k-test-0123456789abcdef/%ZZ' },
        }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result).toMatchObject({ ok: false, code: 'REDIRECT_REFUSED' });
    expect(JSON.stringify(result)).not.toContain('evil.example');
    expect(JSON.stringify(result)).not.toContain('%73k');
  });

  it('still names a redirect target that holds no key, without its query', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const { broker } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://api.x.ai/v2/chat?token=abc' },
        }),
    });

    const result = await broker.complete({ profileId: 'p1', body: CHAT_BODY });

    expect(result).toMatchObject({
      ok: false,
      code: 'REDIRECT_REFUSED',
      message: expect.stringContaining('https://api.x.ai/v2/chat'),
    });
    expect(JSON.stringify(result)).not.toContain('token=abc');
  });

  it('ends the provider call when the caller has gone, and says the request was cancelled', async () => {
    const p = bound('p1', 'grok', 'https://api.x.ai/v1');
    const caller = new AbortController();
    const { broker, sent } = harness({
      profiles: [p],
      keys: { [p.secretHandleId]: KEY },
      reply: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const fail = (): void => reject(new DOMException('aborted', 'AbortError'));
          if (init.signal?.aborted) fail();
          else init.signal?.addEventListener('abort', fail, { once: true });
        }),
    });

    const pending = broker.complete({ profileId: 'p1', body: CHAT_BODY, signal: caller.signal });
    caller.abort();

    expect(await pending).toMatchObject({
      ok: false,
      code: 'NETWORK_ERROR',
      message: 'The request was cancelled.',
    });
    expect(sent).toHaveLength(1);
  });

  it('refuses a profile whose key has changed since the key was confirmed for this endpoint', async () => {
    const good = bound('p1', 'openrouter', 'https://openrouter.ai/api/v1');
    const changed = { ...good, bindingSecretDigest: 'v-an-older-key' };
    const { broker, sent } = harness({
      profiles: [changed],
      keys: { [good.secretHandleId]: KEY },
    });

    expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'BINDING_MISMATCH',
    });
    expect(sent).toHaveLength(0);
  });

  it('refuses a profile whose key was never confirmed for its endpoint', async () => {
    const good = bound('p1', 'openrouter', 'https://openrouter.ai/api/v1');
    const { bindingSecretDigest: _unconfirmed, ...unconfirmed } = good;
    const { broker, sent } = harness({
      profiles: [unconfirmed],
      keys: { [good.secretHandleId]: KEY },
    });

    expect(await broker.complete({ profileId: 'p1', body: CHAT_BODY })).toMatchObject({
      ok: false,
      code: 'BINDING_MISMATCH',
    });
    expect(sent).toHaveLength(0);
  });
});
