import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  JoyModelGateway,
  JOY_AGENT_DEFAULT_MODELS,
  OPENROUTER_SYSTEMD_CREDENTIAL_IDS,
  readOpenRouterApiKeyFromCredential,
} from './joy-model-gateway.js';
import { MemoryAgentUsageLedger } from './agent-usage-ledger.js';
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

describe('JoyModelGateway', () => {
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
    expect(JSON.parse(getBody()).models).toHaveLength(JOY_AGENT_DEFAULT_MODELS.length);
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
    expect(data.models).toHaveLength(JOY_AGENT_DEFAULT_MODELS.length);
    expect(data.models[0]).toMatchObject({
      id: 'bytedance-seed/seed-2.0-lite',
      isDefault: true,
      vision: true,
    });
    expect(data.models.some((model: { id: string }) => model.id.includes('minimax'))).toBe(false);
    expect(data.models.some((model: { id: string }) => model.id.includes('claude-3.5'))).toBe(
      false,
    );
    expect(
      data.models.every(
        (model: { inputUsdPerMillion: number; outputUsdPerMillion: number }) =>
          model.inputUsdPerMillion > 0 && model.outputUsdPerMillion > 0,
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
    const req = createMockReq({ body: { model: 'bytedance-seed/seed-2.0-lite', messages: [] } });
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
    const req = createMockReq({ body: { model: 'bytedance-seed/seed-2.0-lite', messages: [] } });
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
    const req = createMockReq({ body: { model: 'bytedance-seed/seed-2.0-lite', messages: [] } });
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
        model: 'bytedance-seed/seed-2.0-lite',
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
          model: 'bytedance-seed/seed-2.0-lite',
          ...allowedFields,
          models: ['not-in-catalog/model'],
          provider: { order: ['untrusted-provider'] },
          plugins: [{ id: 'web' }],
          route: 'fallback',
          transforms: ['middle-out'],
          arbitrary: 'drop-me',
        },
      }),
      createMockRes().res,
    );
    expect(forwardedBody).toMatchObject({
      model: 'bytedance-seed/seed-2.0-lite',
      ...allowedFields,
      max_tokens: 8192,
      max_completion_tokens: 8192,
      usage: { include: true },
    });
    expect(forwardedBody).not.toHaveProperty('models');
    expect(forwardedBody).not.toHaveProperty('provider');
    expect(forwardedBody).not.toHaveProperty('plugins');
    expect(forwardedBody).not.toHaveProperty('route');
    expect(forwardedBody).not.toHaveProperty('transforms');
    expect(forwardedBody).not.toHaveProperty('arbitrary');
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
          model: 'bytedance-seed/seed-2.0-lite',
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
        createMockReq({ body: { model: 'bytedance-seed/seed-2.0-lite', messages: [], ...fields } }),
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
      createMockReq({ body: { model: 'bytedance-seed/seed-2.0-lite', messages: [], stream } }),
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
      createMockReq({ body: { model: 'bytedance-seed/seed-2.0-lite', messages: [] } }),
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
      createMockReq({ body: { model: 'bytedance-seed/seed-2.0-lite', messages: [] } }),
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
          body: { model: 'bytedance-seed/seed-2.0-lite', messages: [], max_tokens: 1 },
        }),
        createMockRes().res,
      );
      const limited = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({ body: { model: 'bytedance-seed/seed-2.0-lite', messages: [] } }),
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
          body: { model: 'bytedance-seed/seed-2.0-lite', messages: [], max_tokens: 1 },
        }),
        createMockRes().res,
      );
      const limited = createMockRes();
      await gateway.handleChatCompletions(
        createMockReq({ body: { model: 'bytedance-seed/seed-2.0-lite', messages: [] } }),
        limited.res,
      );
      expect(limited.getStatus()).toBe(429);
      expect(limited.getBody()).toContain('DAILY_SPEND_CAP_REACHED');
      expect(limited.getHeaders()['retry-after']).toBe('3600');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reserves estimated spend atomically across parallel requests', async () => {
    vi.stubEnv('JOY_GATEWAY_RATE_LIMIT_PER_MIN', '100');
    vi.stubEnv('JOY_GATEWAY_DAILY_SPEND_CAP_USD', '0.03');
    let forwarded = 0;
    const gateway = new JoyModelGateway({
      mediaAuth: {
        authenticate: async () => ({ id: 'parallel-spend-user' }),
      } as unknown as MediaAuthService,
      account: {
        getSubscription: async () => ({
          ownerId: 'parallel-spend-user',
          plan: 'monthly',
          status: 'active',
          updatedAt: 0,
        }),
      } as unknown as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
      fetchImpl: async () => {
        forwarded += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 },
          }),
          { status: 200 },
        );
      },
    });
    try {
      const responses = Array.from({ length: 8 }, () => createMockRes());
      await Promise.all(
        responses.map(({ res }) =>
          gateway.handleChatCompletions(
            createMockReq({
              body: { model: 'bytedance-seed/seed-2.0-lite', messages: [], max_tokens: 8192 },
            }),
            res,
          ),
        ),
      );
      expect(forwarded).toBe(1);
      expect(responses.filter((response) => response.getStatus() === 429)).toHaveLength(7);
    } finally {
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
      createMockReq({ body: { model: 'bytedance-seed/seed-2.0-lite', messages: [] } }),
      response.res,
    );
    expect(response.getStatus()).toBe(503);
    expect(response.getBody()).toContain('SPEND_LEDGER_UNAVAILABLE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends SSE keep-alive comments while the upstream stream is waiting', async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<Uint8Array>({ start() {} });
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
          body: { model: 'bytedance-seed/seed-2.0-lite', stream: true, messages: [] },
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

  it('rewrites installed legacy model ids to their catalog replacements before forwarding', async () => {
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
    expect(forwardedModel).toBe('bytedance-seed/seed-2.0-lite');
  });

  it('aliases the removed llama 3.3 model to the current DeepSeek catalog model', async () => {
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
    expect(forwardedModel).toBe('deepseek/deepseek-v4-flash');
    expect(
      JOY_AGENT_DEFAULT_MODELS.some((model) => model.id === 'meta-llama/llama-3.3-70b-instruct'),
    ).toBe(false);
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
      createMockReq({ body: { model: 'bytedance-seed/seed-2.0-lite', messages: [] } }),
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

  it('maps upstream 429, 404, and other failures to bounded gateway errors', async () => {
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
      [404, 400, 'MODEL_UNAVAILABLE'],
      [429, 429, 'RATE_LIMITED'],
      [500, 502, 'UPSTREAM_ERROR'],
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
        createMockReq({ body: { model: 'bytedance-seed/seed-2.0-lite', messages: [] } }),
        response.res,
      );
      expect(response.getStatus()).toBe(expectedStatus);
      expect(response.getBody()).toContain(expectedCode);
      expect(response.getBody()).not.toContain('untrusted provider body');
      expect(response.getHeaders()['retry-after']).toBe(upstreamStatus === 429 ? '17' : undefined);
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
        createMockReq({ body: { model: 'bytedance-seed/seed-2.0-lite', messages: [] } }),
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
        body: { model: 'bytedance-seed/seed-2.0-lite', stream: true, messages: [] },
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
        body: { model: 'bytedance-seed/seed-2.0-lite', stream: true, messages: [] },
      }),
      createMockRes().res,
    );
    const summary = await ledger.getSummary('token-cost-user');
    expect(summary.totalPromptTokens).toBe(8);
    expect(summary.totalCompletionTokens).toBe(6);
    expect(BigInt(summary.totalUpstreamCostMicros)).toBeGreaterThan(0n);
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
        createMockReq({ body: { model: 'bytedance-seed/seed-2.0-lite', messages: [] } }),
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
          body: { model: 'bytedance-seed/seed-2.0-lite', stream: true, messages: [] },
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
        createMockReq({ body: { model: 'bytedance-seed/seed-2.0-lite', messages: [] } }),
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
          body: { model: 'bytedance-seed/seed-2.0-lite', stream: true, messages: [] },
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
          body: { model: 'bytedance-seed/seed-2.0-lite', stream: true, messages: [] },
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
        body: { model: 'bytedance-seed/seed-2.0-lite', stream: true, messages: [] },
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
