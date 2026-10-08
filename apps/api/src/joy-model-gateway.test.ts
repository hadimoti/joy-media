import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  JoyModelGateway,
  JOY_AGENT_FREE_MODELS,
  LEGACY_MODEL_ALIASES,
  warnIfPaidModelAllowlistSet,
  joyModelFallbackOrder,
  OPENROUTER_SYSTEMD_CREDENTIAL_IDS,
  readOpenRouterApiKeyFromCredential,
} from './joy-model-gateway.js';
import { MemoryAgentUsageLedger, type AgentUsageLedger } from './agent-usage-ledger.js';
import type { MediaAuthService } from './media-auth.js';
import type { AccountService, Subscription } from './account-service.js';

function createMockReq(options: {
  method?: string;
  url?: string;
  body?: unknown;
}): IncomingMessage {
  const content =
    options.body !== undefined ? Buffer.from(JSON.stringify(options.body)) : Buffer.alloc(0);
  const stream = Readable.from([content]) as unknown as IncomingMessage;
  (stream as any).method = options.method ?? 'POST';
  (stream as any).url = options.url ?? '/v1/agent/chat/completions';
  (stream as any).headers = { 'content-type': 'application/json' };
  return stream;
}

function createMockRes(): {
  res: ServerResponse;
  getStatus: () => number;
  getHeaders: () => Record<string, string>;
  getBody: () => string;
  close: () => void;
} {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  const chunks: string[] = [];

  const events = new EventEmitter();
  const res = Object.assign(events, {
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
      return res;
    },
    write(chunk: unknown) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as any).toString('utf8'));
      return true;
    },
    end(chunk?: unknown) {
      if (chunk) {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as any).toString('utf8'));
      }
      return res;
    },
  }) as unknown as ServerResponse;

  return {
    res,
    getStatus: () => statusCode,
    getHeaders: () => headers,
    getBody: () => chunks.join(''),
    close: () => events.emit('close'),
  };
}

const SUPER = 'nvidia/nemotron-3-super-120b-a12b:free';
const ULTRA = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const NORTH = 'cohere/north-mini-code:free';
const GEMMA = 'google/gemma-4-31b-it:free';
const OMNI = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';

describe('JoyModelGateway', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to exactly the five zero-cost catalog models with correct vision flags', async () => {
    const gateway = new JoyModelGateway({
      mediaAuth: {} as MediaAuthService,
      account: {} as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
    });
    const { res, getBody } = createMockRes();
    await gateway.handleGetModels(createMockReq({ method: 'GET' }), res);
    const models = JSON.parse(getBody()).models as Array<{
      id: string;
      vision: boolean;
      isDefault?: boolean;
      inputUsdPerMillion: number;
      outputUsdPerMillion: number;
    }>;
    expect(models.map((model) => [model.id, model.vision, model.isDefault === true])).toEqual([
      ['nvidia/nemotron-3-super-120b-a12b:free', false, true],
      ['nvidia/nemotron-3-ultra-550b-a55b:free', false, false],
      ['cohere/north-mini-code:free', false, false],
      ['google/gemma-4-31b-it:free', true, false],
      ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', true, false],
    ]);
    expect(JOY_AGENT_FREE_MODELS).toHaveLength(5);
    expect(models.some((model) => model.id === 'openrouter/free')).toBe(false);
  });

  it('only ever lists zero-cost ":free" ids in the free catalog', () => {
    expect(JOY_AGENT_FREE_MODELS).toHaveLength(5);
    for (const model of JOY_AGENT_FREE_MODELS) {
      expect(model.id).toMatch(/:free$/);
      expect(model.inputUsdPerMillion).toBe(0);
      expect(model.outputUsdPerMillion).toBe(0);
    }
    expect(JOY_AGENT_FREE_MODELS.filter((model) => model.isDefault)).toHaveLength(1);
  });

  it('maps every legacy id to the free default', () => {
    expect(LEGACY_MODEL_ALIASES).toEqual({
      'openrouter/free': 'nvidia/nemotron-3-super-120b-a12b:free',
      'minimax/minimax-m3': 'nvidia/nemotron-3-super-120b-a12b:free',
      'anthropic/claude-3.5-sonnet': 'nvidia/nemotron-3-super-120b-a12b:free',
      'meta-llama/llama-3.3-70b-instruct': 'nvidia/nemotron-3-super-120b-a12b:free',
    });
  });

  it('falls back only within the free list, in catalog order, and never for paid models', () => {
    expect(joyModelFallbackOrder(OMNI)).toEqual([OMNI, SUPER, ULTRA, NORTH, GEMMA]);
    expect(joyModelFallbackOrder('anthropic/claude-sonnet-4.6')).toEqual([]);
    expect(joyModelFallbackOrder(OMNI, { requireVision: true })).toEqual([OMNI, GEMMA]);
    // Images sent to a text model (such as the text default) go to gemma, then nano-omni.
    expect(joyModelFallbackOrder(SUPER, { requireVision: true })).toEqual([GEMMA, OMNI]);
    expect(joyModelFallbackOrder(NORTH, { requireVision: true })).toEqual([GEMMA, OMNI]);
  });

  it('refuses paid model IDs by default and redirects a legacy alias to the free default', async () => {
    let sentModel: string | undefined;
    const gateway = new JoyModelGateway({
      mediaAuth: {
        authenticate: async () => ({ id: 'free-default' }),
      } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'free-default',
          plan: 'pro',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
      fetchImpl: async (_url, init) => {
        sentModel = (JSON.parse(String(init?.body)) as { model: string }).model;
        return new Response(JSON.stringify({ choices: [], usage: {} }), { status: 200 });
      },
    });
    const denied = createMockRes();
    await gateway.handleChatCompletions(
      createMockReq({ body: { model: 'anthropic/claude-sonnet-4.6', messages: [] } }),
      denied.res,
    );
    expect(denied.getStatus()).toBe(400);
    expect(denied.getBody()).toContain('MODEL_NOT_ALLOWED');
    const aliased = createMockRes();
    await gateway.handleChatCompletions(
      createMockReq({ body: { model: 'minimax/minimax-m3', messages: [] } }),
      aliased.res,
    );
    expect(aliased.getStatus()).toBe(200);
    expect(sentModel).toBe(SUPER);
    for (const model of ['openrouter/free', 'anthropic/claude-3.5-sonnet']) {
      sentModel = undefined;
      const legacy = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({ body: { model, messages: [] } }),
        legacy.res,
      );
      expect(legacy.getStatus()).toBe(200);
      expect(sentModel).toBe(SUPER);
    }
    for (const model of [
      'openrouter/auto',
      'google/gemma-4-31b-it',
      'deepseek/deepseek-v4-flash',
    ]) {
      sentModel = undefined;
      const refused = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({ body: { model, messages: [] } }),
        refused.res,
      );
      expect(refused.getStatus()).toBe(400);
      expect(refused.getBody()).toContain('MODEL_NOT_ALLOWED');
      expect(sentModel).toBeUndefined();
    }
  });

  describe('free-model fallback on upstream 404/429/5xx', () => {
    const activeUser = () => ({
      mediaAuth: { authenticate: async () => ({ id: 'fb' }) } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'fb',
          plan: 'pro',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
    });
    const scripted =
      (statuses: number[], tried: string[]) => async (_url: unknown, init?: RequestInit) => {
        tried.push((JSON.parse(String(init?.body)) as { model: string }).model);
        const status = statuses[tried.length - 1] ?? 200;
        return status === 200
          ? new Response(JSON.stringify({ choices: [], usage: { cost: 0 } }), { status })
          : new Response('provider-detail', { status });
      };

    it('tries the next free model in order and records the one that answered', async () => {
      const tried: string[] = [];
      const ledger = new MemoryAgentUsageLedger();
      const settle = vi.spyOn(ledger, 'settleSpend');
      const gateway = new JoyModelGateway({
        ...activeUser(),
        ledger,
        openRouterApiKey: 'test-key',
        fetchImpl: scripted([429, 503], tried),
      });
      const result = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({ body: { model: 'openrouter/free', messages: [] } }),
        result.res,
      );
      expect(result.getStatus()).toBe(200);
      expect(tried).toEqual([SUPER, ULTRA, NORTH]);
      expect(settle.mock.calls[0]?.[1]).toMatchObject({ modelId: NORTH });
    });

    it('stops after the whole list and never tries a model outside it', async () => {
      const tried: string[] = [];
      const gateway = new JoyModelGateway({
        ...activeUser(),
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl: scripted([500, 502, 503, 504, 429, 500], tried),
      });
      const result = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({ body: { model: 'cohere/north-mini-code:free', messages: [] } }),
        result.res,
      );
      expect(tried).toEqual([NORTH, SUPER, ULTRA, GEMMA, OMNI]);
      expect(tried.every((id) => JOY_AGENT_FREE_MODELS.some((model) => model.id === id))).toBe(
        true,
      );
      expect(result.getStatus()).toBe(503);
      expect(JSON.parse(result.getBody()).error).toMatchObject({
        code: 'JOY_AGENT_MODELS_BUSY',
        retryable: true,
        retryAfterSeconds: 30,
        vision: false,
      });
      expect(result.getHeaders()['retry-after']).toBe('30');
      expect(result.getBody()).not.toContain('provider-detail');
    });

    it('falls back on upstream 404 (a withdrawn free model), then reports every model busy', async () => {
      const tried: string[] = [];
      const gateway = new JoyModelGateway({
        ...activeUser(),
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl: scripted([404], tried),
      });
      const result = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
        result.res,
      );
      expect(tried).toEqual([GEMMA, SUPER]);
      expect(result.getStatus()).toBe(200);

      const allGone: string[] = [];
      const gone = new JoyModelGateway({
        ...activeUser(),
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl: scripted([404, 404, 404, 404, 404], allGone),
      });
      const final = createMockRes();
      await gone.handleChatCompletions(
        createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
        final.res,
      );
      expect(allGone).toHaveLength(5);
      expect(final.getStatus()).toBe(503);
      expect(final.getBody()).toContain('JOY_AGENT_MODELS_BUSY');
    });

    it.each([400, 401, 402])('does not fall back on upstream %i', async (status) => {
      const tried: string[] = [];
      const gateway = new JoyModelGateway({
        ...activeUser(),
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl: scripted([status], tried),
      });
      await gateway.handleChatCompletions(
        createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
        createMockRes().res,
      );
      expect(tried).toEqual(['google/gemma-4-31b-it:free']);
    });

    describe('which upstream failures fall back (FC3)', () => {
      const openRouterError = (
        status: number,
        error: { code?: number | string; message?: string; metadata?: Record<string, unknown> },
        headers: Record<string, string> = {},
      ) =>
        new Response(JSON.stringify({ error }), {
          status,
          headers: { 'content-type': 'application/json', ...headers },
        });
      const sequence =
        (responses: Array<() => Response>, tried: string[]) =>
        async (_url: unknown, init?: RequestInit) => {
          tried.push((JSON.parse(String(init?.body)) as { model: string }).model);
          const next = responses[tried.length - 1];
          return next
            ? next()
            : new Response(JSON.stringify({ choices: [], usage: { cost: 0 } }), { status: 200 });
        };
      const run = async (fetchImpl: typeof fetch, body: Record<string, unknown> = {}) => {
        const result = createMockRes();
        await new JoyModelGateway({
          ...activeUser(),
          ledger: new MemoryAgentUsageLedger(),
          openRouterApiKey: 'test-key',
          fetchImpl,
        }).handleChatCompletions(
          createMockReq({ body: { model: SUPER, messages: [], ...body } }),
          result.res,
        );
        return result;
      };

      it('falls back on a model-specific 403 (a gated free endpoint), not as an auth failure', async () => {
        const tried: string[] = [];
        const result = await run(
          sequence(
            [
              () =>
                openRouterError(403, {
                  code: 403,
                  message: 'This model is only available on agentic harnesses',
                  metadata: { failed_routing_step: 'Gate Free Endpoints by Agentic Harness' },
                }),
              () => new Response('', { status: 403 }),
            ],
            tried,
          ),
        );
        expect(tried).toEqual([SUPER, ULTRA, NORTH]);
        expect(result.getStatus()).toBe(200);
        expect(result.getBody()).not.toContain('AUTH_FAILED');
      });

      it.each([
        'This API key is disabled',
        'Key limit exceeded (total limit)',
        'Invalid credentials',
      ])('treats a 403 about the key (%s) as an auth failure and stops', async (message) => {
        const tried: string[] = [];
        const result = await run(
          sequence([() => openRouterError(403, { code: 403, message })], tried),
        );
        expect(tried).toEqual([SUPER]);
        expect(result.getStatus()).toBe(503);
        expect(result.getBody()).toContain('JOY_AGENT_UPSTREAM_AUTH_FAILED');
        expect(result.getBody()).not.toContain(message);
      });

      it('still treats a key-sounding 403 that names a failed routing step as model-specific', async () => {
        const tried: string[] = [];
        await run(
          sequence(
            [
              () =>
                openRouterError(403, {
                  message: 'Key limit exceeded for this endpoint',
                  metadata: { failed_routing_step: 'Some Routing Gate' },
                }),
            ],
            tried,
          ),
        );
        expect(tried).toEqual([SUPER, ULTRA]);
      });

      it('answers JOY_AGENT_MODELS_BUSY with the soonest Retry-After when every model is busy', async () => {
        const tried: string[] = [];
        const busy = (retryAfter?: string) => () =>
          openRouterError(
            429,
            { code: 429, metadata: { limit_source: 'upstream_provider_shared_pool' } },
            retryAfter === undefined ? {} : { 'retry-after': retryAfter },
          );
        const result = await run(
          sequence(
            [
              busy('120'),
              busy('12'),
              () => openRouterError(403, { metadata: { failed_routing_step: 'Gate' } }),
              busy(),
              busy('1'),
            ],
            tried,
          ),
        );
        expect(tried).toHaveLength(5);
        expect(result.getStatus()).toBe(503);
        // 1s is below the 5s floor, so the soonest usable hint is 5.
        expect(result.getHeaders()['retry-after']).toBe('5');
        const error = JSON.parse(result.getBody()).error;
        expect(error).toMatchObject({
          code: 'JOY_AGENT_MODELS_BUSY',
          retryable: true,
          retryAfterSeconds: 5,
          vision: false,
        });
        expect(error.message).toContain('5 tried');
        expect(result.getBody()).not.toContain('AUTH_FAILED');
      });

      const okJson = (content: string) => () =>
        new Response(
          JSON.stringify({
            id: 'gen-ok',
            choices: [{ message: { role: 'assistant', content } }],
            usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0 },
          }),
          { status: 200 },
        );
      const errorIn200 = () =>
        new Response(
          JSON.stringify({
            error: {
              code: 502,
              message: 'ResourceExhausted: 16/16 SECRET-PROVIDER-DETAIL',
              metadata: { provider_name: 'Nvidia' },
            },
          }),
          { status: 200 },
        );
      const sse = (text: string) => () =>
        new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });

      it('falls back when a 200 response carries an error object instead of an answer', async () => {
        const tried: string[] = [];
        const ledger = new MemoryAgentUsageLedger();
        const settle = vi.spyOn(ledger, 'settleSpend');
        const result = createMockRes();
        await new JoyModelGateway({
          ...activeUser(),
          ledger,
          openRouterApiKey: 'test-key',
          fetchImpl: sequence(
            [
              errorIn200,
              () =>
                new Response(
                  JSON.stringify({ choices: [{ error: { code: 503, message: 'overloaded' } }] }),
                  { status: 200 },
                ),
              okJson('answered by north'),
            ],
            tried,
          ),
        }).handleChatCompletions(
          createMockReq({ body: { model: SUPER, messages: [] } }),
          result.res,
        );
        expect(tried).toEqual([SUPER, ULTRA, NORTH]);
        expect(result.getStatus()).toBe(200);
        expect(JSON.parse(result.getBody()).choices[0].message.content).toBe('answered by north');
        expect(result.getBody()).not.toContain('SECRET-PROVIDER-DETAIL');
        expect(settle).toHaveBeenCalledOnce();
        expect(settle.mock.calls[0]?.[1]).toMatchObject({ modelId: NORTH });
      });

      it('falls back when a stream opens with an error event, before anything reaches the client', async () => {
        const tried: string[] = [];
        const result = await run(
          sequence(
            [
              sse(
                ': OPENROUTER PROCESSING\n\ndata: {"id":"g1","error":{"code":502,"message":"ResourceExhausted 16/16"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}\n\n',
              ),
              sse(
                ': OPENROUTER PROCESSING\n\ndata: {"id":"g2","choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"id":"g2","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n',
              ),
            ],
            tried,
          ),
          { stream: true },
        );
        expect(tried).toEqual([SUPER, ULTRA]);
        expect(result.getStatus()).toBe(200);
        expect(result.getHeaders()['content-type']).toBe('text/event-stream');
        expect(result.getBody()).toContain('"content":"hello"');
        expect(result.getBody()).not.toContain('ResourceExhausted');
        expect(result.getBody()).not.toContain('"g1"');
      });

      it('reports every image model busy when gemma is rate-limited and nano-omni errors in a 200', async () => {
        const tried: string[] = [];
        const result = await run(
          sequence([() => openRouterError(429, { code: 429 }), errorIn200], tried),
          {
            messages: [
              {
                role: 'user',
                content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
              },
            ],
          },
        );
        expect(tried).toEqual([GEMMA, OMNI]);
        expect(result.getStatus()).toBe(503);
        expect(JSON.parse(result.getBody()).error).toMatchObject({
          code: 'JOY_AGENT_MODELS_BUSY',
          vision: true,
        });
      });

      it('times out a stream that never sends its first event, within the header budget', async () => {
        vi.useFakeTimers();
        try {
          const tried: string[] = [];
          const silent = () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(': OPENROUTER PROCESSING\n\n'));
                },
              }),
              { status: 200 },
            );
          const result = createMockRes();
          const pending = new JoyModelGateway({
            ...activeUser(),
            ledger: new MemoryAgentUsageLedger(),
            openRouterApiKey: 'test-key',
            fetchImpl: sequence([silent], tried),
          }).handleChatCompletions(
            createMockReq({ body: { model: SUPER, messages: [], stream: true } }),
            result.res,
          );
          await vi.advanceTimersByTimeAsync(86_000);
          await pending;
          expect(tried).toEqual([SUPER]);
          expect(result.getStatus()).toBe(504);
          expect(result.getBody()).toContain('UPSTREAM_TIMEOUT');
          expect(result.getBody()).not.toContain('OPENROUTER PROCESSING');
        } finally {
          vi.useRealTimers();
        }
      });

      it('logs status, error code and routing metadata for every attempt, never bodies', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        try {
          const tried: string[] = [];
          await run(
            sequence(
              [
                () =>
                  openRouterError(
                    429,
                    {
                      code: 429,
                      message: 'shared pool busy; your prompt was USER-SECRET-PROMPT',
                      metadata: {
                        limit_source: 'upstream_provider_shared_pool',
                        provider_name: 'Google AI Studio',
                        raw: 'RAW-BODY-SENTINEL',
                      },
                    },
                    { 'retry-after': '9' },
                  ),
                () =>
                  openRouterError(403, {
                    code: 403,
                    message: 'only available on agentic harnesses',
                    metadata: {
                      failed_routing_step: 'Gate Free Endpoints\u0007 by Agentic Harness',
                    },
                  }),
              ],
              tried,
            ),
            { messages: [{ role: 'user', content: 'USER-SECRET-PROMPT' }] },
          );
          const attempts = warn.mock.calls.filter(
            ([label]) => label === 'joy-model-gateway: upstream attempt',
          );
          expect(attempts.map(([, entry]) => entry)).toEqual([
            {
              ownerId: 'fb',
              attempt: 1,
              of: 5,
              modelId: SUPER,
              status: 429,
              code: '429',
              limitSource: 'upstream_provider_shared_pool',
              providerName: 'Google AI Studio',
              outcome: 'fallback',
            },
            {
              ownerId: 'fb',
              attempt: 2,
              of: 5,
              modelId: ULTRA,
              status: 403,
              code: '403',
              failedRoutingStep: 'Gate Free Endpoints by Agentic Harness',
              outcome: 'fallback',
            },
          ]);
          expect(info).toHaveBeenCalledWith('joy-model-gateway: upstream attempt', {
            ownerId: 'fb',
            attempt: 3,
            of: 5,
            modelId: NORTH,
            status: 200,
            outcome: 'ok',
          });
          const logged = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
          expect(logged).not.toContain('USER-SECRET-PROMPT');
          expect(logged).not.toContain('RAW-BODY-SENTINEL');
          expect(logged).not.toContain('agentic harnesses');
        } finally {
          warn.mockRestore();
          info.mockRestore();
        }
      });
    });

    it('falls back only to vision models when the request carries images', async () => {
      const tried: string[] = [];
      const gateway = new JoyModelGateway({
        ...activeUser(),
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl: scripted([429, 503, 500], tried),
      });
      const result = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({
          body: {
            model: 'google/gemma-4-31b-it:free',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'what is in this frame?' },
                  { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
                ],
              },
            ],
          },
        }),
        result.res,
      );
      expect(tried).toEqual([GEMMA, OMNI]);
      // Every vision model is busy: a retryable 503, not an auth failure or a 502.
      expect(result.getStatus()).toBe(503);
      expect(JSON.parse(result.getBody()).error).toMatchObject({
        code: 'JOY_AGENT_MODELS_BUSY',
        retryable: true,
        vision: true,
      });
      expect(JSON.parse(result.getBody()).error.message).toContain('image');
    });

    it('routes an image request for the text default to gemma, then nano-omni, and records who answered', async () => {
      const tried: string[] = [];
      const ledger = new MemoryAgentUsageLedger();
      const settle = vi.spyOn(ledger, 'settleSpend');
      const gateway = new JoyModelGateway({
        ...activeUser(),
        ledger,
        openRouterApiKey: 'test-key',
        fetchImpl: scripted([429], tried),
      });
      const result = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({
          body: {
            model: 'openrouter/free',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'what is in this frame?' },
                  { type: 'image_url', image_url: { url: 'https://example.invalid/f.png' } },
                ],
              },
            ],
          },
        }),
        result.res,
      );
      expect(result.getStatus()).toBe(200);
      expect(tried).toEqual([GEMMA, OMNI]);
      expect(settle.mock.calls[0]?.[1]).toMatchObject({ modelId: OMNI });
    });

    it('drops client-supplied OpenRouter routing fields so upstream cannot pick another model', async () => {
      let forwarded: Record<string, unknown> | undefined;
      const gateway = new JoyModelGateway({
        ...activeUser(),
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl: async (_url, init) => {
          forwarded = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ choices: [] }), { status: 200 });
        },
      });
      await gateway.handleChatCompletions(
        createMockReq({
          body: {
            model: 'google/gemma-4-31b-it:free',
            models: ['openai/gpt-5'],
            route: 'fallback',
            provider: { allow_fallbacks: true },
            messages: [],
          },
        }),
        createMockRes().res,
      );
      expect(forwarded?.model).toBe('google/gemma-4-31b-it:free');
      expect(forwarded).not.toHaveProperty('models');
      expect(forwarded).not.toHaveProperty('route');
      expect(forwarded).not.toHaveProperty('provider');
    });

    it('refuses paid models even when JOY_GATEWAY_PAID_MODEL_ALLOWLIST lists them', async () => {
      vi.stubEnv(
        'JOY_GATEWAY_PAID_MODEL_ALLOWLIST',
        'deepseek/deepseek-v4-flash,anthropic/claude-sonnet-4.6,bytedance-seed/seed-2.0-lite',
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const tried: string[] = [];
      const gateway = new JoyModelGateway({
        ...activeUser(),
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl: scripted([], tried),
      });
      for (const model of [
        'deepseek/deepseek-v4-flash',
        'anthropic/claude-sonnet-4.6',
        'bytedance-seed/seed-2.0-lite',
      ]) {
        const result = createMockRes();
        await gateway.handleChatCompletions(
          createMockReq({ body: { model, messages: [] } }),
          result.res,
        );
        expect(result.getStatus()).toBe(400);
        expect(result.getBody()).toContain('MODEL_NOT_ALLOWED');
      }
      expect(tried).toEqual([]);
      const catalog = createMockRes();
      await gateway.handleGetModels(createMockReq({ method: 'GET' }), catalog.res);
      expect(
        (JSON.parse(catalog.getBody()).models as Array<{ id: string }>).map((model) => model.id),
      ).toEqual(JOY_AGENT_FREE_MODELS.map((model) => model.id));
      warn.mockRestore();
    });

    it('falls back before a stream starts', async () => {
      const tried: string[] = [];
      const gateway = new JoyModelGateway({
        ...activeUser(),
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl: async (_url, init) => {
          tried.push((JSON.parse(String(init?.body)) as { model: string }).model);
          if (tried.length === 1) return new Response('busy', { status: 429 });
          return new Response(
            'data: {"id":"g1","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
            {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            },
          );
        },
      });
      const result = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({
          body: { model: 'google/gemma-4-31b-it:free', messages: [], stream: true },
        }),
        result.res,
      );
      expect(result.getStatus()).toBe(200);
      expect(result.getBody()).toContain('"content":"hi"');
      expect(tried).toEqual([GEMMA, SUPER]);
    });
  });

  it.each(['__proto__', 'constructor', 'toString'])(
    'does not treat the prototype property %s as a model alias',
    async (model) => {
      const gateway = new JoyModelGateway({
        mediaAuth: {
          authenticate: async () => ({ id: 'prototype-key-user' }),
        } as unknown as MediaAuthService,
        account: {
          getSubscription: async () => ({
            ownerId: 'prototype-key-user',
            plan: 'pro',
            status: 'active',
            updatedAt: 0,
          }),
        } as unknown as AccountService,
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl: async () => {
          throw new Error('unlisted model must not be forwarded');
        },
      });
      const result = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({ body: { model, messages: [] } }),
        result.res,
      );
      expect(result.getStatus()).toBe(400);
      expect(result.getBody()).toContain('MODEL_NOT_ALLOWED');
    },
  );

  it('warns at startup that a set JOY_GATEWAY_PAID_MODEL_ALLOWLIST is ignored', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const createGateway = () =>
        new JoyModelGateway({
          mediaAuth: {} as MediaAuthService,
          account: {} as AccountService,
          ledger: new MemoryAgentUsageLedger(),
          openRouterApiKey: undefined,
        });
      createGateway();
      expect(warning).not.toHaveBeenCalled();
      vi.stubEnv('JOY_GATEWAY_PAID_MODEL_ALLOWLIST', 'private-test-model-id');
      createGateway();
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0]?.join(' ')).toContain(
        'JOY_GATEWAY_PAID_MODEL_ALLOWLIST is set but ignored',
      );
      expect(warning.mock.calls.flat().join(' ')).not.toContain('private-test-model-id');
      expect(warnIfPaidModelAllowlistSet({ JOY_GATEWAY_PAID_MODEL_ALLOWLIST: '  ' })).toBe(false);
    } finally {
      warning.mockRestore();
    }
  });

  it('serves the model catalog without authentication', async () => {
    const gateway = new JoyModelGateway({
      mediaAuth: { authenticate: async () => undefined } as unknown as MediaAuthService,
      account: {} as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
    });

    const { res, getStatus, getBody } = createMockRes();
    const req = createMockReq({ method: 'GET', url: '/v1/agent/models' });
    await gateway.handleGetModels(req, res);

    expect(getStatus()).toBe(200);
    expect(JSON.parse(getBody()).models).toHaveLength(JOY_AGENT_FREE_MODELS.length);
  });

  it('serves the models catalog after authentication', async () => {
    const gateway = new JoyModelGateway({
      mediaAuth: { authenticate: async () => ({ id: 'user' }) } as unknown as MediaAuthService,
      account: {} as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
    });
    const { res, getStatus, getBody } = createMockRes();
    await gateway.handleGetModels(createMockReq({ method: 'GET', url: '/v1/agent/models' }), res);
    expect(getStatus()).toBe(200);
    expect(getStatus()).toBe(200);
    const data = JSON.parse(getBody());
    expect(data.models).toHaveLength(JOY_AGENT_FREE_MODELS.length);
    expect(data.models[0]).toMatchObject({ id: SUPER, isDefault: true });
    expect(data.models.filter((model: { isDefault?: boolean }) => model.isDefault)).toHaveLength(1);
    expect(data.models.some((model: { id: string }) => model.id.includes('minimax'))).toBe(false);
    expect(data.models.some((model: { id: string }) => model.id.includes('claude-3.5'))).toBe(
      false,
    );
    expect(
      data.models.every(
        (model: { id: string; inputUsdPerMillion: number; outputUsdPerMillion: number }) =>
          model.id.endsWith(':free') &&
          model.inputUsdPerMillion === 0 &&
          model.outputUsdPerMillion === 0,
      ),
    ).toBe(true);
  });

  it('rejects chat requests when unconfigured', async () => {
    const gateway = new JoyModelGateway({
      mediaAuth: {} as MediaAuthService,
      account: {} as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: undefined,
    });

    const { res, getStatus, getBody } = createMockRes();
    const req = createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } });
    await gateway.handleChatCompletions(req, res);

    expect(getStatus()).toBe(503);
    const data = JSON.parse(getBody());
    expect(data.error.code).toBe('JOY_AGENT_UNCONFIGURED');
  });

  it('rejects unauthenticated requests with 401', async () => {
    const mockAuth = {
      authenticate: async () => undefined,
    } as unknown as MediaAuthService;

    const gateway = new JoyModelGateway({
      mediaAuth: mockAuth,
      account: {} as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
    });

    const { res, getStatus, getBody } = createMockRes();
    const req = createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } });
    await gateway.handleChatCompletions(req, res);

    expect(getStatus()).toBe(401);
    const data = JSON.parse(getBody());
    expect(data.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects unsubscribed users with 402 JOY_SUBSCRIPTION_REQUIRED', async () => {
    const mockAuth = {
      authenticate: async () => ({ id: 'user-free' }),
    } as unknown as MediaAuthService;

    const mockAccount = {
      getSubscription: async (): Promise<Subscription> => ({
        ownerId: 'user-free',
        plan: 'none',
        status: 'none',
        updatedAt: Date.now(),
      }),
    } as unknown as AccountService;

    const gateway = new JoyModelGateway({
      mediaAuth: mockAuth,
      account: mockAccount,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
    });

    const { res, getStatus, getBody } = createMockRes();
    const req = createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } });
    await gateway.handleChatCompletions(req, res);

    expect(getStatus()).toBe(402);
    const data = JSON.parse(getBody());
    expect(data.error.code).toBe('JOY_SUBSCRIPTION_REQUIRED');
  });

  it('proxies request for subscribed users and records commission in ledger', async () => {
    const mockAuth = {
      authenticate: async () => ({ id: 'user-pro' }),
    } as unknown as MediaAuthService;

    const mockAccount = {
      getSubscription: async (): Promise<Subscription> => ({
        ownerId: 'user-pro',
        plan: 'monthly',
        status: 'active',
        updatedAt: Date.now(),
      }),
    } as unknown as AccountService;

    const ledger = new MemoryAgentUsageLedger();

    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-123',
          choices: [{ message: { role: 'assistant', content: 'Video edits applied' } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_cost: 0.002, // $0.002 = 2000 micros
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    const gateway = new JoyModelGateway({
      mediaAuth: mockAuth,
      account: mockAccount,
      ledger,
      openRouterApiKey: 'test-key',
      commissionRateBps: 2500, // 25% margin
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const { res, getStatus, getBody } = createMockRes();
    const req = createMockReq({
      body: {
        model: 'google/gemma-4-31b-it:free',
        messages: [{ role: 'user', content: 'add transition' }],
      },
    });

    await gateway.handleChatCompletions(req, res);

    expect(getStatus()).toBe(200);
    const data = JSON.parse(getBody());
    expect(data.choices[0].message.content).toBe('Video edits applied');

    // Verify ledger entry
    const summary = await ledger.getSummary('user-pro');
    expect(summary.totalRequests).toBe(1);
    expect(summary.totalPromptTokens).toBe(100);
    expect(summary.totalCompletionTokens).toBe(50);
    expect(summary.totalUpstreamCostMicros).toBe('2000');
    // Billed = 2000 * 1.25 = 2500
    expect(summary.totalBilledCostMicros).toBe('2500');
  });

  it('forwards only catalog-safe completion fields and caps output tokens', async () => {
    let forwardedBody: Record<string, unknown> | undefined;
    const gateway = new JoyModelGateway({
      mediaAuth: { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'u',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
      fetchImpl: async (_url, init) => {
        forwardedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [], usage: {} }), { status: 200 });
      },
    });
    const allowedFields = {
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'edit', parameters: {} } }],
      tool_choice: 'auto',
      temperature: 0.2,
      top_p: 0.8,
      max_tokens: 9000,
      max_completion_tokens: 9001,
      stream: false,
      stream_options: { include_usage: true },
      response_format: { type: 'json_object' },
      stop: ['END'],
      seed: 42,
    };
    await gateway.handleChatCompletions(
      createMockReq({
        body: {
          model: 'google/gemma-4-31b-it:free',
          ...allowedFields,
          models: ['not-in-catalog/model'],
          provider: { order: ['untrusted-provider'] },
          plugins: [{ id: 'web' }, { id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
          route: 'fallback',
          transforms: ['middle-out'],
          arbitrary: 'drop-me',
        },
      }),
      createMockRes().res,
    );
    expect(forwardedBody).toMatchObject({
      model: 'google/gemma-4-31b-it:free',
      ...allowedFields,
      max_tokens: 8192,
      max_completion_tokens: 8192,
      usage: { include: true },
    });
    expect(forwardedBody).not.toHaveProperty('models');
    expect(forwardedBody).not.toHaveProperty('provider');
    // Client plugins are dropped; only the forced free file parser is sent.
    expect(forwardedBody?.plugins).toEqual([
      { id: 'file-parser', pdf: { engine: 'cloudflare-ai' } },
    ]);
    expect(forwardedBody).not.toHaveProperty('route');
    expect(forwardedBody).not.toHaveProperty('transforms');
    expect(forwardedBody).not.toHaveProperty('arbitrary');
  });

  describe('reasoning output (FC3)', () => {
    const gatewayWith = (fetchImpl: typeof fetch) =>
      new JoyModelGateway({
        mediaAuth: { authenticate: async () => ({ id: 'r' }) } as unknown as MediaAuthService,
        account: {
          getSubscription: async () => ({
            ownerId: 'r',
            plan: 'monthly',
            status: 'active',
            updatedAt: 0,
          }),
        } as unknown as AccountService,
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl,
      });

    it('asks OpenRouter to exclude reasoning for the reasoning model only', async () => {
      const bodies: Array<Record<string, unknown>> = [];
      const gateway = gatewayWith((async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ choices: [], usage: { cost: 0 } }), { status: 200 });
      }) as unknown as typeof fetch);
      for (const model of [OMNI, SUPER])
        await gateway.handleChatCompletions(
          createMockReq({
            body: { model, messages: [], reasoning: { effort: 'high', exclude: false } },
          }),
          createMockRes().res,
        );
      expect(bodies[0]).toMatchObject({ model: OMNI, reasoning: { exclude: true } });
      expect(bodies[0]?.reasoning).toEqual({ exclude: true });
      expect(bodies[1]?.model).toBe(SUPER);
      expect(bodies[1]).not.toHaveProperty('reasoning');
    });

    it('strips reasoning fields and a leading think block from a completion', async () => {
      const result = createMockRes();
      await gatewayWith(
        (async () =>
          new Response(
            JSON.stringify({
              id: 'gen-r',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: '<think>LONG-HIDDEN-REASONING</think>\n\nThe frame is red.',
                    reasoning: 'LONG-HIDDEN-REASONING',
                    reasoning_details: [{ type: 'reasoning.text', text: 'LONG-HIDDEN-REASONING' }],
                  },
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 900, cost: 0 },
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      ).handleChatCompletions(createMockReq({ body: { model: OMNI, messages: [] } }), result.res);
      expect(result.getStatus()).toBe(200);
      const message = JSON.parse(result.getBody()).choices[0].message;
      expect(message).toEqual({ role: 'assistant', content: 'The frame is red.' });
      expect(result.getBody()).not.toContain('LONG-HIDDEN-REASONING');
    });

    it('strips streamed reasoning deltas but keeps content, tool calls and usage', async () => {
      const ledger = new MemoryAgentUsageLedger();
      const result = createMockRes();
      await new JoyModelGateway({
        mediaAuth: { authenticate: async () => ({ id: 'r' }) } as unknown as MediaAuthService,
        account: {
          getSubscription: async () => ({
            ownerId: 'r',
            plan: 'monthly',
            status: 'active',
            updatedAt: 0,
          }),
        } as unknown as AccountService,
        ledger,
        openRouterApiKey: 'test-key',
        fetchImpl: async () =>
          new Response(
            [
              'data: {"id":"g","choices":[{"delta":{"role":"assistant","reasoning":"STREAMED-REASONING","reasoning_details":[{"text":"STREAMED-REASONING"}]}}]}',
              '',
              'data: {"id":"g","choices":[{"delta":{"content":"Hi","reasoning_content":"STREAMED-REASONING"}}]}',
              '',
              'data: {"id":"g","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"edit","arguments":"{}"}}]}}]}',
              '',
              'data: {"id":"g","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"cost":0}}',
              '',
              'data: [DONE]',
              '',
              '',
            ].join('\n'),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      }).handleChatCompletions(
        createMockReq({ body: { model: OMNI, messages: [], stream: true } }),
        result.res,
      );
      const body = result.getBody();
      expect(body).not.toContain('STREAMED-REASONING');
      expect(body).not.toContain('reasoning');
      expect(body).toContain('data: {"id":"g","choices":[{"delta":{"content":"Hi"}}]}\n');
      expect(body).toContain('"name":"edit"');
      expect(body).toContain('data: [DONE]\n');
      const summary = await ledger.getSummary('r');
      expect(summary.totalPromptTokens).toBe(7);
      expect(summary.totalCompletionTokens).toBe(3);
    });
  });

  describe('content parts that could be billed (FC-M1)', () => {
    const gatewayWith = (fetchImpl: typeof fetch) =>
      new JoyModelGateway({
        mediaAuth: { authenticate: async () => ({ id: 'parts' }) } as unknown as MediaAuthService,
        account: {
          getSubscription: async () => ({
            ownerId: 'parts',
            plan: 'monthly',
            status: 'active',
            updatedAt: 0,
          }),
        } as unknown as AccountService,
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl,
      });
    const ok = () => new Response(JSON.stringify({ choices: [], usage: {} }), { status: 200 });

    it.each([
      [
        'file',
        {
          type: 'file',
          file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
        },
      ],
      ['input_audio', { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }],
      ['video_url', { type: 'video_url', video_url: { url: 'https://example.invalid/v.mp4' } }],
      ['unknown', { type: 'something-new', value: 1 }],
      ['untyped', { text: 'no type' }],
    ])('refuses a %s part with 400 and forwards nothing', async (_label, part) => {
      const fetchImpl = vi.fn(async () => ok());
      const result = createMockRes();
      await gatewayWith(fetchImpl as unknown as typeof fetch).handleChatCompletions(
        createMockReq({
          body: {
            model: 'google/gemma-4-31b-it:free',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'read this' }, part] }],
          },
        }),
        result.res,
      );
      expect(result.getStatus()).toBe(400);
      expect(result.getBody()).toContain('UNSUPPORTED_CONTENT_PART');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('sends images only to vision models and only as https or data:image URLs', async () => {
      const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => ok());
      const gateway = gatewayWith(fetchImpl as unknown as typeof fetch);
      const send = async (model: string, url: string) => {
        const result = createMockRes();
        await gateway.handleChatCompletions(
          createMockReq({
            body: {
              model,
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: 'look' },
                    { type: 'image_url', image_url: { url } },
                  ],
                },
              ],
            },
          }),
          result.res,
        );
        return result;
      };
      expect(
        (await send('google/gemma-4-31b-it:free', 'data:image/png;base64,AA==')).getStatus(),
      ).toBe(200);
      expect((await send(OMNI, 'https://example.invalid/a.png')).getStatus()).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      // An image sent to the text default is answered by the first vision model instead.
      const textDefault = await send(SUPER, 'data:image/png;base64,AA==');
      expect(textDefault.getStatus()).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body)).model).toBe(GEMMA);
      const pdfAsImage = await send(
        'google/gemma-4-31b-it:free',
        'data:application/pdf;base64,JVBERi0=',
      );
      expect(pdfAsImage.getStatus()).toBe(400);
      expect(pdfAsImage.getBody()).toContain('UNSUPPORTED_CONTENT_PART');
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('keeps plain text, tool and assistant messages working', async () => {
      const fetchImpl = vi.fn(async () => ok());
      const result = createMockRes();
      await gatewayWith(fetchImpl as unknown as typeof fetch).handleChatCompletions(
        createMockReq({
          body: {
            model: 'cohere/north-mini-code:free',
            messages: [
              { role: 'system', content: 'be brief' },
              { role: 'user', content: [{ type: 'text', text: 'hi' }] },
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } },
                ],
              },
              { role: 'tool', tool_call_id: 't1', content: '{"ok":true}' },
            ],
          },
        }),
        result.res,
      );
      expect(result.getStatus()).toBe(200);
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('logs loudly when a free model response reports a cost', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const billed = gatewayWith(
          (async () =>
            new Response(JSON.stringify({ choices: [], usage: { cost: 0.0123 } }), {
              status: 200,
            })) as unknown as typeof fetch,
        );
        await billed.handleChatCompletions(
          createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
          createMockRes().res,
        );
        expect(errors).toHaveBeenCalledWith(
          'joy-model-gateway: PAID SPEND REPORTED FOR A FREE MODEL',
          expect.objectContaining({ modelId: 'google/gemma-4-31b-it:free', costUsd: 0.0123 }),
        );
        errors.mockClear();
        const streamed = gatewayWith(
          (async () =>
            new Response(
              'data: {"id":"g","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.5}}\n\ndata: [DONE]\n\n',
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            )) as unknown as typeof fetch,
        );
        await streamed.handleChatCompletions(
          createMockReq({
            body: { model: 'google/gemma-4-31b-it:free', messages: [], stream: true },
          }),
          createMockRes().res,
        );
        expect(errors).toHaveBeenCalledWith(
          'joy-model-gateway: PAID SPEND REPORTED FOR A FREE MODEL',
          expect.objectContaining({ costUsd: 0.5 }),
        );
        errors.mockClear();
        const free = gatewayWith(
          (async () =>
            new Response(JSON.stringify({ choices: [], usage: { cost: 0 } }), {
              status: 200,
            })) as unknown as typeof fetch,
        );
        await free.handleChatCompletions(
          createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
          createMockRes().res,
        );
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });
  });

  it('rejects non-function tool types before forwarding a chat completion', async () => {
    let forwarded = false;
    const ledger = new MemoryAgentUsageLedger();
    const gateway = new JoyModelGateway({
      mediaAuth: { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'u',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger,
      openRouterApiKey: 'test-key',
      fetchImpl: async () => {
        forwarded = true;
        return new Response('{}', { status: 200 });
      },
    });
    const { res, getStatus, getBody } = createMockRes();

    await gateway.handleChatCompletions(
      createMockReq({
        body: {
          model: 'google/gemma-4-31b-it:free',
          messages: [],
          tools: [{ type: 'computer', name: 'browser' }],
        },
      }),
      res,
    );

    expect(getStatus()).toBe(400);
    expect(JSON.parse(getBody()).error).toMatchObject({
      code: 'UNSUPPORTED_TOOL_TYPE',
      message: expect.stringContaining('function'),
    });
    expect(forwarded).toBe(false);
    expect((await ledger.getSummary('u')).totalRequests).toBe(0);
  });

  it('defaults absent or invalid output limits to 8192 tokens', async () => {
    const forwarded: Array<Record<string, unknown>> = [];
    const gateway = new JoyModelGateway({
      mediaAuth: { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'u',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
      fetchImpl: async (_url, init) => {
        forwarded.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ choices: [], usage: {} }), { status: 200 });
      },
    });
    for (const fields of [
      {},
      { max_tokens: 0 },
      { max_tokens: 1.5 },
      { max_completion_tokens: -2 },
    ]) {
      await gateway.handleChatCompletions(
        createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [], ...fields } }),
        createMockRes().res,
      );
    }
    expect(forwarded).toHaveLength(4);
    expect(forwarded.every((body) => body.max_tokens === 8192)).toBe(true);
    expect(forwarded.every((body) => !Object.hasOwn(body, 'max_completion_tokens'))).toBe(true);
  });

  it.each(['true', 1])('normalizes client stream value %s to boolean false', async (stream) => {
    let forwardedBody: Record<string, unknown> | undefined;
    const gateway = new JoyModelGateway({
      mediaAuth: { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'u',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
      fetchImpl: async (_url, init) => {
        forwardedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [], usage: {} }), { status: 200 });
      },
    });
    await gateway.handleChatCompletions(
      createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [], stream } }),
      createMockRes().res,
    );
    expect(forwardedBody?.stream).toBe(false);
  });

  it('returns a safe upstream error and records usage when the upstream body is not JSON', async () => {
    const ledger = new MemoryAgentUsageLedger();
    const gateway = new JoyModelGateway({
      mediaAuth: { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'u',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger,
      openRouterApiKey: 'test-key',
      fetchImpl: async () => new Response('private-upstream-body', { status: 200 }),
    });
    const response = createMockRes();
    await gateway.handleChatCompletions(
      createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
      response.res,
    );
    expect(response.getStatus()).toBe(502);
    expect(response.getBody()).toContain('UPSTREAM_ERROR');
    expect(response.getBody()).not.toContain('private-upstream-body');
    expect((await ledger.getSummary('u')).totalRequests).toBe(1);
  });

  it('records OpenRouter usage.cost for non-streaming responses', async () => {
    const ledger = new MemoryAgentUsageLedger();
    const gateway = new JoyModelGateway({
      mediaAuth: { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'u',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger,
      openRouterApiKey: 'test-key',
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [], usage: { cost: 0.003 } }), { status: 200 }),
    });
    await gateway.handleChatCompletions(
      createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
      createMockRes().res,
    );
    expect((await ledger.getSummary('u')).totalUpstreamCostMicros).toBe('3000');
  });

  it('enforces the per-user request limit with a 429 and Retry-After', async () => {
    vi.stubEnv('JOY_GATEWAY_RATE_LIMIT_PER_MIN', '1');
    vi.stubEnv('JOY_GATEWAY_DAILY_SPEND_CAP_USD', '5');
    try {
      let forwarded = 0;
      const gateway = new JoyModelGateway({
        mediaAuth: {
          authenticate: async () => ({ id: 'rate-user' }),
        } as unknown as MediaAuthService,
        account: {
          getSubscription: async () => ({
            ownerId: 'rate-user',
            plan: 'monthly',
            status: 'active',
            updatedAt: 0,
          }),
        } as unknown as AccountService,
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl: async () => {
          forwarded += 1;
          return new Response(
            JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 },
            }),
            { status: 200 },
          );
        },
      });
      await gateway.handleChatCompletions(
        createMockReq({
          body: { model: 'google/gemma-4-31b-it:free', messages: [], max_tokens: 1 },
        }),
        createMockRes().res,
      );
      const limited = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
        limited.res,
      );
      expect(limited.getStatus()).toBe(429);
      expect(limited.getBody()).toContain('RATE_LIMITED');
      expect(Number(limited.getHeaders()['retry-after'])).toBeGreaterThan(0);
      expect(forwarded).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('enforces the per-user daily billed spend cap', async () => {
    vi.stubEnv('JOY_GATEWAY_RATE_LIMIT_PER_MIN', '100');
    vi.stubEnv('JOY_GATEWAY_DAILY_SPEND_CAP_USD', '0.000003');
    try {
      const gateway = new JoyModelGateway({
        mediaAuth: {
          authenticate: async () => ({ id: 'spend-user' }),
        } as unknown as MediaAuthService,
        account: {
          getSubscription: async () => ({
            ownerId: 'spend-user',
            plan: 'monthly',
            status: 'active',
            updatedAt: 0,
          }),
        } as unknown as AccountService,
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 },
            }),
            { status: 200 },
          ),
      });
      await gateway.handleChatCompletions(
        createMockReq({
          body: { model: 'google/gemma-4-31b-it:free', messages: [], max_tokens: 1 },
        }),
        createMockRes().res,
      );
      const limited = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
        limited.res,
      );
      expect(limited.getStatus()).toBe(429);
      expect(limited.getBody()).toContain('DAILY_SPEND_CAP_REACHED');
      expect(limited.getHeaders()['retry-after']).toBe('3600');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('still enforces the daily cap from reported spend, though free models estimate zero', async () => {
    vi.stubEnv('JOY_GATEWAY_DAILY_SPEND_CAP_USD', '0.03');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let forwarded = 0;
    const gateway = new JoyModelGateway({
      mediaAuth: {
        authenticate: async () => ({ id: 'reported-spend-user' }),
      } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'reported-spend-user',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
      fetchImpl: async () => {
        forwarded += 1;
        return new Response(
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.04 },
          }),
          { status: 200 },
        );
      },
    });
    try {
      const request = () =>
        createMockReq({
          body: { model: 'google/gemma-4-31b-it:free', messages: [], max_tokens: 8192 },
        });
      const first = createMockRes();
      await gateway.handleChatCompletions(request(), first.res);
      expect(first.getStatus()).toBe(200);
      const second = createMockRes();
      await gateway.handleChatCompletions(request(), second.res);
      expect(second.getStatus()).toBe(429);
      expect(second.getBody()).toContain('DAILY_SPEND_CAP_REACHED');
      expect(forwarded).toBe(1);
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('fails closed with 503 when a spend reservation cannot be written', async () => {
    const fetchImpl = vi.fn();
    const gateway = new JoyModelGateway({
      mediaAuth: {
        authenticate: async () => ({ id: 'ledger-failure-user' }),
      } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'ledger-failure-user',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger: {
        reserveSpend: async () => {
          throw new Error('db unavailable');
        },
      } as unknown as MemoryAgentUsageLedger,
      openRouterApiKey: 'test-key',
      fetchImpl,
    });
    const response = createMockRes();
    await gateway.handleChatCompletions(
      createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
      response.res,
    );
    expect(response.getStatus()).toBe(503);
    expect(response.getBody()).toContain('SPEND_LEDGER_UNAVAILABLE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 503 SPEND_LEDGER_BUSY for a Postgres advisory lock timeout', async () => {
    const gateway = new JoyModelGateway({
      mediaAuth: {
        authenticate: async () => ({ id: 'busy-owner' }),
      } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'busy-owner',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger: {
        reserveSpend: async () => {
          throw new Error('SPEND_LEDGER_BUSY');
        },
        getSummary: async () => ({}),
        getDailyBilledCostMicros: async () => 0n,
        record: async () => 'record',
        settleSpend: async () => 'record',
        releaseSpend: async () => undefined,
      } as unknown as AgentUsageLedger,
      openRouterApiKey: 'test-key',
      fetchImpl: vi.fn(),
    });
    const result = createMockRes();
    await gateway.handleChatCompletions(
      createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
      result.res,
    );
    expect(result.getStatus()).toBe(503);
    expect(result.getBody()).toContain('SPEND_LEDGER_BUSY');
  });

  it('sends SSE keep-alive comments while the upstream stream is waiting', async () => {
    vi.useFakeTimers();
    try {
      // The first event commits the response; then the upstream goes quiet.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"id":"g","choices":[{"delta":{"content":""}}]}\n\n'),
          );
        },
      });
      const gateway = new JoyModelGateway({
        mediaAuth: {
          authenticate: async () => ({ id: 'keepalive-user' }),
        } as unknown as MediaAuthService,
        account: {
          getSubscription: async () => ({
            ownerId: 'keepalive-user',
            plan: 'monthly',
            status: 'active',
            updatedAt: 0,
          }),
        } as unknown as AccountService,
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl: async () => new Response(stream, { status: 200 }),
      });
      const response = createMockRes();
      const pending = gateway.handleChatCompletions(
        createMockReq({
          body: { model: 'google/gemma-4-31b-it:free', stream: true, messages: [] },
        }),
        response.res,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(response.getBody()).toContain(': keep-alive\n\n');
      response.close();
      await vi.advanceTimersByTimeAsync(60_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rewrites installed legacy model ids to the free default before forwarding', async () => {
    const mockAuth = {
      authenticate: async () => ({ id: 'user-pro' }),
    } as unknown as MediaAuthService;
    const mockAccount = {
      getSubscription: async (): Promise<Subscription> => ({
        ownerId: 'user-pro',
        plan: 'monthly',
        status: 'active',
        updatedAt: Date.now(),
      }),
    } as unknown as AccountService;
    let forwardedModel: unknown;
    const gateway = new JoyModelGateway({
      mediaAuth: mockAuth,
      account: mockAccount,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'sk-test-REDACTED-0000',
      fetchImpl: async (_url, init) => {
        forwardedModel = JSON.parse(String(init?.body)).model;
        return new Response(JSON.stringify({ choices: [], usage: {} }), { status: 200 });
      },
    });
    const { res } = createMockRes();
    await gateway.handleChatCompletions(
      createMockReq({ body: { model: 'minimax/minimax-m3', messages: [] } }),
      res,
    );
    expect(forwardedModel).toBe(SUPER);
  });

  it('aliases the removed llama 3.3 model to the free default, not a paid model', async () => {
    let forwardedModel: unknown;
    const gateway = new JoyModelGateway({
      mediaAuth: { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'u',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
      fetchImpl: async (_url, init) => {
        forwardedModel = JSON.parse(String(init?.body)).model;
        return new Response(JSON.stringify({ choices: [], usage: {} }), { status: 200 });
      },
    });
    await gateway.handleChatCompletions(
      createMockReq({ body: { model: 'meta-llama/llama-3.3-70b-instruct', messages: [] } }),
      createMockRes().res,
    );
    expect(forwardedModel).toBe(SUPER);
  });

  it('maps upstream authentication failures without forwarding their body or status', async () => {
    const gateway = new JoyModelGateway({
      mediaAuth: { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'u',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'sk-test-REDACTED-0000',
      fetchImpl: async () =>
        new Response('upstream-body-sentinel sk-test-REDACTED-0000', { status: 401 }),
    });
    const { res, getStatus, getBody } = createMockRes();
    await gateway.handleChatCompletions(
      createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
      res,
    );
    expect(getStatus()).toBe(503);
    expect(getBody()).toContain('JOY_AGENT_UPSTREAM_AUTH_FAILED');
    expect(getBody()).not.toContain('sk-test-REDACTED-0000');
    expect(getBody()).not.toContain('upstream-body-sentinel');
  });

  it('reads and trims the current systemd credential id before the legacy id', () => {
    const visited: string[] = [];
    const key = readOpenRouterApiKeyFromCredential((path) => {
      visited.push(path);
      if (path.endsWith('/openrouter-api-key')) return '  safe-test-value\n';
      throw new Error('missing');
    }, '/credential-dir');
    expect(OPENROUTER_SYSTEMD_CREDENTIAL_IDS).toEqual([
      'openrouter-api-key',
      'joy-media-openrouter-api-key',
    ]);
    expect(key).toBe('safe-test-value');
    expect(visited).toEqual(['/credential-dir/openrouter-api-key']);
    expect(readOpenRouterApiKeyFromCredential(() => '  \n', '/credential-dir')).toBeUndefined();
  });

  it('falls back to the deprecated systemd credential id', () => {
    const key = readOpenRouterApiKeyFromCredential((path) => {
      if (path.endsWith('/joy-media-openrouter-api-key')) return 'legacy-credential-test';
      throw new Error('missing');
    }, '/credential-dir');
    expect(key).toBe('legacy-credential-test');
  });

  it('uses CREDENTIALS_DIRECTORY when no explicit credential directory is passed', () => {
    vi.stubEnv('CREDENTIALS_DIRECTORY', '/systemd/credentials');
    try {
      expect(
        readOpenRouterApiKeyFromCredential((path) => {
          if (path === '/systemd/credentials/openrouter-api-key') return 'credential-test';
          throw new Error('not found');
        }),
      ).toBe('credential-test');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('maps exhausted 429, 404 and 5xx answers to a bounded, retryable JOY_AGENT_MODELS_BUSY', async () => {
    const auth = { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService;
    const account = {
      getSubscription: async () => ({
        ownerId: 'u',
        plan: 'monthly',
        status: 'active',
        updatedAt: 0,
      }),
    } as unknown as AccountService;
    for (const [upstreamStatus, expectedStatus, expectedCode] of [
      [404, 503, 'JOY_AGENT_MODELS_BUSY'],
      [429, 503, 'JOY_AGENT_MODELS_BUSY'],
      [500, 503, 'JOY_AGENT_MODELS_BUSY'],
      [400, 502, 'UPSTREAM_ERROR'],
    ] as const) {
      const gateway = new JoyModelGateway({
        mediaAuth: auth,
        account,
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'sk-test-REDACTED-0000',
        fetchImpl: async () =>
          new Response('untrusted provider body', {
            status: upstreamStatus,
            ...(upstreamStatus === 429 ? { headers: { 'retry-after': '17' } } : {}),
          }),
      });
      const response = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
        response.res,
      );
      expect(response.getStatus()).toBe(expectedStatus);
      expect(response.getBody()).toContain(expectedCode);
      expect(response.getBody()).not.toContain('untrusted provider body');
      expect(response.getHeaders()['retry-after']).toBe(
        upstreamStatus === 429 ? '17' : upstreamStatus === 400 ? undefined : '30',
      );
    }
  });

  it('maps upstream timeout and network failures without exposing exception text', async () => {
    const auth = { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService;
    const account = {
      getSubscription: async () => ({
        ownerId: 'u',
        plan: 'monthly',
        status: 'active',
        updatedAt: 0,
      }),
    } as unknown as AccountService;
    for (const [error, expectedStatus, expectedCode] of [
      [
        Object.assign(new Error('timeout-body-sentinel'), { name: 'TimeoutError' }),
        504,
        'UPSTREAM_TIMEOUT',
      ],
      [new TypeError('network-body-sentinel'), 502, 'UPSTREAM_UNREACHABLE'],
    ] as const) {
      const gateway = new JoyModelGateway({
        mediaAuth: auth,
        account,
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl: async () => {
          throw error;
        },
      });
      const response = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
        response.res,
      );
      expect(response.getStatus()).toBe(expectedStatus);
      expect(response.getBody()).toContain(expectedCode);
      expect(response.getBody()).not.toContain('body-sentinel');
    }
  });

  it('counts usage from an SSE usage frame split across chunks', async () => {
    const ledger = new MemoryAgentUsageLedger();
    let forwardedStream: unknown;
    const auth = { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService;
    const account = {
      getSubscription: async () => ({
        ownerId: 'u',
        plan: 'monthly',
        status: 'active',
        updatedAt: 0,
      }),
    } as unknown as AccountService;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"usage":{"prompt_t'));
        controller.enqueue(encoder.encode('okens":5,"completion_tokens":3,"cost":0.001}}\n\n'));
        controller.close();
      },
    });
    const gateway = new JoyModelGateway({
      mediaAuth: auth,
      account,
      ledger,
      openRouterApiKey: 'sk-test-REDACTED-0000',
      fetchImpl: async (_url, init) => {
        forwardedStream = (JSON.parse(String(init?.body)) as Record<string, unknown>).stream;
        return new Response(stream, { status: 200 });
      },
    });
    const response = createMockRes();
    await gateway.handleChatCompletions(
      createMockReq({
        body: { model: 'google/gemma-4-31b-it:free', stream: true, messages: [] },
      }),
      response.res,
    );
    const summary = await ledger.getSummary('u');
    expect(summary.totalPromptTokens).toBe(5);
    expect(summary.totalCompletionTokens).toBe(3);
    expect(summary.totalUpstreamCostMicros).toBe('1000');
    expect(forwardedStream).toBe(true);
    expect(response.getHeaders()['x-accel-buffering']).toBe('no');
  });

  it('preserves reported stream token counts when cost must be estimated', async () => {
    const ledger = new MemoryAgentUsageLedger();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"usage":{"prompt_tokens":8,"completion_tokens":6}}\n\n'),
        );
        controller.close();
      },
    });
    const gateway = new JoyModelGateway({
      mediaAuth: {
        authenticate: async () => ({ id: 'token-cost-user' }),
      } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'token-cost-user',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger,
      openRouterApiKey: 'test-key',
      fetchImpl: async () => new Response(stream, { status: 200 }),
    });
    await gateway.handleChatCompletions(
      createMockReq({
        body: { model: 'google/gemma-4-31b-it:free', stream: true, messages: [] },
      }),
      createMockRes().res,
    );
    const summary = await ledger.getSummary('token-cost-user');
    expect(summary.totalPromptTokens).toBe(8);
    expect(summary.totalCompletionTokens).toBe(6);
    // Every catalog model is free, so an estimated cost is zero.
    expect(BigInt(summary.totalUpstreamCostMicros)).toBe(0n);
  });

  it('retries delayed generation usage lookups without delaying the response', async () => {
    vi.useFakeTimers();
    try {
      const ledger = new MemoryAgentUsageLedger();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'generation-late',
              choices: [],
              usage: { prompt_tokens: 3, completion_tokens: 2 },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 404 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ data: { tokens_prompt: 9, tokens_completion: 4, total_cost: 0.002 } }),
            { status: 200 },
          ),
        );
      const gateway = new JoyModelGateway({
        mediaAuth: {
          authenticate: async () => ({ id: 'generation-retry-user' }),
        } as unknown as MediaAuthService,
        account: {
          getSubscription: async () => ({
            ownerId: 'generation-retry-user',
            plan: 'monthly',
            status: 'active',
            updatedAt: 0,
          }),
        } as unknown as AccountService,
        ledger,
        openRouterApiKey: 'test-key',
        fetchImpl,
      });
      const response = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
        response.res,
      );
      expect(response.getStatus()).toBe(200);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      const summary = await ledger.getSummary('generation-retry-user');
      expect(summary.totalPromptTokens).toBe(9);
      expect(summary.totalCompletionTokens).toBe(4);
      expect(summary.totalUpstreamCostMicros).toBe('2000');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends an idle stream cleanly after recording usage already received', async () => {
    vi.useFakeTimers();
    try {
      const ledger = new MemoryAgentUsageLedger();
      const signalRef: { signal?: AbortSignal } = {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"usage":{"prompt_tokens":2,"cost":0.004}}\n\n'),
          );
        },
      });
      const gateway = new JoyModelGateway({
        mediaAuth: { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService,
        account: {
          getSubscription: async () => ({
            ownerId: 'u',
            plan: 'monthly',
            status: 'active',
            updatedAt: 0,
          }),
        } as unknown as AccountService,
        ledger,
        openRouterApiKey: 'test-key',
        fetchImpl: async (_url, init) => {
          signalRef.signal = init?.signal as AbortSignal;
          return new Response(stream, { status: 200 });
        },
      });
      const response = createMockRes();
      const operation = gateway.handleChatCompletions(
        createMockReq({
          body: { model: 'google/gemma-4-31b-it:free', stream: true, messages: [] },
        }),
        response.res,
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60_000);
      await operation;
      expect(response.getStatus()).toBe(200);
      expect(response.getBody()).toContain('prompt_tokens');
      expect(signalRef.signal?.aborted).toBe(false);
      expect((await ledger.getSummary('u')).totalPromptTokens).toBe(2);
      expect((await ledger.getSummary('u')).totalUpstreamCostMicros).toBe('4000');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the upstream header timeout after fetch resolves', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const gateway = new JoyModelGateway({
        mediaAuth: { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService,
        account: {
          getSubscription: async () => ({
            ownerId: 'u',
            plan: 'monthly',
            status: 'active',
            updatedAt: 0,
          }),
        } as unknown as AccountService,
        ledger: new MemoryAgentUsageLedger(),
        openRouterApiKey: 'test-key',
        fetchImpl: async (_url, init) => {
          signal = init?.signal as AbortSignal;
          return new Response(JSON.stringify({ choices: [], usage: {} }), { status: 200 });
        },
      });
      await gateway.handleChatCompletions(
        createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
        createMockRes().res,
      );
      await vi.advanceTimersByTimeAsync(120_000);
      expect(signal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a complete usage frame before ending a stream that errors', async () => {
    const ledger = new MemoryAgentUsageLedger();
    let sentChunk = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentChunk) {
          sentChunk = true;
          controller.enqueue(
            new TextEncoder().encode('data: {"usage":{"prompt_tokens":4,"cost":0.006}}'),
          );
          return;
        }
        controller.error(new Error('stream reset'));
      },
    });
    const gateway = new JoyModelGateway({
      mediaAuth: { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'u',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger,
      openRouterApiKey: 'test-key',
      fetchImpl: async () => new Response(stream, { status: 200 }),
    });
    const response = createMockRes();
    await expect(
      gateway.handleChatCompletions(
        createMockReq({
          body: { model: 'google/gemma-4-31b-it:free', stream: true, messages: [] },
        }),
        response.res,
      ),
    ).resolves.toBeUndefined();
    expect(response.getStatus()).toBe(200);
    expect((await ledger.getSummary('u')).totalPromptTokens).toBe(4);
    expect((await ledger.getSummary('u')).totalUpstreamCostMicros).toBe('6000');
  });

  it('estimates missing streaming usage and records an estimated ledger entry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ledger = new MemoryAgentUsageLedger();
    const gateway = new JoyModelGateway({
      mediaAuth: { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'u',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger,
      openRouterApiKey: 'sk-test-REDACTED-0000',
      fetchImpl: async () => new Response('data: {"choices":[]}\n\n', { status: 200 }),
    });
    const response = createMockRes();
    await expect(
      gateway.handleChatCompletions(
        createMockReq({
          body: { model: 'google/gemma-4-31b-it:free', stream: true, messages: [] },
        }),
        response.res,
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'joy-model-gateway: stream usage unavailable',
      expect.objectContaining({ usageReported: false }),
    );
    expect((await ledger.getSummary('u')).totalRequests).toBe(1);
    warn.mockRestore();
    error.mockRestore();
  });

  it('estimates streamed tool-call names and arguments as completion text', async () => {
    const toolCallText = 'update_timeline{"clipId":"clip-1","startUs":1250000}';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: 'update_timeline', arguments: '{"clipId":"clip-1","startUs":1250000}' } }] } }] })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    const ledger = new MemoryAgentUsageLedger();
    const gateway = new JoyModelGateway({
      mediaAuth: {
        authenticate: async () => ({ id: 'stream-tool-estimate' }),
      } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'stream-tool-estimate',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger,
      openRouterApiKey: 'test-key',
      fetchImpl: async () => new Response(stream, { status: 200 }),
    });
    await gateway.handleChatCompletions(
      createMockReq({
        body: { model: 'google/gemma-4-31b-it:free', stream: true, messages: [] },
      }),
      createMockRes().res,
    );
    expect((await ledger.getSummary('stream-tool-estimate')).totalCompletionTokens).toBe(
      Math.ceil(toolCallText.length / 4),
    );
  });

  it('estimates non-streamed tool-call names and arguments as completion text', async () => {
    const toolCallText = 'update_timeline {"clipId":"clip-1","startUs":1250000}';
    const ledger = new MemoryAgentUsageLedger();
    const gateway = new JoyModelGateway({
      mediaAuth: {
        authenticate: async () => ({ id: 'completion-tool-estimate' }),
      } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'completion-tool-estimate',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger,
      openRouterApiKey: 'test-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      function: {
                        name: 'update_timeline',
                        arguments: '{"clipId":"clip-1","startUs":1250000}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });
    await gateway.handleChatCompletions(
      createMockReq({ body: { model: 'google/gemma-4-31b-it:free', messages: [] } }),
      createMockRes().res,
    );
    expect((await ledger.getSummary('completion-tool-estimate')).totalCompletionTokens).toBe(
      Math.ceil(toolCallText.length / 4),
    );
  });

  it('estimates assistant tool calls, tool replies, and tool definitions as prompt text', async () => {
    const toolCallText = 'lookup_asset {"assetId":"asset-1"}';
    const toolReply = 'asset metadata';
    const messages = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        tool_calls: [{ function: { name: 'lookup_asset', arguments: '{"assetId":"asset-1"}' } }],
      },
      { role: 'tool', content: toolReply },
    ];
    const tools = [
      {
        type: 'function',
        function: {
          name: 'lookup_asset',
          description: 'Find a project asset by id',
          parameters: { type: 'object', properties: { assetId: { type: 'string' } } },
        },
      },
    ];
    const ledger = new MemoryAgentUsageLedger();
    const gateway = new JoyModelGateway({
      mediaAuth: {
        authenticate: async () => ({ id: 'prompt-tool-estimate' }),
      } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'prompt-tool-estimate',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger,
      openRouterApiKey: 'test-key',
      fetchImpl: async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    });
    await gateway.handleChatCompletions(
      createMockReq({
        body: { model: 'google/gemma-4-31b-it:free', messages, tools },
      }),
      createMockRes().res,
    );
    const expectedPrompt = `go ${toolCallText} ${toolReply} ${JSON.stringify(tools)}`;
    expect((await ledger.getSummary('prompt-tool-estimate')).totalPromptTokens).toBe(
      Math.ceil(expectedPrompt.length / 4),
    );
  });

  it('returns 413 for a request body larger than 2 MiB', async () => {
    const gateway = new JoyModelGateway({
      mediaAuth: { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'u',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
      fetchImpl: vi.fn(),
    });
    const response = createMockRes();
    await gateway.handleChatCompletions(
      createMockReq({ body: 'x'.repeat(3 * 1024 * 1024) }),
      response.res,
    );
    expect(response.getStatus()).toBe(413);
    expect(response.getBody()).toContain('PAYLOAD_TOO_LARGE');
  });

  it('cancels the upstream reader when the response client closes early', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"id":"generation-cancel","choices":[{"delta":{"content":"Partial response"}}]}\n\n',
          ),
        );
      },
      cancel() {
        canceled = true;
      },
    });
    const ledger = new MemoryAgentUsageLedger();
    const gateway = new JoyModelGateway({
      mediaAuth: { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'u',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger,
      openRouterApiKey: 'test-key',
      fetchImpl: async () => new Response(stream, { status: 200 }),
    });
    const response = createMockRes();
    const operation = gateway.handleChatCompletions(
      createMockReq({
        body: { model: 'google/gemma-4-31b-it:free', stream: true, messages: [] },
      }),
      response.res,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    response.close();
    await operation;
    expect(canceled).toBe(true);
    expect((await ledger.getSummary('u')).totalCompletionTokens).toBe(4);
  });
});
